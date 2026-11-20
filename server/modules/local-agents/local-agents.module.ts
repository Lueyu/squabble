/**
 * local-agents.module.ts — 本地智能体模块装配。
 *
 * 职责边界：
 *  - 注册 LocalAgentsController（设置域路由）与 CompanionController（设备端点），提供并导出 LocalAgentsService。
 * 上下游：
 *  - 上游：应用根模块装配；CouncilService 经导入使用 LocalAgentsService。
 *  - 下游：ResearchToolsModule（研究工具桥接）。
 */
import { Module } from '@nestjs/common';
import { CompanionController } from './companion.controller';
import { LocalAgentsController } from './local-agents.controller';
import { LocalAgentsService } from './local-agents.service';
import { ResearchToolsModule } from '../research-tools/research-tools.module';

@Module({
  imports: [ResearchToolsModule],
  controllers: [LocalAgentsController, CompanionController],
  providers: [LocalAgentsService],
  exports: [LocalAgentsService],
})
export class LocalAgentsModule {}
