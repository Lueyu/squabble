/**
 * 鉴权端点限流器（auth rate limiter）。
 *
 * 职责边界：对 login/register/refresh/recover 四类鉴权动作按 IP+动作 维度
 * 做进程内固定窗口限流，超限抛 429；不管持久化、不做分布式协调。
 *
 * 上下游：import @nestjs/common 的 HttpException/Injectable 与 express 的
 * Request 类型；被 auth.service.ts（或 auth.controller）在鉴权入口调用。
 *
 * 关键约定（安全敏感）：
 *  - 窗口 windowMs = 15 * 60_000（15 分钟，单位毫秒）；限制为
 *    register/recover 5 次、login 15 次、refresh 30 次（单位：次/窗口）；
 *  - 单实例进程内计数（Map 桶），适配单副本 Compose 部署——多副本部署
 *    时每个进程各有独立配额；
 *  - req.ip 只在 main.ts 显式配置了受信任反代（trust proxy）时才采用
 *    X-Forwarded-For，否则取直连 socket 地址；
 *  - 桶数超过 10_000 时顺带清理已过期桶，防止 Map 无界增长（内存防线）。
 */
import { HttpException, Injectable } from '@nestjs/common';
import type { Request } from 'express';

/** 受限流的四类鉴权动作。 */
type AuthAction = 'login' | 'register' | 'refresh' | 'recover';

/** 面向单实例 Compose 部署的进程内有界限流保护。 */
@Injectable()
export class AuthRateLimiter {
  /** 限流桶：key = `${action}:${ip}`，value = 计数与本窗口重置时刻（epoch ms）。 */
  private readonly buckets = new Map<string, { count: number; resetAt: number }>();
  /** 固定窗口长度：15 分钟（毫秒）。 */
  private readonly windowMs = 15 * 60_000;

  /** 记一次该（动作, IP）的请求；超过窗口配额即抛 429。 */
  consume(request: Request, action: AuthAction): void {
    const now = Date.now();
    // 仅当 main.ts 显式启用受信任反代时，Express 的 req.ip 才取
    // X-Forwarded-For；否则是直连 socket 地址。
    const key = `${action}:${request.ip || request.socket.remoteAddress || 'unknown'}`;
    const limit = action === 'register' || action === 'recover' ? 5 : action === 'login' ? 15 : 30;
    const previous = this.buckets.get(key);
    // 无历史桶或旧窗口已到期：开新窗口从 0 计数；否则沿用累计计数。
    const current =
      !previous || previous.resetAt <= now ? { count: 0, resetAt: now + this.windowMs } : previous;
    if (current.count >= limit) throw new HttpException('Too many requests. Try again later.', 429);
    current.count += 1;
    this.buckets.set(key, current);
    // 内存防线：桶总数超阈值时清一遍已过期桶（惰性清理，非定时器）。
    if (this.buckets.size > 10_000) {
      for (const [bucketKey, bucket] of this.buckets) {
        if (bucket.resetAt <= now) this.buckets.delete(bucketKey);
      }
    }
  }
}
