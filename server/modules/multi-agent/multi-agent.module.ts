/**
 * Multi-Agent Module — NestJS dependency-injection wiring for the daily
 * LLM-driven portfolio-analysis pipeline.
 *
 * This module ties together the full multi-agent analysis subsystem:
 *  - MultiAgentController: HTTP routes (run lifecycle, evidence, debate, rating,
 *    risk gates, strategy rules, deep report, human decision, portfolio context).
 *  - MultiAgentService: data-access facade over all agent-related DB tables
 *    (agent_runs, agent_evidence, bull_bear_arguments, debate_records,
 *    agent_ratings, risk_gate_results, strategy_rules, agent_audit_log,
 *    deep_report).
 *  - PipelineService: orchestrates the 5-stage async pipeline
 *    (evidence → debate → critique → risk gate → rating aggregation) and
 *    notifies BatchService when a run finishes.
 *  - LlmService: thin wrapper around the Doubao/Ark chat-completions API with
 *    retries, backoff, and JSON repair/parsing.
 *  - EvidenceService: collects fundamental/news/technical evidence for a ticker
 *    via allSettled so partial failures degrade gracefully.
 *  - PortfolioContextService: assembles the per-user portfolio snapshot
 *    (holdings, weights, company-group exposures, cash ratio) and evaluates
 *    hard/soft risk rules.
 *  - BatchService: concurrency-limited queue that creates and schedules runs
 *    for the user's full watchlist/holdings (tiered full vs. summary mode).
 *
 * QuoteModule is imported because EvidenceService depends on QuoteService for
 * live price data.
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
import { PortfolioAnalysisService } from './portfolio-analysis.service';
import { PortfolioAnalysisController } from './portfolio-analysis.controller';
import { QuoteModule } from '@server/modules/quote/quote.module';
import { FxModule } from '@server/modules/fx/fx.module';

@Module({
  imports: [QuoteModule, FxModule],
  controllers: [MultiAgentController, PortfolioAnalysisController],
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
    PortfolioAnalysisService,
  ],
  exports: [LlmService, EvidenceService, PortfolioContextService, MultiAgentService],
})
export class MultiAgentModule {}
