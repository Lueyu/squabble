/**
 * Analysis module（个股研究笔记模块）。
 *
 * 职责边界：装配 stock-research-note 特性——注册 AnalysisController 并
 * 提供 AnalysisService；不引入其他模块。
 *
 * 上下游：import AnalysisController/AnalysisService（本目录）；本模块被
 * app.module.ts 注册。
 *
 * 关键约定：无 imports，service 的 Drizzle 连接由全局平台侧注入。
 */
import { Module } from '@nestjs/common';
import { AnalysisController } from './analysis.controller';
import { AnalysisService } from './analysis.service';

/** Analysis-notes 特性的 NestJS 模块定义。 */
@Module({
  controllers: [AnalysisController],
  providers: [AnalysisService],
})
export class AnalysisModule {}
