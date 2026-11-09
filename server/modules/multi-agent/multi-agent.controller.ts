/**
 * MultiAgentController — HTTP entry points for the LLM-driven multi-agent
 * stock-analysis pipeline.
 *
 * All routes are mounted under `/api/multi-agent` and require authentication
 * via `@NeedLogin()`. Every handler extracts `userId` from `req.userContext`
 * and passes it down to the service layer so that all DB reads/writes are
 * owner-scoped (a user can only see/modify their own runs and rules).
 *
 * Route groups:
 *  - Runs: list/get/create/update/cancel/start/status, batch creation,
 *    daily batch, latest ratings.
 *  - Run sub-resources: evidence, bull/bear arguments, debate records, rating,
 *    risk-gate results (GET + POST for each).
 *  - Human-in-the-loop: `/runs/:id/human-decision` approves/modifies/rejects
 *    an LLM-produced rating and optionally syncs it to the daily analysis table
 *    and/or to the holdings row.
 *  - Strategy rules: CRUD + reorder + reset-to-default.
 *  - Deep report: fetch by runId, or generate a sample (Xiaomi) report.
 *  - Audit logs + portfolio-context snapshot.
 *
 * Side note: `startRun` triggers `PipelineService.startPipeline` fire-and-forget
 * (void promise) — the HTTP response returns immediately with status
 * `fetching`; the client polls `/runs/:id/status` for progress.
 */
import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Req,
  Param,
  Query,
  ParseUUIDPipe,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { NeedLogin } from '../../common/platform';
import type { Request } from 'express';
import { MultiAgentService } from './multi-agent.service';
import { PipelineService } from './pipeline.service';
import { PortfolioContextService } from '../research-core/portfolio-context.service';
import { BatchService } from './batch.service';
import type {
  AgentRun,
  AgentRunDetail,
  AgentEvidence,
  BullBearArgument,
  DebateRecord,
  AgentRatingRecord,
  RiskGateResult,
  StrategyRule,
  AgentAuditLog,
  CreateAgentRunDto,
  UpdateAgentRunDto,
  CreateEvidenceDto,
  CreateArgumentDto,
  CreateDebateRecordDto,
  CreateAgentRatingDto,
  CreateRiskGateDto,
  UpdateStrategyRuleDto,
  CreateStrategyRuleDto,
  ReorderStrategyRuleDto,
  DeepReport,
  AgentRunStatus,
  HumanDecisionDto,
  PortfolioContext,
  BatchRunRequest,
  BatchRunResult,
  LatestRating,
  AgentRunWithRating,
  AgentRunMode,
  DailyBatchResult,
  AnalysisLanguage,
} from '@shared/api.interface';
import type { ModelRoute } from '../../../shared/model-route.interface';

/** Query-string shape for GET /runs. All values arrive as strings from HTTP;
 *  numeric fields are parsed to int in the handler. */
interface ListRunsQuery {
  activeOnly?: string;
  ticker?: string;
  status?: AgentRunStatus;
  runMode?: AgentRunMode;
  from?: string;
  to?: string;
  limit?: string;
  offset?: string;
}

/** Wraps a list of evidence rows so the client can POST them in one request. */
interface EvidenceBatchDto {
  items: CreateEvidenceDto[];
}

/** Wraps a list of risk-gate results for bulk insertion. */
interface RiskGateBatchDto {
  items: CreateRiskGateDto[];
}

/**
 * NestJS controller exposing all multi-agent-analysis HTTP endpoints.
 * Delegates business logic to the service/pipeline/batch layer; the controller
 * itself is thin and only does auth extraction, param parsing, and a small
 * number of request-validity checks (e.g. only `pending`/`failed` runs can be
 * started; only `awaiting_human`/`completed` runs accept a human decision).
 */
@NeedLogin()
@Controller('api/multi-agent')
export class MultiAgentController {
  constructor(
    private readonly multiAgentService: MultiAgentService,
    private readonly pipelineService: PipelineService,
    private readonly portfolioContextService: PortfolioContextService,
    private readonly batchService: BatchService,
  ) {}

  /**
   * GET /runs — paginated list of the caller's agent runs, each joined with
   * its rating (if any) and deep-report target prices.
   * Supports filtering by ticker, status, runMode, and date range.
   */
  @Get('runs')
  async listRuns(
    @Req() req: Request,
    @Query() query: ListRunsQuery,
  ): Promise<{ items: AgentRunWithRating[]; total: number }> {
    const { userId } = req.userContext;
    return this.multiAgentService.listRunsWithRating(userId, {
      activeOnly: query.activeOnly === 'true',
      ticker: query.ticker,
      status: query.status,
      runMode: query.runMode,
      from: query.from,
      to: query.to,
      limit: query.limit ? parseInt(query.limit, 10) : undefined,
      offset: query.offset ? parseInt(query.offset, 10) : undefined,
    });
  }

  /**
   * POST /runs/batch — create one or more runs for the caller and enqueue them
   * through BatchService (which applies per-mode concurrency caps).
   */
  @Post('runs/batch')
  @NeedLogin()
  async createBatch(
    @Req() req: Request,
    @Body() dto: BatchRunRequest,
  ): Promise<BatchRunResult> {
    const { userId } = req.userContext;
    return this.batchService.createBatch(userId, dto);
  }

  /**
   * POST /daily-batch — convenience endpoint that kicks off the daily routine:
   * a tiered run over all holdings plus a full run for watchlist items that
   * carry a buy/strong-buy signal.
   */
  @Post('daily-batch')
  @NeedLogin()
  async createDailyBatch(@Req() req: Request, @Body() dto?: { language?: AnalysisLanguage; route?: ModelRoute }): Promise<DailyBatchResult> {
    const { userId } = req.userContext;
    return this.batchService.createDailyBatch(userId, dto?.language, dto?.route);
  }

  /**
   * GET /latest-ratings — return the most recent completed rating per ticker
   * (optionally filtered by a comma-separated ticker list). Used by the
   * dashboard to show current recommendations without opening each run.
   */
  @Get('latest-ratings')
  @NeedLogin()
  async getLatestRatings(
    @Req() req: Request,
    @Query('tickers') tickers?: string,
  ): Promise<LatestRating[]> {
    const { userId } = req.userContext;
    const tickerList = tickers ? tickers.split(',').map((t) => t.trim()).filter(Boolean) : undefined;
    return this.multiAgentService.getLatestRatings(userId, tickerList);
  }

  /** GET /runs/:id — full detail of a single run including all sub-resources. */
  @Get('runs/:id')
  async getRun(
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<AgentRunDetail> {
    const { userId } = req.userContext;
    return this.multiAgentService.getRun(userId, id);
  }

  /** POST /runs — create a new run row in `pending` status. Does not start it. */
  @Post('runs')
  async createRun(
    @Req() req: Request,
    @Body() dto: CreateAgentRunDto,
  ): Promise<AgentRun> {
    const { userId } = req.userContext;
    return this.multiAgentService.createRun(userId, dto);
  }

  /** PATCH /runs/:id — update run status / human decision / human note. */
  @Patch('runs/:id')
  async updateRun(
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAgentRunDto,
  ): Promise<AgentRun> {
    const { userId } = req.userContext;
    return this.multiAgentService.updateRunStatus(userId, id, dto.status, dto);
  }

  /** POST /runs/:id/cancel — mark a run as cancelled. The pipeline checks
   *  cancellation between phases and stops early. */
  @Post('runs/:id/cancel')
  async cancelRun(
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<AgentRun> {
    const { userId } = req.userContext;
    const cancelled = await this.multiAgentService.cancelRun(userId, id);
    this.batchService.cancelQueuedRun(id, userId);
    return cancelled;
  }

  /** GET /runs/:id/evidence — list evidence rows collected for a run. */
  @Get('runs/:id/evidence')
  async getEvidence(
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<AgentEvidence[]> {
    const { userId } = req.userContext;
    return this.multiAgentService.getEvidence(userId, id);
  }

  /** POST /runs/:id/evidence — bulk-insert evidence rows for a run. */
  @Post('runs/:id/evidence')
  async addEvidence(
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: EvidenceBatchDto,
  ): Promise<AgentEvidence[]> {
    const { userId } = req.userContext;
    return this.multiAgentService.addEvidence(userId, id, dto.items);
  }

  /** GET /runs/:id/arguments — list bull/bear debate arguments. */
  @Get('runs/:id/arguments')
  async getArguments(
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<BullBearArgument[]> {
    const { userId } = req.userContext;
    return this.multiAgentService.getArguments(userId, id);
  }

  /** POST /runs/:id/arguments — record a single bull/bear argument. */
  @Post('runs/:id/arguments')
  async addArgument(
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateArgumentDto,
  ): Promise<BullBearArgument> {
    const { userId } = req.userContext;
    return this.multiAgentService.addArgument(userId, id, dto);
  }

  /** GET /runs/:id/debate — list debate turns (bull/bear/critic). */
  @Get('runs/:id/debate')
  async getDebate(
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<DebateRecord[]> {
    const { userId } = req.userContext;
    return this.multiAgentService.getDebate(userId, id);
  }

  /** POST /runs/:id/debate — append a debate turn. */
  @Post('runs/:id/debate')
  async addDebateRecord(
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateDebateRecordDto,
  ): Promise<DebateRecord> {
    const { userId } = req.userContext;
    return this.multiAgentService.addDebateRecord(userId, id, dto);
  }

  /** GET /runs/:id/rating — the aggregated final rating (null if not yet produced). */
  @Get('runs/:id/rating')
  async getRating(
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<AgentRatingRecord | null> {
    const { userId } = req.userContext;
    return this.multiAgentService.getRating(userId, id);
  }

  /** POST /runs/:id/rating — upsert the rating for a run (called by the pipeline
   *  and by the human-modified path). */
  @Post('runs/:id/rating')
  async saveRating(
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateAgentRatingDto,
  ): Promise<AgentRatingRecord> {
    const { userId } = req.userContext;
    return this.multiAgentService.saveRating(userId, id, dto);
  }

  /** GET /runs/:id/risk-gate — list evaluated hard/soft risk-rule results. */
  @Get('runs/:id/risk-gate')
  async getRiskGate(
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<RiskGateResult[]> {
    const { userId } = req.userContext;
    return this.multiAgentService.getRiskGate(userId, id);
  }

  /** POST /runs/:id/risk-gate — bulk-insert risk-gate evaluation results. */
  @Post('runs/:id/risk-gate')
  async saveRiskGate(
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RiskGateBatchDto,
  ): Promise<RiskGateResult[]> {
    const { userId } = req.userContext;
    return this.multiAgentService.saveRiskGateResults(userId, id, dto.items);
  }

  /**
   * POST /runs/:id/start — kick off the async pipeline for a pending/failed run.
   * Validates that the run is in a startable state, then fires
   * `pipelineService.startPipeline` (fire-and-forget) and immediately returns.
   */
  @Post('runs/:id/start')
  @NeedLogin()
  async startRun(
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ runId: string; status: string }> {
    const { userId } = req.userContext;
    const run = await this.multiAgentService.getRun(userId, id);
    // Only freshly-created or previously-failed runs can be started.
    if (run.status !== 'pending' && run.status !== 'failed') {
      throw new BadRequestException(`Run status ${run.status} cannot be started`);
    }
    this.pipelineService.startPipeline(id, userId);
    return { runId: id, status: 'fetching' };
  }

  /** GET /runs/:id/status — poll the current state of a run. */
  @Get('runs/:id/status')
  @NeedLogin()
  async getRunStatus(
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<AgentRunDetail> {
    const { userId } = req.userContext;
    return this.multiAgentService.getRun(userId, id);
  }

  /**
   * POST /runs/:id/human-decision — human-in-the-loop approval step.
   *
   * The pipeline ends at `awaiting_human`; the user then chooses:
   *  - rejected: run is marked cancelled, audit log written.
   *  - modified: an optional human-edited rating is saved over the LLM rating,
   *    then the run completes.
   *  - approved: run completes; optionally syncs the rating into the daily
   *    analysis table (`syncToAnalysis`, default true) and/or writes the rating
   *    back onto the holdings row (`applyToHoldings`, default false).
   */
  @Post('runs/:id/human-decision')
  @NeedLogin()
  async humanDecision(
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: HumanDecisionDto,
  ): Promise<AgentRun> {
    const { userId } = req.userContext;

    if (!['approved', 'modified', 'rejected'].includes(dto.decision)) {
      throw new BadRequestException('Invalid decision value');
    }

    const run = await this.multiAgentService.getRun(userId, id);
    if (run.status !== 'awaiting_human' && run.status !== 'completed') {
      throw new BadRequestException(`Run status ${run.status} does not allow human decision`);
    }

    if (dto.decision === 'rejected') {
      await this.multiAgentService.addAuditLog(userId, id, 'human_rejected', {
        note: dto.note ?? null,
      });
      return this.multiAgentService.updateRunStatus(userId, id, 'cancelled', {
        humanDecision: 'rejected',
        humanNote: dto.note,
      });
    }

    if (dto.decision === 'modified' && dto.modifiedRating) {
      const mr = dto.modifiedRating;
      await this.multiAgentService.saveRating(userId, id, {
        ticker: run.ticker,
        rating: mr.rating,
        confidence: mr.confidence,
        targetPrice: mr.targetPrice,
        action: mr.action,
        bullSummary: mr.bullSummary,
        bearSummary: mr.bearSummary,
        catalysts: mr.catalysts,
        risks: mr.risks,
        // Record the original LLM rating for traceability.
        aggregationLogic: `人工修改评级，原始评级: ${run.rating?.rating ?? 'N/A'}`,
        keyUncertainty: run.rating?.keyUncertainty ?? undefined,
      });
    }

    if (dto.decision === 'approved' || dto.decision === 'modified') {
      const shouldSync = dto.syncToAnalysis !== false;
      const shouldApply = dto.applyToHoldings === true;

      if (shouldSync) {
        await this.multiAgentService.syncRatingToAnalysis(userId, id);
      }
      if (shouldApply) {
        await this.multiAgentService.applyRatingToHoldings(userId, id);
      }

      await this.multiAgentService.addAuditLog(userId, id, `human_${dto.decision}` as const, {
        note: dto.note ?? null,
        syncToAnalysis: shouldSync,
        applyToHoldings: shouldApply,
      });
    }

    return this.multiAgentService.updateRunStatus(userId, id, 'completed', {
      humanDecision: dto.decision,
      humanNote: dto.note,
    });
  }

  /** GET /strategy-rules — list the caller's personalized risk rules. */
  @Get('strategy-rules')
  async getStrategyRules(@Req() req: Request): Promise<StrategyRule[]> {
    const { userId } = req.userContext;
    return this.multiAgentService.getStrategyRules(userId);
  }

  /** POST /strategy-rules — create a new risk rule. */
  @Post('strategy-rules')
  @NeedLogin()
  async createStrategyRule(
    @Req() req: Request,
    @Body() dto: CreateStrategyRuleDto,
  ): Promise<StrategyRule> {
    const { userId } = req.userContext;
    return this.multiAgentService.createStrategyRule(userId, dto);
  }

  /** PATCH /strategy-rules/:id — update a risk rule. */
  @Patch('strategy-rules/:id')
  @NeedLogin()
  async updateStrategyRule(
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateStrategyRuleDto,
  ): Promise<StrategyRule> {
    const { userId } = req.userContext;
    return this.multiAgentService.updateStrategyRule(userId, id, dto);
  }

  /** DELETE /strategy-rules/:id — remove a risk rule. */
  @Delete('strategy-rules/:id')
  @NeedLogin()
  async deleteStrategyRule(
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ deleted: boolean }> {
    const { userId } = req.userContext;
    await this.multiAgentService.deleteStrategyRule(userId, id);
    return { deleted: true };
  }

  /** POST /strategy-rules/reorder — bulk-update sort order for the rules list. */
  @Post('strategy-rules/reorder')
  @NeedLogin()
  async reorderStrategyRules(
    @Req() req: Request,
    @Body() body: { items: ReorderStrategyRuleDto[] },
  ): Promise<{ updated: number }> {
    const { userId } = req.userContext;
    if (!Array.isArray(body.items) || body.items.length === 0) {
      throw new BadRequestException('items 不能为空');
    }
    const count = await this.multiAgentService.reorderStrategyRules(
      userId,
      body.items,
    );
    return { updated: count };
  }

  /** POST /strategy-rules/reset-default — wipe caller's rules and reseed defaults. */
  @Post('strategy-rules/reset-default')
  @NeedLogin()
  async resetStrategyRules(@Req() req: Request): Promise<StrategyRule[]> {
    const { userId } = req.userContext;
    return this.multiAgentService.resetDefaultStrategyRules(userId);
  }

  /** GET /deep-report/:runId — fetch the full structured deep-dive report. */
  @Get('deep-report/:runId')
  @NeedLogin()
  async getDeepReport(
    @Req() req: Request,
    @Param('runId', ParseUUIDPipe) runId: string,
  ): Promise<DeepReport | null> {
    const { userId } = req.userContext;
    return this.multiAgentService.getDeepReport(userId, runId);
  }

  /**
   * POST /runs/:id/generate-sample-deep-report — developer/demo endpoint that
   * writes a hard-coded Xiaomi (1810.HK) sample deep report into the DB so the
   * UI can be tested end-to-end without running the full LLM pipeline.
   */
  @Post('runs/:id/generate-sample-deep-report')
  @NeedLogin()
  async generateSampleDeepReport(
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<DeepReport> {
    const { userId } = req.userContext;
    return this.multiAgentService.generateSampleDeepReport(userId, id);
  }

  /** GET /audit-logs — recent audit events for the caller (default 20, max 100). */
  @Get('audit-logs')
  async getAuditLogs(
    @Req() req: Request,
    @Query('limit') limit?: string,
  ): Promise<AgentAuditLog[]> {
    const { userId } = req.userContext;
    return this.multiAgentService.getAuditLogs(userId, limit ? parseInt(limit, 10) : 20);
  }

  /** GET /portfolio-context — current holdings/cash/weights/company-group
   *  exposures snapshot for the caller. */
  @Get('portfolio-context')
  @NeedLogin()
  async getPortfolioContext(@Req() req: Request): Promise<PortfolioContext> {
    const { userId } = req.userContext;
    return this.portfolioContextService.getPortfolioContext(userId);
  }
}
