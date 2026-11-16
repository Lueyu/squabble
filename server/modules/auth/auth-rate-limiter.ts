import { HttpException, Injectable } from '@nestjs/common';
import type { Request } from 'express';

type AuthAction = 'login' | 'register' | 'refresh' | 'recover';

/** Bounded single-process protection for the single-instance Compose deployment. */
@Injectable()
export class AuthRateLimiter {
  private readonly buckets = new Map<string, { count: number; resetAt: number }>();
  private readonly windowMs = 15 * 60_000;

  consume(request: Request, action: AuthAction): void {
    const now = Date.now();
    // Express req.ip uses X-Forwarded-For only when the explicitly configured
    // trusted reverse proxy is enabled in main.ts.
    const key = `${action}:${request.ip || request.socket.remoteAddress || 'unknown'}`;
    const limit = action === 'register' || action === 'recover' ? 5 : action === 'login' ? 15 : 30;
    const previous = this.buckets.get(key);
    const current =
      !previous || previous.resetAt <= now ? { count: 0, resetAt: now + this.windowMs } : previous;
    if (current.count >= limit) throw new HttpException('Too many requests. Try again later.', 429);
    current.count += 1;
    this.buckets.set(key, current);
    if (this.buckets.size > 10_000) {
      for (const [bucketKey, bucket] of this.buckets) {
        if (bucket.resetAt <= now) this.buckets.delete(bucketKey);
      }
    }
  }
}
