/**
 * Express 全局 request 类型扩充（纯类型声明，无运行时代码）。
 *
 * `userContext` 由鉴权 guard（auth.guard.ts）为每个 @NeedLogin() 路由附加；
 * 控制器从中取属主 userId。`__platform_data__` 作为可选字段保留，
 * 供遗留 view controller 的 locals 使用。
 */
import type { Request as ExpressRequest } from 'express';

declare global {
  namespace Express {
    interface Request {
      userContext: { userId: string; username?: string };
      __platform_data__?: Record<string, unknown>;
    }
  }
}

export {};
