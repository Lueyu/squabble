/**
 * Auth controller —— 注册 / 登录 / 刷新 / 恢复 / 个人信息。
 *
 * 职责边界：暴露 `/api/auth` 下的鉴权端点；负责请求前置防线（Content-Type
 * 校验、localhost 限制、同源校验、限流），凭证校验与 token 签发全部下沉到
 * AuthService。除 `me`/`recovery-code` 外均不加 `@NeedLogin()`；全局守卫
 * 会校验 Bearer token 并在那里挂上 `req.userContext`。
 *
 * 上下游：import @nestjs/common 异常类型、NeedLogin（common/platform）、
 * AuthService 与 AuthRateLimiter（本模块）、@shared/api.interface 的
 * RegistrationStatus；由 auth.module.ts 注册。
 *
 * 关键约定（安全敏感）：register 在 REGISTER_ENABLED='first-user' 或桌面
 * 版（SQUABBLE_DESKTOP_ORIGIN 存在）时强制 Content-Type 为 JSON、Host
 * 为 localhost（127.0.0.1/[::1]）、Origin 同 Host、Sec-Fetch-Site 为
 * same-origin/none，拒绝跨源注册；每个写端点入口先 consume 限流再进
 * service。
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

@Controller('api/auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly limiter: AuthRateLimiter,
  ) {}

  /** 查询本实例当前是否还接受新账户注册。 */
  @Get('registration-status')
  async registrationStatus(): Promise<RegistrationStatus> {
    return this.authService.getRegistrationStatus();
  }

  /** 创建账户。REGISTER_ENABLED=false 时完全禁用。 */
  @Post('register')
  async register(
    @Req() request: Request,
    @Body() body: { username?: string; password?: string; displayName?: string },
  ) {
    // 首用户模式 / 桌面版：注册必须是本机发起的同源 JSON 请求。
    if (process.env.REGISTER_ENABLED === 'first-user' || process.env.SQUABBLE_DESKTOP_ORIGIN) {
      // 防线 1：必须声明 application/json（允许可选参数后缀）。
      const contentType = request.headers['content-type'];
      if (typeof contentType !== 'string' || !/^application\/json(?:\s*;|$)/iu.test(contentType)) {
        throw new UnsupportedMediaTypeException('Registration requires a JSON request');
      }
      // 防线 2：Host 必须是 localhost（解析失败或非本机回环一律拒绝）。
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
      // 防线 3：带 Origin 头时必须与 Host 同协议同主机（拒绝跨源）。
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
      // 防线 4：浏览器 Sec-Fetch-Site 若存在则必须为 same-origin 或 none。
      const fetchSite = request.headers['sec-fetch-site'];
      if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') {
        throw new ForbiddenException('Cross-origin registration is not allowed');
      }
    }
    // 防线 5：注册端点限流（15 分钟窗口 5 次）。
    this.limiter.consume(request, 'register');
    return this.authService.register({
      username: body.username ?? '',
      password: body.password ?? '',
      displayName: body.displayName,
    });
  }

  /** 用户名 + 密码登录。 */
  @Post('login')
  async login(@Req() request: Request, @Body() body: { username?: string; password?: string }) {
    this.limiter.consume(request, 'login');
    return this.authService.login({
      username: body.username ?? '',
      password: body.password ?? '',
    });
  }

  /** 用 refresh token 换发一对新 token。 */
  @Post('refresh')
  async refresh(@Req() request: Request, @Body() body: { refreshToken?: string }) {
    this.limiter.consume(request, 'refresh');
    return this.authService.refresh(body.refreshToken);
  }

  /** 用注册时下发的离线恢复码重置遗忘的密码。 */
  @Post('recover')
  async recover(
    @Req() request: Request,
    @Body() body: { username?: string; recoveryCode?: string; newPassword?: string },
  ) {
    this.limiter.consume(request, 'recover');
    return this.authService.recoverAccount(body);
  }

  /** 已登录用户轮换离线恢复码（需验证当前密码）。 */
  @NeedLogin()
  @Post('recovery-code')
  async recoveryCode(@Req() request: Request, @Body() body: { password?: string }) {
    this.limiter.consume(request, 'recover');
    return this.authService.rotateRecoveryCode(request.userContext.userId, body.password ?? '');
  }

  /** 调用者自己的资料（布局层用户菜单使用）。 */
  @NeedLogin()
  @Get('me')
  async me(@Req() req: Request) {
    return this.authService.getProfile(req.userContext.userId);
  }
}
