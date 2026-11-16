/**
 * multi-agent.controller.ts — MultiAgentController — LLM 驱动的多智能体股票
 * 分析流水线的 HTTP 入口。
 *
 * 全部路由挂在 `/api/multi-agent` 下，并经 `@NeedLogin()` 要求登录。每个
 * handler 从 `req.userContext` 取 `userId` 并逐层下传，保证所有数据库
 * 读写都按所有者隔离（用户只能看到/修改自己的运行与规则）。
 *
 * 路由分组：
 *  - 运行：列表/详情/创建/更新/取消/启动/状态、批量创建、每日批次、最新评级。
 *  - 运行子资源：证据、多空论点、辩论记录、评级、风控闸结果（各含 GET + POST）。
 *  - 人机协同：`/runs/:id/human-decision` 批准/修改/驳回 LLM 产出的评级，
 *    并可选同步到每日分析表和/或持仓行。
 *  - 策略规则：增删改查 + 排序 + 重置默认。
 *  - 深度报告：按 runId 查询，或生成样例（小米）报告。
 *  - 审计日志 + 组合上下文快照。
 *
 * 附注：`startRun` 以 fire-and-forget（void promise）触发
 * `PipelineService.startPipeline` — HTTP 响应立即返回 `fetching` 状态；
 * 客户端轮询 `/runs/:id/status` 获取进度。
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
import { PortfolioContextService } from './portfolio-context.service';
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

/** GET /runs 的查询串形态。HTTP 传来的值全是字符串；
 *  数值字段在 handler 里解析为 int。 */
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

/** 包装证据行列表，让客户端可以一次 POST 提交多条。 */
interface EvidenceBatchDto {
  items: CreateEvidenceDto[];
}

/** 包装风控闸结果列表，用于批量插入。 */
interface RiskGateBatchDto {
  items: CreateRiskGateDto[];
}

/**
 * 暴露全部多智能体分析 HTTP 端点的 NestJS 控制器。
 * 业务逻辑委托给 service/pipeline/batch 层；控制器本身保持薄，
 * 只做鉴权提取、参数解析和少量请求有效性检查
 * （如只有 `pending`/`failed` 的运行能启动；只有 `awaiting_human`/
 * `completed` 的运行接受人工决策）。
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
   * GET /runs — 调用方运行列表的分页查询，每条与其评级（如有）和深度报告
   * 目标价联查。支持按代码、状态、运行模式与日期范围过滤。
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
   * POST /runs/batch — 为调用方创建一个或多个运行，并经 BatchService 入队
   * （后者按模式应用并发上限）。
   */
  @Post('runs/batch')
  @NeedLogin()
  async createBatch(@Req() req: Request, @Body() dto: BatchRunRequest): Promise<BatchRunResult> {
    const { userId } = req.userContext;
    return this.batchService.createBatch(userId, dto);
  }

  /**
   * POST /daily-batch — 便捷端点，一键启动每日例行：对全部持仓做分级
   * （tiered）运行，并对带买入/强烈买入信号的观察列表代码做完整运行。
   */
  @Post('daily-batch')
  @NeedLogin()
  async createDailyBatch(
    @Req() req: Request,
    @Body() dto?: { language?: AnalysisLanguage },
  ): Promise<DailyBatchResult> {
    const { userId } = req.userContext;
    return this.batchService.createDailyBatch(userId, dto?.language);
  }

  /**
   * GET /latest-ratings — 返回每个代码最近一次完成的评级（可用逗号分隔的
   * 代码列表过滤）。仪表盘用它直接展示当前建议，无需打开每次运行。
   */
  @Get('latest-ratings')
  @NeedLogin()
  async getLatestRatings(
    @Req() req: Request,
    @Query('tickers') tickers?: string,
  ): Promise<LatestRating[]> {
    const { userId } = req.userContext;
    const tickerList = tickers
      ? tickers
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean)
      : undefined;
    return this.multiAgentService.getLatestRatings(userId, tickerList);
  }

  /** GET /runs/:id — 单次运行的完整详情，含全部子资源。 */
  @Get('runs/:id')
  async getRun(
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<AgentRunDetail> {
    const { userId } = req.userContext;
    return this.multiAgentService.getRun(userId, id);
  }

  /** POST /runs — 新建一条 `pending` 状态的运行行，不会启动它。 */
  @Post('runs')
  async createRun(@Req() req: Request, @Body() dto: CreateAgentRunDto): Promise<AgentRun> {
    const { userId } = req.userContext;
    return this.multiAgentService.createRun(userId, dto);
  }

  /** PATCH /runs/:id — 更新运行状态 / 人工决策 / 人工备注。 */
  @Patch('runs/:id')
  async updateRun(
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAgentRunDto,
  ): Promise<AgentRun> {
    const { userId } = req.userContext;
    return this.multiAgentService.updateRunStatus(userId, id, dto.status, dto);
  }

  /** POST /runs/:id/cancel — 把运行标记为已取消。流水线在各阶段之间
   *  检查取消标志并提前终止。 */
  @Post('runs/:id/cancel')
  async cancelRun(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string): Promise<AgentRun> {
    const { userId } = req.userContext;
    const cancelled = await this.multiAgentService.cancelRun(userId, id);
    this.batchService.cancelQueuedRun(id, userId);
    return cancelled;
  }

  /** GET /runs/:id/evidence — 列出该运行收集到的证据行。 */
  @Get('runs/:id/evidence')
  async getEvidence(
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<AgentEvidence[]> {
    const { userId } = req.userContext;
    return this.multiAgentService.getEvidence(userId, id);
  }

  /** POST /runs/:id/evidence — 为运行批量插入证据行。 */
  @Post('runs/:id/evidence')
  async addEvidence(
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: EvidenceBatchDto,
  ): Promise<AgentEvidence[]> {
    const { userId } = req.userContext;
    return this.multiAgentService.addEvidence(userId, id, dto.items);
  }

  /** GET /runs/:id/arguments — 列出多空辩论论点。 */
  @Get('runs/:id/arguments')
  async getArguments(
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<BullBearArgument[]> {
    const { userId } = req.userContext;
    return this.multiAgentService.getArguments(userId, id);
  }

  /** POST /runs/:id/arguments — 记录一条多空论点。 */
  @Post('runs/:id/arguments')
  async addArgument(
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateArgumentDto,
  ): Promise<BullBearArgument> {
    const { userId } = req.userContext;
    return this.multiAgentService.addArgument(userId, id, dto);
  }

  /** GET /runs/:id/debate — 列出辩论轮次（多/空/评论员）。 */
  @Get('runs/:id/debate')
  async getDebate(
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<DebateRecord[]> {
    const { userId } = req.userContext;
    return this.multiAgentService.getDebate(userId, id);
  }

  /** POST /runs/:id/debate — 追加一条辩论轮次。 */
  @Post('runs/:id/debate')
  async addDebateRecord(
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateDebateRecordDto,
  ): Promise<DebateRecord> {
    const { userId } = req.userContext;
    return this.multiAgentService.addDebateRecord(userId, id, dto);
  }

  /** GET /runs/:id/rating — 聚合后的最终评级（尚未产出时为 null）。 */
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

  /** GET /runs/:id/risk-gate — 列出已评估的硬/软风控规则结果。 */
  @Get('runs/:id/risk-gate')
  async getRiskGate(
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<RiskGateResult[]> {
    const { userId } = req.userContext;
    return this.multiAgentService.getRiskGate(userId, id);
  }

  /** POST /runs/:id/risk-gate — 批量插入风控闸评估结果。 */
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
   * POST /runs/:id/start — 为 pending/failed 状态的运行启动异步流水线。
   * 校验运行处于可启动状态后，以 fire-and-forget 方式触发
   * `pipelineService.startPipeline` 并立即返回。
   */
  @Post('runs/:id/start')
  @NeedLogin()
  async startRun(
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ runId: string; status: string }> {
    const { userId } = req.userContext;
    const run = await this.multiAgentService.getRun(userId, id);
    // 只有刚创建或此前失败的运行可以启动。
    if (run.status !== 'pending' && run.status !== 'failed') {
      throw new BadRequestException(`Run status ${run.status} cannot be started`);
    }
    this.pipelineService.startPipeline(id, userId);
    return { runId: id, status: 'fetching' };
  }

  /** GET /runs/:id/status — 轮询运行当前状态。 */
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
   * POST /runs/:id/human-decision — 人机协同审批环节。
   *
   * 流水线止步于 `awaiting_human`，用户随后选择：
   *  - rejected（驳回）：运行标记为 cancelled，写入审计日志。
   *  - modified（修改）：可选地把人工改过的评级覆盖 LLM 评级并保存，
   *    然后运行完成。
   *  - approved（批准）：运行完成；可选地把评级同步进每日分析表
   *    （`syncToAnalysis`，默认 true）和/或把评级回写到持仓行
   *    （`applyToHoldings`，默认 false）。
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
        // 记录原始 LLM 评级以便追溯。
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
        await this.portfolioContextService.applyRatingToHoldings(userId, id);
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

  /** GET /strategy-rules — 列出调用方的个性化风控规则。 */
  @Get('strategy-rules')
  async getStrategyRules(@Req() req: Request): Promise<StrategyRule[]> {
    const { userId } = req.userContext;
    return this.multiAgentService.getStrategyRules(userId);
  }

  /** POST /strategy-rules — 新建一条风控规则。 */
  @Post('strategy-rules')
  @NeedLogin()
  async createStrategyRule(
    @Req() req: Request,
    @Body() dto: CreateStrategyRuleDto,
  ): Promise<StrategyRule> {
    const { userId } = req.userContext;
    return this.multiAgentService.createStrategyRule(userId, dto);
  }

  /** PATCH /strategy-rules/:id — 更新一条风控规则。 */
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

  /** DELETE /strategy-rules/:id — 删除一条风控规则。 */
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

  /** POST /strategy-rules/reorder — 批量更新规则列表的排序。 */
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
    const count = await this.multiAgentService.reorderStrategyRules(userId, body.items);
    return { updated: count };
  }

  /** POST /strategy-rules/reset-default — 清空调用方规则并重新播种默认集。 */
  @Post('strategy-rules/reset-default')
  @NeedLogin()
  async resetStrategyRules(@Req() req: Request): Promise<StrategyRule[]> {
    const { userId } = req.userContext;
    return this.multiAgentService.resetDefaultStrategyRules(userId);
  }

  /** GET /deep-report/:runId — 获取完整的结构化深度报告。 */
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
   * POST /runs/:id/generate-sample-deep-report — 开发/演示端点：向数据库写入
   * 一份硬编码的小米（1810.HK）样例深度报告，便于不跑完整 LLM 流水线
   * 就能端到端测试 UI。
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

  /** GET /audit-logs — 调用方最近的审计事件（默认 20 条，上限 100）。 */
  @Get('audit-logs')
  async getAuditLogs(
    @Req() req: Request,
    @Query('limit') limit?: string,
  ): Promise<AgentAuditLog[]> {
    const { userId } = req.userContext;
    return this.multiAgentService.getAuditLogs(userId, limit ? parseInt(limit, 10) : 20);
  }

  /** GET /portfolio-context — 调用方当前的持仓/现金/权重/公司组敞口快照。 */
  @Get('portfolio-context')
  @NeedLogin()
  async getPortfolioContext(@Req() req: Request): Promise<PortfolioContext> {
    const { userId } = req.userContext;
    return this.portfolioContextService.getPortfolioContext(userId);
  }
}
