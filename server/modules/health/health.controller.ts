/**
 * Health controller（健康检查控制器）。
 *
 * 职责边界：提供 `/api/health` 就绪探针——执行 `select 1` 验证数据库连接
 * 可用；不做深度健康检查、不校验外部服务。
 *
 * 上下游：import @nestjs/common、drizzle-orm 的 sql、DRIZZLE_DATABASE
 * （common/platform 注入的 Drizzle 连接）；由 health.module.ts 注册。
 *
 * 关键约定：无鉴权（探针供负载均衡/容器编排调用）；数据库不可达时抛
 * 503 ServiceUnavailableException。
 */
import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '../../common/platform';

@Controller('api/health')
export class HealthController {
  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase) {}

  /** 就绪探针：数据库连通返回 ok，任何异常一律 503。 */
  @Get()
  async readiness(): Promise<{ status: 'ok' }> {
    try {
      await this.db.execute(sql`select 1`);
      return { status: 'ok' };
    } catch {
      throw new ServiceUnavailableException('Service is unavailable');
    }
  }
}
