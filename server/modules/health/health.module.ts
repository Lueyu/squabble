/**
 * Health module（健康检查模块）。
 *
 * 职责边界：注册 HealthController；无 provider、无 exports。
 *
 * 上下游：import HealthController（本目录）；本模块被 app.module.ts 注册。
 *
 * 关键约定：就绪探针依赖的 Drizzle 连接由全局平台侧注入，本模块零配置。
 */
import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';

@Module({ controllers: [HealthController] })
export class HealthModule {}
