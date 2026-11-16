/**
 * Alpha-picks module（精选推荐模块）。
 *
 * 职责边界：装配 alpha-picks 特性——注册 AlphaPicksController 并提供
 * AlphaPicksService；不引入其他模块（service 依赖的 Drizzle 连接由
 * 全局平台侧提供）。
 *
 * 上下游：import AlphaPicksController/AlphaPicksService（本目录）；本模块
 * 被 app.module.ts 注册。
 *
 * 关键约定：无 imports，依赖 DRIZZLE_DATABASE 由全局 provider 注入。
 */
import { Module } from '@nestjs/common';
import { AlphaPicksController } from './alpha-picks.controller';
import { AlphaPicksService } from './alpha-picks.service';

/** Alpha-picks 特性的 NestJS 模块定义。 */
@Module({
  controllers: [AlphaPicksController],
  providers: [AlphaPicksService],
})
export class AlphaPicksModule {}
