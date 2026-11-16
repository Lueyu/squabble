/**
 * multi-agent.module.ts — Multi-Agent 模块：为每日 LLM 驱动的组合分析流水线
 * 完成 NestJS 依赖注入装配。
 *
 * 本模块把多智能体分析子系统完整地组合起来：
 *  - MultiAgentController：HTTP 路由（运行生命周期、证据、辩论、评级、
 *    风险闸门、策略规则、深度报告、人工决策、组合上下文）。
 *  - MultiAgentService：覆盖全部 agent 相关数据库表的统一数据访问门面
 *    （agent_runs, agent_evidence, bull_bear_arguments, debate_records,
 *    agent_ratings, risk_gate_results, strategy_rules, agent_audit_log,
 *    deep_report）。
 *  - PipelineService：编排 5 阶段异步流水线
 *    （证据 → 辩论 → 批评 → 风险闸门 → 评级聚合），并在一次运行结束时
 *    通知 BatchService。
 *  - LlmService：对 Doubao/Ark chat-completions API 的轻量封装，带重试、
 *    退避以及 JSON 修复/解析。
 *  - EvidenceService：通过 allSettled 为一个 ticker 并行收集基本面/新闻/技术面
 *    证据，部分失败时可优雅降级。
 *  - PortfolioContextService：汇总每个用户的组合快照
 *    （持仓、权重、同集团敞口、现金比例）并执行硬性/软性风险规则。
 *  - BatchService：并发受限队列，为用户的完整自选/持仓清单创建并调度运行
 *    （分层：full 完整模式 vs summary 摘要模式）。
 *
 * 导入 QuoteModule 是因为 EvidenceService 依赖 QuoteService 获取实时行情。
 */
import { Module } from '@nestjs/common';
import { MultiAgentController } from './multi-agent.controller';
import { MultiAgentService } from './multi-agent.service';
import { LlmService } from './llm.service';
import { EvidenceService } from './evidence.service';
import { FinnhubEvidenceService } from './finnhub-evidence.service';
import { SecEvidenceService } from './sec-evidence.service';
import { ResearchWebService } from './research-web.service';
import { ResearchToolsBudgetService } from './research-tools-budget.service';
import { PipelineService } from './pipeline.service';
import { PortfolioContextService } from './portfolio-context.service';
import { BatchService } from './batch.service';
import { QuoteModule } from '@server/modules/quote/quote.module';
import { FxModule } from '@server/modules/fx/fx.module';

// 模块装配：导入行情（Quote）与汇率（Fx）模块，注册唯一的控制器与全部服务，
// 并对外导出四个服务供其他模块复用。
@Module({
  imports: [QuoteModule, FxModule],
  controllers: [MultiAgentController],
  providers: [
    MultiAgentService,
    LlmService,
    EvidenceService,
    FinnhubEvidenceService,
    SecEvidenceService,
    ResearchWebService,
    ResearchToolsBudgetService,
    PipelineService,
    PortfolioContextService,
    BatchService,
  ],
  exports: [LlmService, EvidenceService, PortfolioContextService, MultiAgentService],
})
export class MultiAgentModule {}
