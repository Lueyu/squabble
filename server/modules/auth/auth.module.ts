/**
 * Auth module —— 一方（first-party）账户体系模块。
 *
 * 职责边界：注册 AuthController/AuthService/AuthRateLimiter，并通过
 * APP_GUARD 安装全局守卫 AuthGlobalGuard，使各 feature 模块无需 import
 * 任何鉴权相关代码即可使用 `@NeedLogin()` 装饰器；不管具体鉴权逻辑。
 *
 * 上下游：import @nestjs/core 的 APP_GUARD、common/platform/auth.guard 的
 * AuthGlobalGuard、本目录的 controller/service/rate-limiter；本模块被
 * app.module.ts 注册，exports AuthService 供其他模块消费。
 *
 * 关键约定：APP_GUARD 为全局守卫——在所有路由之前执行，`@NeedLogin()`
 * 是其放行/拦截的开关标记。
 */
import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthGlobalGuard } from '../../common/platform/auth.guard';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AuthRateLimiter } from './auth-rate-limiter';

@Module({
  controllers: [AuthController],
  providers: [
    AuthService,
    AuthRateLimiter,
    // 全局鉴权守卫：让 @NeedLogin() 在所有 feature 模块生效。
    {
      provide: APP_GUARD,
      useClass: AuthGlobalGuard,
    },
  ],
  exports: [AuthService],
})
export class AuthModule {}
