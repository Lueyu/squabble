/**
 * Auth service —— 一方账户体系的核心服务。
 *
 * 职责边界：账户创建、登录校验、token 签发/轮换、离线恢复码生命周期；
 * 注册开关（REGISTER_ENABLED=false 关闭 / 'first-user' 仅首个账户）在此
 * 判定。不管 HTTP 形态与限流（controller 层）。
 *
 * 上下游：import @nestjs/common 异常、bcryptjs、node:crypto、drizzle-orm、
 * DRIZZLE_DATABASE（common/platform/database.provider）、users 与
 * agentSessions（database/schema）、jwt.ts 的签发/校验函数、
 * @shared/api.interface 类型；由 auth.controller.ts 调用。
 *
 * 关键约定（安全敏感，勿改语义）：
 *  - 隐私边界（见 docs/privacy.md）：账户只是 用户名 + bcrypt 密码哈希；
 *    无手机号、无邮箱验证，emailNotify 是可选自由文本，永不强制校验；
 *  - 密码哈希 v2 方案（PASSWORD_HASH_VERSION='v2$'）：先 sha256(password)
 *    再 bcrypt(cost 10)——规避 bcrypt 72 字节截断；旧格式（无前缀）走
 *    bcrypt 原文比较以兼容存量账户；
 *  - 用户名规则：2-32 个 [a-zA-Z0-9_.-]，统一 trim+lowercase 后校验/入库；
 *    密码 12-128 字符；
 *  - 恢复码为 randomBytes(24) 的 48 位 hex，库中只存 sha256(小写码)；
 *  - 'first-user' 注册在事务内用 pg_advisory_xact_lock 串行化唯一名额；
 *  - 会话吊销：恢复/轮换恢复码都会 sessionVersion+1，旧 token 立即失效；
 *    恢复密码还会把该用户全部 agentSessions 置为 revoked；
 *  - 更新采用乐观条件（where 带旧 sessionVersion/recoveryCodeHash），
 *    0 行返回即视为竞争失败并抛 401。
 */
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import bcrypt from 'bcryptjs';
import { createHash, randomBytes } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '../../common/platform/database.provider';
import { agentSessions, users } from '../../database/schema';
import { signAccessToken, signRefreshToken, verifyRefreshToken } from './jwt';
import type { RegistrationStatus } from '@shared/api.interface';

/** register/login/refresh 的统一返回形状。 */
export interface AuthResult {
  user: { id: string; username: string; displayName: string | null };
  accessToken: string;
  refreshToken: string;
  recoveryCode?: string;
}

/** 恢复码哈希：统一小写后 sha256，避免大小写差异绕过比对。 */
function recoveryHash(code: string): string {
  return createHash('sha256').update(code.toLowerCase()).digest('hex');
}

/** 用户名规则：2-32 个字母/数字/._- */
const USERNAME_PATTERN = /^[a-zA-Z0-9_.-]{2,32}$/;

/** 归一化并校验用户名（trim + lowercase + 模式匹配），不合法抛 400。 */
function normalizeUsername(raw: string): string {
  const username = (raw ?? '').trim().toLowerCase();
  if (!USERNAME_PATTERN.test(username)) {
    throw new BadRequestException('Username must be 2-32 letters, digits, or . _ -');
  }
  return username;
}

/** 校验密码长度：12-128 字符。 */
function validatePassword(raw: string): void {
  if (typeof raw !== 'string' || raw.length < 12 || raw.length > 128) {
    throw new BadRequestException('Password must be 12-128 characters');
  }
}

/** 当前密码哈希格式版本前缀：v2 = sha256 预哈希 + bcrypt。 */
const PASSWORD_HASH_VERSION = 'v2$';

/** v2 哈希：先 sha256(password)（规避 bcrypt 72 字节截断），再 bcrypt(cost 10)。 */
async function hashPassword(password: string): Promise<string> {
  const digest = createHash('sha256').update(password, 'utf8').digest('hex');
  return PASSWORD_HASH_VERSION + (await bcrypt.hash(digest, 10));
}

/**
 * 密码比对：v2 格式（带前缀）对 sha256 摘要比对；旧格式（无前缀）按
 * 原文 bcrypt 比对，兼容存量账户。
 */
async function comparePassword(password: string, stored: string): Promise<boolean> {
  if (stored.startsWith(PASSWORD_HASH_VERSION)) {
    const digest = createHash('sha256').update(password, 'utf8').digest('hex');
    return bcrypt.compare(digest, stored.slice(PASSWORD_HASH_VERSION.length));
  }
  return bcrypt.compare(password, stored);
}

@Injectable()
export class AuthService {
  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase) {}

  /** 登录/注册页使用的公开注册开放状态。 */
  async getRegistrationStatus(): Promise<RegistrationStatus> {
    const mode = process.env.REGISTER_ENABLED;
    if (mode === 'false') return { registrationOpen: false };
    if (mode !== 'first-user') return { registrationOpen: true };
    // first-user 模式：库里还没有任何账户才开放。
    const [existing] = await this.db.select({ id: users.id }).from(users).limit(1);
    return { registrationOpen: !existing };
  }

  /** 创建账户并签发 token。first-user 模式下把唯一名额串行化。 */
  async register(input: {
    username: string;
    password: string;
    displayName?: string;
  }): Promise<AuthResult> {
    // 注册开关：显式 false 直接拒绝。
    const mode = process.env.REGISTER_ENABLED;
    if (mode === 'false') {
      throw new BadRequestException('Registration is disabled on this instance');
    }
    const username = normalizeUsername(input.username);
    validatePassword(input.password);

    if (mode !== 'first-user') {
      // 开放注册：先查重用户名（first-user 模式由事务内加锁后复查）。
      const [existing] = await this.db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.username, username));
      if (existing) {
        throw new ConflictException('Username is already taken');
      }
    }

    // 生成密码哈希与一次性离线恢复码（48 位 hex）。
    const passwordHash = await hashPassword(input.password);
    const recoveryCode = randomBytes(24).toString('hex');
    const values = {
      username,
      passwordHash,
      recoveryCodeHash: recoveryHash(recoveryCode),
      displayName: input.displayName?.trim() || username,
    };
    const selection = {
      id: users.id,
      username: users.username,
      displayName: users.displayName,
      sessionVersion: users.sessionVersion,
    };
    const created =
      mode === 'first-user'
        ? await this.db.transaction(async (tx) => {
            // 唯一名额串行化：advisory 锁内复查"是否已有账户"，防止并发
            // 注册越过首用户限制。
            await tx.execute(
              sql`SELECT pg_advisory_xact_lock(hashtext('squabble-first-user-registration'))`,
            );
            const [existing] = await tx.select({ id: users.id }).from(users).limit(1);
            if (existing)
              throw new BadRequestException('Registration is closed after the first account');
            const [user] = await tx.insert(users).values(values).returning(selection);
            return user;
          })
        : (await this.db.insert(users).values(values).returning(selection))[0];

    // 恢复码只在此刻明文返回一次，库里只存哈希。
    return { ...this.issueTokens(created), recoveryCode };
  }

  /** 校验用户名密码并签发 token。 */
  async login(input: { username: string; password: string }): Promise<AuthResult> {
    const username = normalizeUsername(input.username);
    const [user] = await this.db.select().from(users).where(eq(users.username, username));
    if (!user) {
      throw new UnauthorizedException('Invalid username or password');
    }
    const ok = await comparePassword(input.password ?? '', user.passwordHash);
    if (!ok) {
      throw new UnauthorizedException('Invalid username or password');
    }
    return this.issueTokens({
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      sessionVersion: user.sessionVersion,
    });
  }

  /** 一次性离线恢复码替换密码，并吊销该用户此前所有会话。 */
  async recoverAccount(input: {
    username?: string;
    recoveryCode?: string;
    newPassword?: string;
  }): Promise<AuthResult> {
    // 恢复码形态校验：48 位 hex（randomBytes(24) 的编码）。
    const code = input.recoveryCode?.trim() ?? '';
    if (!/^[a-fA-F0-9]{48}$/.test(code)) throw new UnauthorizedException('Invalid recovery code');
    validatePassword(input.newPassword ?? '');
    const username = normalizeUsername(input.username ?? '');
    const [user] = await this.db.select().from(users).where(eq(users.username, username));
    if (!user?.recoveryCodeHash || user.recoveryCodeHash !== recoveryHash(code)) {
      throw new UnauthorizedException('Invalid recovery code');
    }
    const passwordHash = await hashPassword(input.newPassword!);
    // 恢复成功后立即下发新恢复码（旧的作废）。
    const nextCode = randomBytes(24).toString('hex');
    return this.db.transaction(async (tx) => {
      // 乐观更新：where 同时匹配旧恢复码哈希，防止并发恢复竞态。
      const [updated] = await tx
        .update(users)
        .set({
          passwordHash,
          recoveryCodeHash: recoveryHash(nextCode),
          sessionVersion: user.sessionVersion + 1,
          updatedAt: new Date(),
        })
        .where(and(eq(users.id, user.id), eq(users.recoveryCodeHash, user.recoveryCodeHash)))
        .returning({
          id: users.id,
          username: users.username,
          displayName: users.displayName,
          sessionVersion: users.sessionVersion,
        });
      if (!updated) throw new UnauthorizedException('Invalid recovery code');
      // 全量吊销该用户的 agent 会话（sessionVersion+1 同时使旧 JWT 失效）。
      await tx
        .update(agentSessions)
        .set({ status: 'revoked', updatedAt: new Date() })
        .where(eq(agentSessions.owner, user.id));
      return { ...this.issueTokens(updated), recoveryCode: nextCode };
    });
  }

  /** 已登录用户创建或轮换离线恢复码（需验证当前密码）。 */
  async rotateRecoveryCode(userId: string, password: string): Promise<AuthResult> {
    const [user] = await this.db.select().from(users).where(eq(users.id, userId));
    if (!user || !(await comparePassword(password ?? '', user.passwordHash))) {
      throw new UnauthorizedException('Invalid password');
    }
    const code = randomBytes(24).toString('hex');
    // 乐观更新：where 匹配旧 sessionVersion，并发轮换只有一方成功。
    const [updated] = await this.db
      .update(users)
      .set({
        recoveryCodeHash: recoveryHash(code),
        sessionVersion: user.sessionVersion + 1,
        updatedAt: new Date(),
      })
      .where(and(eq(users.id, user.id), eq(users.sessionVersion, user.sessionVersion)))
      .returning({
        id: users.id,
        username: users.username,
        displayName: users.displayName,
        sessionVersion: users.sessionVersion,
      });
    if (!updated) throw new UnauthorizedException('Please sign in again');
    return { ...this.issueTokens(updated), recoveryCode: code };
  }

  /** 用合法的 refresh token 轮换出新 token 对。 */
  async refresh(refreshToken: string | undefined): Promise<AuthResult> {
    if (!refreshToken) {
      throw new UnauthorizedException('Missing refresh token');
    }
    // 第一层：签名与 typ 校验。
    const payload = verifyRefreshToken(refreshToken);
    if (!payload) {
      throw new UnauthorizedException('Refresh token is invalid or expired');
    }
    // 第二层：用户仍存在且 sessionVersion 与 token 中 ver 一致（吊销校验）。
    const [user] = await this.db
      .select({
        id: users.id,
        username: users.username,
        displayName: users.displayName,
        sessionVersion: users.sessionVersion,
      })
      .from(users)
      .where(and(eq(users.id, payload.sub), eq(users.username, payload.username)));
    if (!user || (payload.ver ?? 0) !== user.sessionVersion) {
      throw new UnauthorizedException('Refresh token is invalid or expired');
    }
    return this.issueTokens(user);
  }

  /** 读取 access token 背后的用户资料。 */
  async getProfile(userId: string): Promise<{
    id: string;
    username: string;
    displayName: string | null;
    emailNotify: string | null;
  }> {
    const [user] = await this.db
      .select({
        id: users.id,
        username: users.username,
        displayName: users.displayName,
        emailNotify: users.emailNotify,
      })
      .from(users)
      .where(eq(users.id, userId));
    if (!user) {
      throw new NotFoundException('Account not found');
    }
    return user;
  }

  /** 为用户签发一对 access/refresh token（ver 取当前 sessionVersion）。 */
  private issueTokens(user: {
    id: string;
    username: string;
    displayName: string | null;
    sessionVersion: number;
  }): AuthResult {
    return {
      user: { id: user.id, username: user.username, displayName: user.displayName },
      accessToken: signAccessToken({
        id: user.id,
        username: user.username,
        sessionVersion: user.sessionVersion,
      }),
      refreshToken: signRefreshToken({
        id: user.id,
        username: user.username,
        sessionVersion: user.sessionVersion,
      }),
    };
  }
}
