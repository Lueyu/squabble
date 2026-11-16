/**
 * Research tools module（研究工具模块）。
 *
 * 职责边界：装配研究工具三件套（registry 白名单、output 整形、service
 * 执行），并把 ResearchToolsService 导出给 multi-agent 的 council 编排
 * 与 mcp 桥使用。本模块自身不注册控制器。
 *
 * 上下游：imports QuoteModule（get_quotes 的行情数据源）与
 * MultiAgentModule（EvidenceService 证据检索依赖）；provider/export 均
 * 为 ResearchToolsService。
 */
import { Module } from '@nestjs/common';
import { QuoteModule } from '../quote/quote.module';
import { MultiAgentModule } from '../multi-agent/multi-agent.module';
import { ResearchToolsService } from './research-tools.service';

@Module({
  imports: [QuoteModule, MultiAgentModule],
  providers: [ResearchToolsService],
  exports: [ResearchToolsService],
})
export class ResearchToolsModule {}
