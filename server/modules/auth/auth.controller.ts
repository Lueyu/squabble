/**
 * Auth controller — register / login / refresh / me.
 *
 * None of these routes are `@NeedLogin()`-decorated except `me`; the global
 * guard verifies the Bearer token and attaches `req.userContext` there.
 */
import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Post,
  Req,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import type { Request } from 'express';
import { NeedLogin } from '../../common/platform/need-login.decorator';
import { AuthService } from './auth.service';
import { AuthRateLimiter } from './auth-rate-limiter';
import type { RegistrationStatus } from '@shared/api.interface';
import { authMode, isLocalWorkspaceMode } from './local-workspace';

@Controller('api/auth')
export class AuthController {
  constructor(private readonly authService: AuthService, private readonly limiter: AuthRateLimiter) {}

  @Get('mode')
  mode() { return { mode: authMode() }; }

  private requireAccounts(): void {
    if (isLocalWorkspaceMode()) throw new ForbiddenException('Account sign-in is disabled in local workspace mode');
  }

  /** Whether this instance currently accepts another account. */
  @Get('registration-status')
  async registrationStatus(): Promise<RegistrationStatus> {
    if (isLocalWorkspaceMode()) return { registrationOpen: false };
    return this.authService.getRegistrationStatus();
  }

  /** Create an account. Disabled entirely when REGISTER_ENABLED=false. */
  @Post('register')
  async register(
    @Req() request: Request,
    @Body() body: { username?: string; password?: string; displayName?: string },
  ) {
    this.requireAccounts();
    if (process.env.REGISTER_ENABLED === 'first-user' || process.env.SQUABBLE_DESKTOP_ORIGIN) {
      const contentType = request.headers['content-type'];
      if (typeof contentType !== 'string' || !/^application\/json(?:\s*;|$)/iu.test(contentType)) {
        throw new UnsupportedMediaTypeException('Registration requires a JSON request');
      }
      const host = request.headers.host;
      let hostname: string;
      try {
        hostname = new URL(`http://${host}`).hostname;
      } catch {
        throw new ForbiddenException('Registration is available only on localhost');
      }
      if (!['localhost', '127.0.0.1', '[::1]'].includes(hostname)) {
        throw new ForbiddenException('Registration is available only on localhost');
      }
      const origin = request.headers.origin;
      if (origin) {
        let originUrl: URL;
        try {
          originUrl = new URL(origin);
        } catch {
          throw new ForbiddenException('Cross-origin registration is not allowed');
        }
        if (originUrl.protocol !== 'http:' || originUrl.host !== host) {
          throw new ForbiddenException('Cross-origin registration is not allowed');
        }
      }
      const fetchSite = request.headers['sec-fetch-site'];
      if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') {
        throw new ForbiddenException('Cross-origin registration is not allowed');
      }
    }
    this.limiter.consume(request, 'register');
    return this.authService.register({
      username: body.username ?? '',
      password: body.password ?? '',
      displayName: body.displayName,
    });
  }

  /** Log in with username + password. */
  @Post('login')
  async login(@Req() request: Request, @Body() body: { username?: string; password?: string }) {
    this.requireAccounts();
    this.limiter.consume(request, 'login');
    return this.authService.login({
      username: body.username ?? '',
      password: body.password ?? '',
    });
  }

  /** Exchange a refresh token for a fresh token pair. */
  @Post('refresh')
  async refresh(@Req() request: Request, @Body() body: { refreshToken?: string }) {
    this.requireAccounts();
    this.limiter.consume(request, 'refresh');
    return this.authService.refresh(body.refreshToken);
  }

  /** Replace a forgotten password using the offline code issued at registration. */
  @Post('recover')
  async recover(@Req() request: Request, @Body() body: { username?: string; recoveryCode?: string; newPassword?: string }) {
    this.requireAccounts();
    this.limiter.consume(request, 'recover');
    return this.authService.recoverAccount(body);
  }

  @NeedLogin()
  @Post('recovery-code')
  async recoveryCode(@Req() request: Request, @Body() body: { password?: string }) {
    this.requireAccounts();
    this.limiter.consume(request, 'recover');
    return this.authService.rotateRecoveryCode(request.userContext.userId, body.password ?? '');
  }

  /** Profile of the caller (used by the layout user menu). */
  @NeedLogin()
  @Get('me')
  async me(@Req() req: Request) {
    return this.authService.getProfile(req.userContext.userId);
  }
}
