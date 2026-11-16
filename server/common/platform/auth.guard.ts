/**
 * 全局鉴权 guard。
 *
 * 职责边界：在每个路由之前运行。带 `@NeedLogin()` 装饰的路由必须携带有效的
 * `Authorization: Bearer <accessToken>` 请求头；验证通过后把身份附加为
 * `req.userContext` 供控制器使用。未装饰的路由（auth 端点、SPA 页面壳、
 * 使用独立 token guard 的 agent gateway）不做校验、直接放行。
 *
 * 上下游：import NEED_LOGIN_KEY（need-login.decorator）、verifyAccessToken
 * （modules/auth/jwt）、DRIZZLE_DATABASE 与 users 表；被 AppModule 全局注册，
 * 覆盖所有 controller。
 *
 * 关键约定（从代码读出）：
 * - 登录校验 = JWT 签名校验 + 数据库 sessionVersion 吊销校验两道；
 * - sessionVersion 以数据库为准：payload 缺 ver 时按 0 处理（ver ?? 0），
 *   用户表中的 sessionVersion 大于 token 携带值即视为会话被吊销。
 */
import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { NEED_LOGIN_KEY } from './need-login.decorator';
import { verifyAccessToken } from '../../modules/auth/jwt';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from './database.provider';
import { users } from '../../database/schema';
import { eq } from 'drizzle-orm';

@Injectable()
export class AuthGlobalGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // 第 1 步：读取 @NeedLogin 元数据（方法级可覆盖类级）。未标记的路由
    // 一律放行 —— guard 是全局默认放行、按需收紧的模式。
    const needLogin = this.reflector.getAllAndOverride<boolean>(NEED_LOGIN_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const req = context.switchToHttp().getRequest<Request>();
    if (!needLogin) return true;

    // 第 2 步：提取并校验 Bearer 头。缺失或格式不对都按未登录处理。
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      throw new UnauthorizedException('未登录');
    }

    // 第 3 步：校验 JWT 签名与有效期。verifyAccessToken 返回 null 表示
    // 无效/过期。
    const payload = verifyAccessToken(header.slice('Bearer '.length));
    if (!payload) {
      throw new UnauthorizedException('登录已过期，请重新登录');
    }

    // 第 4 步：吊销校验（sessionVersion）。查库比对该用户的 sessionVersion
    // 与 token 内的 ver（缺省按 0）：不一致说明签发后版本已前滚（登出/改密
    // 等场景），旧 token 必须作废。
    const [user] = await this.db
      .select({ sessionVersion: users.sessionVersion })
      .from(users)
      .where(eq(users.id, payload.sub));
    if (!user || user.sessionVersion !== (payload.ver ?? 0)) {
      throw new UnauthorizedException('Session revoked; please sign in again');
    }

    // 第 5 步：认证通过，把身份写入 req.userContext（供控制器/下游使用）。
    req.userContext = { userId: payload.sub, username: payload.username };
    return true;
  }
}
