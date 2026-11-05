/**
 * Auth module — first-party account system.
 *
 * Registers the auth controller and installs the global auth guard
 * (APP_GUARD) so `@NeedLogin()` decorators work across every feature module
 * without each of them importing anything auth-related.
 */
import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthGlobalGuard } from '../../common/platform/auth.guard';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AuthRateLimiter } from './auth-rate-limiter';
import { LocalWorkspaceService } from './local-workspace.service';

@Module({
  controllers: [AuthController],
  providers: [
    AuthService,
    AuthRateLimiter,
    LocalWorkspaceService,
    {
      provide: APP_GUARD,
      useClass: AuthGlobalGuard,
    },
  ],
  exports: [AuthService],
})
export class AuthModule {}
