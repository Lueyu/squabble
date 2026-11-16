/**
 * council.module.ts — 研究委员会模块装配。
 *
 * 职责边界：
 *  - 注册 CouncilController 与 CouncilService，并导出 CouncilService 供其他模块（paper-trading 编排）复用。
 * 上下游：
 *  - 上游：应用根模块装配。
 *  - 下游：MultiAgentModule（复用多智能体报告）、LocalAgentsModule（本地智能体成员执行）。
 */
import { Module } from '@nestjs/common';
import { MultiAgentModule } from '../multi-agent/multi-agent.module';
import { CouncilController } from './council.controller';
import { CouncilService } from './council.service';
import { LocalAgentsModule } from '../local-agents/local-agents.module';

@Module({
  imports: [MultiAgentModule, LocalAgentsModule],
  controllers: [CouncilController],
  providers: [CouncilService],
  exports: [CouncilService],
})
export class CouncilModule {}
