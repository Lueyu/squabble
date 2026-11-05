/**
 * Global auth guard.
 *
 * Runs before every route. Routes decorated with `@NeedLogin()` must carry a
 * valid `Authorization: Bearer <accessToken>` header; the verified identity is
 * attached as `req.userContext` for controllers. Undecorated routes (auth
 * endpoints, the SPA shell, the agent gateway with its own token guard)
 * pass through untouched.
 */
import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { NEED_LOGIN_KEY } from './need-login.decorator';
import { verifyAccessToken } from '../../modules/auth/jwt';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from './database.provider';
import { users } from '../../database/schema';
import { eq } from 'drizzle-orm';
import { isLocalWorkspaceMode } from '../../modules/auth/local-workspace';
import { LocalWorkspaceService } from '../../modules/auth/local-workspace.service';

@Injectable()
export class AuthGlobalGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    @Optional() private readonly workspace?: LocalWorkspaceService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const needLogin = this.reflector.getAllAndOverride<boolean>(NEED_LOGIN_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const req = context.switchToHttp().getRequest<Request>();
    if (!needLogin) return true;

    if (isLocalWorkspaceMode()) {
      if (!this.workspace) throw new Error('Local workspace service is unavailable');
      req.userContext = await this.workspace.identity();
      return true;
    }

    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      throw new UnauthorizedException('未登录');
    }
    const payload = verifyAccessToken(header.slice('Bearer '.length));
    if (!payload) {
      throw new UnauthorizedException('登录已过期，请重新登录');
    }
    const [user] = await this.db.select({ sessionVersion: users.sessionVersion })
      .from(users).where(eq(users.id, payload.sub));
    if (!user || user.sessionVersion !== (payload.ver ?? 0)) {
      throw new UnauthorizedException('Session revoked; please sign in again');
    }
    req.userContext = { userId: payload.sub, username: payload.username };
    return true;
  }
}
