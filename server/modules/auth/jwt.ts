/**
 * 一方（first-party）鉴权体系的 JWT 辅助模块。
 *
 * 职责边界：access/refresh 两种 token 的签发与校验，只做 claim 构造、
 * TTL 配置读取与 typ 校验；不管 HTTP 层（controller）、会话吊销检查
 * （common/platform/auth.guard.ts）与限流（auth-rate-limiter.ts）。
 *
 * 上下游：import jsonwebtoken；被 auth.service.ts（签发/刷新）、
 * common/platform/auth.guard.ts（access 校验）等调用。导出
 * AccessPayload/RefreshPayload 供消费方复用类型。
 *
 * 关键约定（安全敏感，勿改语义）：
 *  - 两种 token 共用同一密钥 JWT_SECRET，用 `typ` claim 区分种类——
 *    refresh token 永远不能调业务 API，access token 永远不能换发新 token；
 *  - `ver` claim 携带 sessionVersion（缺省按 0），供吊销双校验使用；
 *  - JWT_SECRET 必须存在且长度 >= 16 字符，否则启动即抛错；
 *  - access 默认 TTL 2h（ACCESS_TOKEN_TTL），refresh 默认 30d
 *    （REFRESH_TOKEN_TTL），均可由环境变量覆盖。
 */
import jwt from 'jsonwebtoken';

/** Access token 载荷：sub=用户 id，typ 固定 'access'，ver=sessionVersion。 */
export interface AccessPayload {
  sub: string;
  username: string;
  typ: 'access';
  ver?: number;
}

/** Refresh token 载荷：sub=用户 id，typ 固定 'refresh'，ver=sessionVersion。 */
export interface RefreshPayload {
  sub: string;
  username: string;
  typ: 'refresh';
  ver?: number;
}

/**
 * 读取并校验 JWT_SECRET：缺失或短于 16 字符直接抛错（fail-fast，避免用
 * 弱密钥签发出可伪造的 token）。
 */
function getSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error(
      'JWT_SECRET is missing or too short (min 16 chars). Set it in the environment before starting the app.',
    );
  }
  return secret;
}

/** 签发短效 access token（默认 2h）。 */
export function signAccessToken(user: {
  id: string;
  username: string;
  sessionVersion?: number;
}): string {
  return jwt.sign(
    { sub: user.id, username: user.username, typ: 'access', ver: user.sessionVersion ?? 0 },
    getSecret(),
    {
      expiresIn: (process.env.ACCESS_TOKEN_TTL ?? '2h') as jwt.SignOptions['expiresIn'],
    },
  );
}

/** 签发长效 refresh token（默认 30d）。 */
export function signRefreshToken(user: {
  id: string;
  username: string;
  sessionVersion?: number;
}): string {
  return jwt.sign(
    { sub: user.id, username: user.username, typ: 'refresh', ver: user.sessionVersion ?? 0 },
    getSecret(),
    {
      expiresIn: (process.env.REFRESH_TOKEN_TTL ?? '30d') as jwt.SignOptions['expiresIn'],
    },
  );
}

/**
 * 校验 access token；签名无效/过期/typ 不匹配（含 payload 为 string 的
 * 异常路径）一律返回 null，由调用方决定 401。
 */
export function verifyAccessToken(token: string): AccessPayload | null {
  try {
    const payload = jwt.verify(token, getSecret());
    // typ 双重防线：即使签名合法，typ 不是 'access' 也拒绝。
    if (typeof payload === 'string' || payload.typ !== 'access') return null;
    return payload as AccessPayload;
  } catch {
    return null;
  }
}

/**
 * 校验 refresh token；签名无效/过期/typ 不匹配一律返回 null。
 */
export function verifyRefreshToken(token: string): RefreshPayload | null {
  try {
    const payload = jwt.verify(token, getSecret());
    // typ 双重防线：即使签名合法，typ 不是 'refresh' 也拒绝。
    if (typeof payload === 'string' || payload.typ !== 'refresh') return null;
    return payload as RefreshPayload;
  } catch {
    return null;
  }
}
