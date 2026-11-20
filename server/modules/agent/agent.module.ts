/**
 * agent.module.ts — LLM 分析智能体模块装配。
 *
 * 职责边界：
 *  - 导入 SnapshotsModule（智能体可 upsert/list 快照），注册 AgentController，提供 AgentService。
 * 上下游：
 *  - 上游：应用根模块装配。
 *  - 下游：SnapshotsModule（快照读写）。
 */
import { Module } from '@nestjs/common';
import { AgentController } from './agent.controller';
import { AgentService } from './agent.service';
import { SnapshotsModule } from '../snapshots/snapshots.module';

/** 智能体功能的 NestJS 模块定义。 */
@Module({
  imports: [SnapshotsModule],
  controllers: [AgentController],
  providers: [AgentService],
})
export class AgentModule {}
