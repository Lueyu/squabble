/**
 * MultiAgentService — data-access facade for all multi-agent tables.
 *
 * This is the single place where the multi-agent subsystem talks to PostgreSQL.
 * The controller and pipeline call into these methods; business logic lives in
 * PipelineService / PortfolioContextService / BatchService.
 *
 * Tables touched:
 *  - agent_runs: one row per analysis run (lifecycle, timing, tokens).
 *  - agent_evidence: evidence rows collected in Phase 1.
 *  - bull_bear_arguments: individual bull/bear debate points.
 *  - debate_records: one row per debate turn (bull/bear/critic).
 *  - agent_ratings: the final aggregated rating (upserted once per run).
 *  - risk_gate_results: evaluated hard/soft rule results.
 *  - strategy_rules: user-customizable risk rules (seeded with defaults).
 *  - agent_audit_log: append-only audit trail of run lifecycle events.
 *  - deep_report: structured deep-dive report (SOTP valuation, financials…).
 *  - analysis: the daily-analysis table that human-approved ratings can sync
 *    into (shared with the rest of the app).
 *
 * Every query is owner-scoped (WHERE owner = userId) so users can never read
 * or mutate each other's data. Sub-resource writes (evidence/arguments/etc.)
 * first call ensureRunOwner to verify the run belongs to the caller.
 */
import {
  Injectable,
  Inject,
  Logger,
  NotFoundException,
  BadRequestException,
  Optional,
} from '@nestjs/common';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '../../common/platform';
import { eq, and, desc, inArray, gte, lt, sql } from 'drizzle-orm';
import {
  agentRuns,
  agentEvidence,
  bullBearArguments,
  debateRecords,
  agentRatings,
  riskGateResults,
  strategyRules,
  agentAuditLog,
  analysis,
  deepReport,
} from '@server/database/schema';
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
  AgentRunListQuery,
  AgentRunStatus,
  LatestRating,
  AgentRunWithRating,
} from '@shared/api.interface';
import { buildPipelineReport, normalizeAnalysisLanguage, safeAnalysisError, type AnalysisExecutionInfo } from './analysis-report';
import { SettingsService } from '../settings/settings.service';
import { parseModelRoute } from '../settings/model-route.rules';
import type { ModelRoute } from '../../../shared/model-route.interface';

/** Internal row shape for bulk evidence inserts (snake_case DB columns). */
interface EvidenceInsert {
  metadata: import('@shared/research-evidence.interface').EvidenceMetadata | null;
  runId: string;
  owner: string;
  createdBy: string;
  role: string;
  evidenceType: string;
  title: string;
  content: string;
  sourceUrl?: string | null;
  sourceName?: string | null;
  fetchedAt: Date;
  relevanceScore?: string | null;
}

@Injectable()
export class MultiAgentService {
  private readonly logger = new Logger(MultiAgentService.name);

  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    @Optional() private readonly settings?: SettingsService) {}

  /** Create a new run row in `pending` status. Does not start the pipeline. */
  async createRun(userId: string, dto: CreateAgentRunDto): Promise<AgentRun> {
    let language;
    try {
      language = normalizeAnalysisLanguage(dto.language);
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : 'Invalid analysis language');
    }
    const modelRoute = dto.modelRoute === undefined
      ? await this.settings?.getDefaultModelRoute(userId) ?? null
      : parseModelRoute(dto.modelRoute);
    const [row] = await this.db
      .insert(agentRuns)
      .values({
        ticker: dto.ticker,
        tickerName: dto.tickerName ?? null,
        market: dto.market ?? null,
        triggerType: dto.triggerType,
        runMode: dto.runMode ?? 'full',
        language,
        modelRoute,
        status: 'pending',
        owner: userId,
        createdBy: userId,
        updatedBy: userId,
      })
      .returning();
    return this.mapRun(row);
  }

  /** Update run status and/or human-decision metadata. Owner-scoped. */
  async updateRunStatus(
    userId: string,
    runId: string,
    status?: AgentRunStatus,
    extra?: Partial<UpdateAgentRunDto>
  ): Promise<AgentRun> {
    const patch: Record<string, unknown> = {};
    if (status !== undefined) patch.status = status;
    if (extra?.humanDecision !== undefined) patch.humanDecision = extra.humanDecision;
    if (extra?.humanNote !== undefined) patch.humanNote = extra.humanNote;

    if (Object.keys(patch).length === 0) {
      throw new BadRequestException('未提供可更新字段');
    }
    patch.updatedBy = userId;

    const [updated] = await this.db
      .update(agentRuns)
      .set(patch)
      .where(and(eq(agentRuns.id, runId), eq(agentRuns.owner, userId)))
      .returning();

    if (!updated) throw new NotFoundException('运行记录不存在');
    return this.mapRun(updated);
  }

  /**
   * Load a run plus all its sub-resources (evidence, arguments, debate,
   * rating, risk-gate results) in parallel. Throws NotFound if the run does
   * not exist or belongs to another user.
   */
  async getRun(userId: string, runId: string): Promise<AgentRunDetail> {
    const [runRow] = await this.db
      .select()
      .from(agentRuns)
      .where(and(eq(agentRuns.id, runId), eq(agentRuns.owner, userId)));

    if (!runRow) throw new NotFoundException('运行记录不存在');

    const [evidenceRows, argumentRows, debateRows, ratingRows, riskRows] = await Promise.all([
      this.db
        .select()
        .from(agentEvidence)
        .where(eq(agentEvidence.runId, runId))
        .orderBy(agentEvidence.createdAt),
      this.db
        .select()
        .from(bullBearArguments)
        .where(eq(bullBearArguments.runId, runId))
        .orderBy(bullBearArguments.round, bullBearArguments.side),
      this.db
        .select()
        .from(debateRecords)
        .where(eq(debateRecords.runId, runId))
        .orderBy(debateRecords.round, debateRecords.createdAt),
      this.db
        .select()
        .from(agentRatings)
        .where(and(eq(agentRatings.runId, runId), eq(agentRatings.owner, userId))),
      this.db
        .select()
        .from(riskGateResults)
        .where(eq(riskGateResults.runId, runId))
        .orderBy(riskGateResults.ruleName),
    ]);

    return {
      ...this.mapRun(runRow),
      evidence: evidenceRows.map((r) => this.mapEvidence(r)),
      arguments: argumentRows.map((r) => this.mapArgument(r)),
      debate: debateRows.map((r) => this.mapDebate(r)),
      rating: ratingRows.length > 0 ? this.mapRating(ratingRows[0]) : null,
      riskGate: riskRows.map((r) => this.mapRiskGate(r)),
    };
  }

  /**
   * Paginated list of runs, left-joined with the deep-report row for target
   * prices. Prefer listRunsWithRating (which also joins ratings).
   */
  async listRuns(userId: string, query: AgentRunListQuery): Promise<{ items: AgentRun[]; total: number }> {
    const conditions = [eq(agentRuns.owner, userId)];
    if (query.ticker) conditions.push(eq(agentRuns.ticker, query.ticker));
    if (query.status) conditions.push(eq(agentRuns.status, query.status));

    const limit = Math.min(query.limit ?? 20, 100);
    const offset = query.offset ?? 0;

    const [rows, countRows] = await Promise.all([
      this.db
        .select({
          run: agentRuns,
          targetBear: deepReport.targetBear,
          targetBase: deepReport.targetBase,
          targetBull: deepReport.targetBull,
          confidence: deepReport.confidence,
        })
        .from(agentRuns)
        .leftJoin(deepReport, eq(agentRuns.id, deepReport.runId))
        .where(and(...conditions))
        .orderBy(desc(agentRuns.createdAt))
        .limit(limit)
        .offset(offset),
      this.db
        .select({ count: sql<number>`count(*)` })
        .from(agentRuns)
        .where(and(...conditions)),
    ]);

    return {
      items: rows.map((r) => ({
        ...this.mapRun(r.run),
        targetBear: r.targetBear?.toString() ?? null,
        targetBase: r.targetBase?.toString() ?? null,
        targetBull: r.targetBull?.toString() ?? null,
        confidence: (r.confidence ?? null) as AgentRun['confidence'],
      })),
      total: Number(countRows[0]?.count ?? 0),
    };
  }

  /** Bulk-insert evidence rows for a run (owner-checked). */
  async addEvidence(userId: string, runId: string, items: CreateEvidenceDto[]): Promise<AgentEvidence[]> {
    const observedAt = new Date().toISOString();
    return this.insertEvidence(userId, runId, items.map(item => ({ ...item, metadata: { sources: [{
      origin: 'agent', verification: 'unverified', provider: null, kind: 'other', sourceUrl: item.sourceUrl ?? null,
      sourceRevision: null, supersedesSourceRevision: null, revisionReason: null, publishedAt: null, publicationPrecision: null,
      observedAt, observationBasis: 'server', facts: [] }] } })));
  }

  /** Internal deterministic collection path. The controller never accepts caller-supplied provider metadata. */
  async addProviderEvidence(userId: string, runId: string,
    items: Array<CreateEvidenceDto & { metadata?: import('@shared/research-evidence.interface').EvidenceMetadata }>): Promise<AgentEvidence[]> {
    return this.insertEvidence(userId, runId, items);
  }

  private async insertEvidence(userId: string, runId: string,
    items: Array<CreateEvidenceDto & { metadata?: import('@shared/research-evidence.interface').EvidenceMetadata }>): Promise<AgentEvidence[]> {
    await this.ensureRunOwner(userId, runId);
    if (items.length === 0) return [];

    const values = items.map((it): EvidenceInsert => ({
      runId,
      owner: userId,
      createdBy: userId,
      role: it.role,
      evidenceType: it.evidenceType,
      title: it.title,
      content: it.content,
      sourceUrl: it.sourceUrl ?? null,
      sourceName: it.sourceName ?? null,
      fetchedAt: new Date(it.fetchedAt),
      relevanceScore: it.relevanceScore !== undefined ? String(it.relevanceScore) : null,
      metadata: it.metadata ?? null,
    }));

    const inserted = await this.db.insert(agentEvidence).values(values).returning();
    return inserted.map((r) => this.mapEvidence(r));
  }

  /** Insert one bull/bear argument row (owner-checked). */
  async addArgument(userId: string, runId: string, dto: CreateArgumentDto): Promise<BullBearArgument> {
    await this.ensureRunOwner(userId, runId);

    const evidenceIds = dto.evidenceIds;
    if (!Array.isArray(evidenceIds) || evidenceIds.length === 0
      || evidenceIds.some((id) => typeof id !== 'string')
      || new Set(evidenceIds).size !== evidenceIds.length) {
      throw new BadRequestException('Argument requires distinct evidence IDs from this run');
    }
    const validEvidence = await this.db
      .select({ id: agentEvidence.id, sourceName: agentEvidence.sourceName, relevanceScore: agentEvidence.relevanceScore })
      .from(agentEvidence)
      .where(and(
        eq(agentEvidence.runId, runId),
        eq(agentEvidence.owner, userId),
        inArray(agentEvidence.id, evidenceIds),
      ));
    if (validEvidence.length !== evidenceIds.length || validEvidence.some((row) =>
      row.sourceName === 'Data Unavailable' || Number(row.relevanceScore ?? 0) <= 0)) {
      throw new BadRequestException('Argument cites missing or unavailable evidence');
    }

    const [row] = await this.db
      .insert(bullBearArguments)
      .values({
        runId,
        side: dto.side,
        round: dto.round ?? 1,
        argument: dto.argument,
        evidenceIds,
        counteredBy: dto.counteredBy ?? null,
        owner: userId,
        createdBy: userId,
      })
      .returning();

    return this.mapArgument(row);
  }

  /** Insert one debate turn row (owner-checked). */
  async addDebateRecord(userId: string, runId: string, dto: CreateDebateRecordDto): Promise<DebateRecord> {
    await this.ensureRunOwner(userId, runId);

    const [row] = await this.db
      .insert(debateRecords)
      .values({
        runId,
        round: dto.round,
        speaker: dto.speaker,
        content: dto.content,
        tokensUsed: dto.tokensUsed ?? 0,
        owner: userId,
        createdBy: userId,
      })
      .returning();

    return this.mapDebate(row);
  }

  /**
   * Upsert the rating for a run. If a rating row already exists for this
   * (runId, owner), it is updated in place; otherwise a new row is inserted.
   * Called by the pipeline (Phase 5) and by the human-modified path.
   */
  async saveRating(userId: string, runId: string, dto: CreateAgentRatingDto): Promise<AgentRatingRecord> {
    await this.ensureRunOwner(userId, runId);

    const existing = await this.db
      .select()
      .from(agentRatings)
      .where(and(eq(agentRatings.runId, runId), eq(agentRatings.owner, userId)));

    if (existing.length > 0) {
      const [updated] = await this.db
        .update(agentRatings)
        .set({
          ticker: dto.ticker,
          rating: dto.rating,
          confidence: dto.confidence,
          targetPrice: dto.targetPrice !== undefined ? String(dto.targetPrice) : null,
          action: dto.action,
          aggregationLogic: dto.aggregationLogic ?? null,
          keyUncertainty: dto.keyUncertainty ?? null,
          bullSummary: dto.bullSummary ?? null,
          bearSummary: dto.bearSummary ?? null,
          catalysts: dto.catalysts ?? null,
          risks: dto.risks ?? null,
          updatedBy: userId,
        })
        .where(eq(agentRatings.id, existing[0].id))
        .returning();
      return this.mapRating(updated);
    }

    const [row] = await this.db
      .insert(agentRatings)
      .values({
        runId,
        ticker: dto.ticker,
        rating: dto.rating,
        confidence: dto.confidence,
        targetPrice: dto.targetPrice !== undefined ? String(dto.targetPrice) : null,
        action: dto.action,
        aggregationLogic: dto.aggregationLogic ?? null,
        keyUncertainty: dto.keyUncertainty ?? null,
        bullSummary: dto.bullSummary ?? null,
        bearSummary: dto.bearSummary ?? null,
        catalysts: dto.catalysts ?? null,
        risks: dto.risks ?? null,
        owner: userId,
        createdBy: userId,
        updatedBy: userId,
      })
      .returning();

    return this.mapRating(row);
  }

  /** Bulk-insert evaluated risk-gate results for a run (owner-checked). */
  async saveRiskGateResults(userId: string, runId: string, items: CreateRiskGateDto[]): Promise<RiskGateResult[]> {
    await this.ensureRunOwner(userId, runId);
    if (items.length === 0) return [];

    const values = items.map((it) => ({
      runId,
      ruleName: it.ruleName,
      ruleType: it.ruleType,
      passed: it.passed,
      currentValue: it.currentValue != null ? String(it.currentValue) : null,
      thresholdValue: it.thresholdValue != null ? String(it.thresholdValue) : null,
      detail: it.detail ?? null,
      suggestedAction: it.suggestedAction ?? null,
      owner: userId,
      createdBy: userId,
    }));

    const inserted = await this.db.insert(riskGateResults).values(values).returning();
    return inserted.map((r) => this.mapRiskGate(r));
  }

  /**
   * List the caller's strategy rules. If the user has no rules yet, seedDefault
   * is called automatically so the pipeline always has rules to evaluate.
   */
  async getStrategyRules(userId: string): Promise<StrategyRule[]> {
    const rows = await this.db
      .select()
      .from(strategyRules)
      .where(eq(strategyRules.owner, userId))
      .orderBy(strategyRules.sort, strategyRules.ruleKey);

    if (rows.length === 0) {
      return this.seedDefaultRules(userId);
    }

    return rows.map((r) => this.mapStrategyRule(r));
  }

  /** Create a new strategy rule; rejects duplicate ruleKey per user. */
  async createStrategyRule(
    userId: string,
    dto: CreateStrategyRuleDto,
  ): Promise<StrategyRule> {
    const [existing] = await this.db
      .select({ id: strategyRules.id })
      .from(strategyRules)
      .where(
        and(
          eq(strategyRules.owner, userId),
          eq(strategyRules.ruleKey, dto.ruleKey),
        ),
      );
    if (existing) {
      throw new BadRequestException('规则 Key 已存在');
    }

    const [inserted] = await this.db
      .insert(strategyRules)
      .values({
        ruleKey: dto.ruleKey,
        ruleName: dto.ruleName,
        ruleType: dto.ruleType,
        threshold: dto.threshold !== undefined ? String(dto.threshold) : null,
        unit: dto.unit ?? null,
        description: dto.description ?? null,
        category: dto.category ?? null,
        severity: dto.severity ?? 'warning',
        sort: dto.sort ?? 0,
        enabled: true,
        owner: userId,
        createdBy: userId,
        updatedBy: userId,
      })
      .returning();

    return this.mapStrategyRule(inserted);
  }

  /** Partially update a strategy rule. */
  async updateStrategyRule(userId: string, ruleId: string, dto: UpdateStrategyRuleDto): Promise<StrategyRule> {
    const patch: Record<string, unknown> = {};
    if (dto.ruleName !== undefined) patch.ruleName = dto.ruleName;
    if (dto.ruleType !== undefined) patch.ruleType = dto.ruleType;
    if (dto.threshold !== undefined) patch.threshold = String(dto.threshold);
    if (dto.unit !== undefined) patch.unit = dto.unit;
    if (dto.enabled !== undefined) patch.enabled = dto.enabled;
    if (dto.description !== undefined) patch.description = dto.description;
    if (dto.category !== undefined) patch.category = dto.category;
    if (dto.severity !== undefined) patch.severity = dto.severity;
    if (dto.sort !== undefined) patch.sort = dto.sort;

    if (Object.keys(patch).length === 0) {
      throw new BadRequestException('未提供可更新字段');
    }

    const [updated] = await this.db
      .update(strategyRules)
      .set(patch)
      .where(and(eq(strategyRules.id, ruleId), eq(strategyRules.owner, userId)))
      .returning();

    if (!updated) throw new NotFoundException('规则不存在');
    return this.mapStrategyRule(updated);
  }

  /** Delete a strategy rule (owner-scoped). */
  async deleteStrategyRule(userId: string, ruleId: string): Promise<void> {
    const deleted = await this.db
      .delete(strategyRules)
      .where(
        and(eq(strategyRules.id, ruleId), eq(strategyRules.owner, userId)),
      )
      .returning({ id: strategyRules.id });
    if (deleted.length === 0) throw new NotFoundException('规则不存在');
  }

  /**
   * Bulk-update sort order for rules. Done one UPDATE per item (not a single
   * transaction) — acceptable because reorder is a low-frequency admin action.
   */
  async reorderStrategyRules(
    userId: string,
    items: ReorderStrategyRuleDto[],
  ): Promise<number> {
    let count = 0;
    for (const item of items) {
      const [updated] = await this.db
        .update(strategyRules)
        .set({ sort: item.sort })
        .where(
          and(
            eq(strategyRules.id, item.id),
            eq(strategyRules.owner, userId),
          ),
        )
        .returning({ id: strategyRules.id });
      if (updated) count += 1;
    }
    return count;
  }

  /** Delete all caller's rules and reseed with the default set. */
  async resetDefaultStrategyRules(userId: string): Promise<StrategyRule[]> {
    await this.db
      .delete(strategyRules)
      .where(eq(strategyRules.owner, userId));
    return this.seedDefaultRules(userId);
  }

  /** Fetch the deep-dive report for a run (owner-checked), or null if none. */
  async getDeepReport(
    userId: string,
    runId: string,
  ): Promise<DeepReport | null> {
    await this.ensureRunOwner(userId, runId);
    const rows = await this.db
      .select()
      .from(deepReport)
      .where(eq(deepReport.runId, runId));
    if (rows.length === 0) return null;
    return this.mapDeepReport(rows[0]);
  }

  /** Persist only the actual evidence, published analysis and risk results of this run. */
  async savePipelineReport(
    userId: string,
    runId: string,
    engine: 'basic' | 'llm',
    execution: AnalysisExecutionInfo | null,
  ): Promise<void> {
    const detail = await this.getRun(userId, runId);
    const content = buildPipelineReport(detail, engine, execution);
    await this.db.insert(deepReport).values({ runId, owner: userId, createdBy: userId, updatedBy: userId, ...content })
      .onConflictDoUpdate({ target: deepReport.runId, set: { ...content, updatedBy: userId, updatedAt: new Date() } });
  }

  /** Retry only failed, report-less work; published reports and user notes are never removed. */
  async resetFailedRunArtifacts(userId: string, runId: string): Promise<void> {
    const run = await this.getRun(userId, runId);
    if (run.status !== 'failed') throw new BadRequestException('Only failed analysis can be retried');
    const reports = await this.db.select({ id: deepReport.id }).from(deepReport)
      .where(and(eq(deepReport.runId, runId), eq(deepReport.owner, userId)));
    if (reports.length) throw new BadRequestException('A report already exists; start a new analysis');
    await this.db.transaction(async (tx) => {
      for (const table of [bullBearArguments, debateRecords, riskGateResults, agentRatings, agentEvidence]) {
        await tx.delete(table).where(and(eq(table.runId, runId), eq(table.owner, userId)));
      }
    });
  }

  /**
   * Developer/demo endpoint: write a hard-coded Xiaomi (1810.HK) sample deep
   * report into the DB (upsert on runId). Lets the UI render the full
   * deep-report view without running the LLM pipeline.
   */
  async generateSampleDeepReport(userId: string, runId: string): Promise<DeepReport> {
    const [runRow] = await this.db
      .select({ ticker: agentRuns.ticker, tickerName: agentRuns.tickerName })
      .from(agentRuns)
      .where(and(eq(agentRuns.id, runId), eq(agentRuns.owner, userId)));

    if (!runRow) throw new NotFoundException('运行记录不存在');

    const ticker = runRow.ticker || '01810.HK';
    const tickerName = runRow.tickerName || '小米集团';

    const bullPoints = [
      {
        title: '人车家全生态闭环持续强化',
        detail: '小米手机 × AIoT × 汽车形成三引擎协同，用户账户体系打通后变现效率显著提升。2024年AIoT连接设备数突破7亿，米家APP月活超8000万，生态用户ARPU值同比增长18%。',
        evidenceIds: ['ev-bull-1', 'ev-bull-2'],
      },
      {
        title: '智能手机高端化突破',
        detail: '小米14系列及小米15 Ultra在4000-6000元价位段站稳脚跟，全球高端机市占率从2022年的3.5%提升至2024年的6.8%。徕卡联名与自研芯片逐步建立品牌溢价。',
        evidenceIds: ['ev-bull-3'],
      },
      {
        title: '电动汽车业务超预期放量',
        detail: 'SU7系列上市8个月交付超15万辆，SU7 Ultra性能版在细分市场市占率超30%。YU7 SUV将于2025Q1上市，预计年销量目标30万辆，毛利率有望达到15%+。',
        evidenceIds: ['ev-bull-4', 'ev-bull-5'],
      },
      {
        title: 'AI 大模型端侧化先发优势',
        detail: '小爱同学大模型日活破亿，端侧AI助手在手机、汽车、智能家居多端协同。自研MiLM在中文榜单排名前五，端侧部署成本仅云端的1/10。',
        evidenceIds: ['ev-bull-6'],
      },
      {
        title: '全球新兴市场份额持续扩张',
        detail: '在印度、东南亚、中东、拉美市场份额保持Top 3，印度市占率重回第一（22%）。非洲和东欧成为新增长极，新兴市场收入占比超55%。',
        evidenceIds: ['ev-bull-7'],
      },
    ];

    const bearPoints = [
      {
        title: '中国智能手机市场饱和，总量承压',
        detail: '国内智能手机年出货量从峰值4.5亿台降至约2.8亿台，行业进入存量换机周期。小米国内市占率约13%，提升空间有限，单价提升是唯一增长来源。',
        evidenceIds: ['ev-bear-1'],
      },
      {
        title: '汽车业务前期投入大，盈利尚远',
        detail: '造车业务已累计投入超300亿元，2024年汽车业务亏损约80亿元。初期产能爬坡慢，供应链议价能力弱，盈利时间点可能晚于管理层指引。',
        evidenceIds: ['ev-bear-2', 'ev-bear-3'],
      },
      {
        title: '地缘政治风险与海外监管压力',
        detail: '印度税务调查、美国出口管制、欧盟数字市场法案（DMA）等多重风险叠加。若美国进一步限制芯片供应，高端手机业务可能受重大冲击。',
        evidenceIds: ['ev-bear-4'],
      },
      {
        title: 'AIoT 业务增长放缓，利润率偏低',
        detail: 'AIoT收入增速从30%+降至10-15%区间，白电品类竞争激烈（与美的、格力正面竞争），电视业务利润率持续受压。生态变现模式仍在探索。',
        evidenceIds: ['ev-bear-5'],
      },
    ];

    const criticPoints = [
      {
        originalClaim: '汽车业务2025年即可实现盈亏平衡',
        critique: '管理层指引过于乐观。参考新势力车企经验，从年销15万辆到盈亏平衡通常需要2-3年。小米汽车首款车型SU7定价偏低（起售价21.59万），单车毛利预计不足10%。',
        resolved: false,
        revision: '预计汽车业务盈亏平衡时间点推迟至2026年底-2027年，年销量需达到50万辆以上。',
      },
      {
        originalClaim: '高端机战略将持续提升整体毛利率',
        critique: '高端化确实提升了ASP，但高端机研发和营销费用同步上升，对净利润的拉动效应弱于收入端。且高端用户对价格敏感度低但对品质要求极高，返修率和售后成本更高。',
        resolved: true,
        revision: '综合毛利率提升幅度预计为2-3个百分点（而非市场预期的5个点），主要靠规模效应而非产品结构升级。',
      },
      {
        originalClaim: 'AI大模型将成为新的增长曲线',
        critique: '当前AI大模型对小米的价值更多是体验优化而非直接变现。小爱同学虽日活高但付费转化率不足1%，AI驱动的增值服务收入占比仍低于2%，商业化路径尚不清晰。',
        resolved: false,
        revision: 'AI更多是成本项和护城河要素，而非独立收入来源。对估值的贡献应反映在用户留存和生态粘性上，不宜单独给予高估值溢价。',
      },
    ];

    const catalystsTimeline = [
      { date: '2025-03-15', title: '小米15 Ultra全球发布', type: 'product' as const, impact: 'positive' as const, detail: '徕卡Summilux镜头+自研ISP芯片，预计冲击高端影像旗舰市场，目标月销50万台。' },
      { date: '2025-04-20', title: 'YU7 SUV正式上市', type: 'product' as const, impact: 'positive' as const, detail: '小米第二款车型，定位中大型纯电SUV，预计售价25-35万，对标特斯拉Model Y。' },
      { date: '2025-05-31', title: '2025Q1财报发布', type: 'earnings' as const, impact: 'positive' as const, detail: '汽车交付量首次完整季度披露，关注毛利率与费用率变化。' },
      { date: '2025-07-10', title: '小米开发者大会', type: 'product' as const, impact: 'positive' as const, detail: '预计发布MiLM 3.0大模型及端侧AI战略升级，可能发布首款AI原生硬件产品。' },
      { date: '2025-09-01', title: '印度市场反垄断调查结果', type: 'policy' as const, impact: 'negative' as const, detail: '印度CCI对小米的反垄断调查若裁决不利，可能面临大额罚款或业务限制。' },
      { date: '2025-11-15', title: '小米16系列发布', type: 'product' as const, impact: 'positive' as const, detail: '年度旗舰迭代，预计搭载骁龙8 Gen 5和更成熟的端侧AI能力。' },
    ];

    const riskItems = [
      { risk: '中美科技摩擦加剧，高端芯片供应中断', probability: 'medium' as const, impact: 'high' as const, mitigation: '增加联发科、紫光展锐等备选供应链占比；加大自研芯片投入；建立关键零部件安全库存。' },
      { risk: '电动汽车业务竞争加剧，价格战恶化', probability: 'high' as const, impact: 'high' as const, mitigation: '聚焦差异化（智能驾驶、生态互联）；控制产能扩张节奏；强化成本管控和供应链垂直整合。' },
      { risk: '印度等海外市场监管政策突变', probability: 'medium' as const, impact: 'medium' as const, mitigation: '分散新兴市场布局；强化合规团队；与当地政府保持良好沟通；合理安排利润汇回。' },
      { risk: '消费电子需求持续疲软', probability: 'medium' as const, impact: 'medium' as const, mitigation: '拓展汽车等新增长曲线；提升高端产品占比；优化库存管理和供应链弹性。' },
      { risk: 'AI大模型技术路线快速迭代导致落后', probability: 'low' as const, impact: 'medium' as const, mitigation: '保持研发高强度投入；与顶级AI实验室建立合作；建立敏捷迭代的工程体系。' },
    ];

    const riskGateSnapshot = [
      { id: 'rg-1', runId, ruleName: '单一公司合并敞口上限', ruleType: 'hard', passed: true, currentValue: '8.5', thresholdValue: '25', detail: '当前小米占组合权重8.5%，低于25%上限', suggestedAction: '通过' },
      { id: 'rg-2', runId, ruleName: '单只股票权重上限', ruleType: 'soft', passed: true, currentValue: '8.5', thresholdValue: '10', detail: '接近建议上限，需关注后续加仓节奏', suggestedAction: '关注' },
      { id: 'rg-3', runId, ruleName: '亏损股合计上限', ruleType: 'hard', passed: false, currentValue: '12', thresholdValue: '10', detail: '小米汽车业务仍处亏损期，整体盈利质量偏弱', suggestedAction: '控制仓位' },
      { id: 'rg-4', runId, ruleName: '行业敞口上限', ruleType: 'soft', passed: false, currentValue: '32', thresholdValue: '30', detail: '科技+消费电子合计敞口32%，略超30%建议上限', suggestedAction: '适度分散' },
      { id: 'rg-5', runId, ruleName: '个股回撤强制重检', ruleType: 'hard', passed: true, currentValue: '-12', thresholdValue: '-20', detail: '较建仓成本下跌12%，尚未触发强制重检线', suggestedAction: '通过' },
      { id: 'rg-6', runId, ruleName: '个股止损线', ruleType: 'soft', passed: true, currentValue: '-12', thresholdValue: '-25', detail: '距离止损线尚有空间', suggestedAction: '通过' },
      { id: 'rg-7', runId, ruleName: '建仓前必过清单', ruleType: 'hard', passed: true, currentValue: '5', thresholdValue: '5', detail: '基本面评分、行业地位、估值分位、催化剂、风险点5项全部完成', suggestedAction: '通过' },
      { id: 'rg-8', runId, ruleName: '建仓节奏', ruleType: 'soft', passed: false, currentValue: '2', thresholdValue: '3', detail: '建议分3次以上建仓，当前仅完成2次', suggestedAction: '分批建仓' },
    ];

    const revenueStructure = [
      { segment: '智能手机', revenue: '2200', sharePct: '58', yoyPct: '8.5' },
      { segment: 'AIoT与生活消费产品', revenue: '780', sharePct: '20.5', yoyPct: '12.3' },
      { segment: '互联网服务', revenue: '320', sharePct: '8.4', yoyPct: '6.2' },
      { segment: '电动汽车', revenue: '380', sharePct: '10', yoyPct: 'N/A' },
      { segment: '其他及创新业务', revenue: '120', sharePct: '3.1', yoyPct: '15.8' },
    ];

    const segmentAnalysis = [
      { name: '智能手机', revenue: '2200', grossMargin: '15.2', growthPct: '8.5', outlook: '高端化持续推进，预计2025年ASP提升10%+，毛利率有望提升至17%' },
      { name: 'AIoT与生活消费产品', revenue: '780', grossMargin: '18.5', growthPct: '12.3', outlook: '白电品类快速增长，大家电贡献提升，整体毛利率稳中有升' },
      { name: '互联网服务', revenue: '320', grossMargin: '68.2', growthPct: '6.2', outlook: '广告与游戏增长稳健，金融科技受监管影响增速放缓' },
      { name: '电动汽车', revenue: '380', grossMargin: '5.8', growthPct: 'N/A', outlook: '产能爬坡期，规模效应下毛利率将逐步改善，目标2026年达到15%' },
      { name: '其他及创新业务', revenue: '120', grossMargin: '22.1', growthPct: '15.8', outlook: '机器人、芯片等前沿业务投入期，短期贡献有限但长期战略价值高' },
    ];

    const financialAnnual = [
      { period: '2022A', revenue: '2801', netProfit: '85', revenueYoy: '-14.7', profitYoy: '-61.4' },
      { period: '2023A', revenue: '2710', netProfit: '172', revenueYoy: '-3.2', profitYoy: '102.4' },
      { period: '2024A', revenue: '3450', netProfit: '235', revenueYoy: '27.3', profitYoy: '36.6' },
      { period: '2025E', revenue: '4200', netProfit: '268', revenueYoy: '21.7', profitYoy: '14.0' },
    ];

    const financialQuarterly = [
      { period: '2024Q1', revenue: '768', netProfit: '54', revenueYoy: '18.5', profitYoy: '42.1' },
      { period: '2024Q2', revenue: '820', netProfit: '62', revenueYoy: '22.3', profitYoy: '38.7' },
      { period: '2024Q3', revenue: '895', netProfit: '58', revenueYoy: '32.1', profitYoy: '18.4' },
      { period: '2024Q4', revenue: '967', netProfit: '61', revenueYoy: '30.5', profitYoy: '2.1' },
    ];

    const profitability = [
      { metric: '毛利率', value: '16.8', ttm: '16.2', industry: '19.5' },
      { metric: '净利率', value: '6.8', ttm: '6.5', industry: '5.2' },
      { metric: 'ROE', value: '14.2', ttm: '13.8', industry: '11.5' },
      { metric: 'ROA', value: '5.8', ttm: '5.5', industry: '4.2' },
      { metric: 'ROIC', value: '11.5', ttm: '11.0', industry: '9.3' },
      { metric: '营业利润率', value: '8.2', ttm: '7.9', industry: '6.8' },
      { metric: '费用率', value: '8.6', ttm: '8.8', industry: '12.3' },
      { metric: '研发费用率', value: '5.1', ttm: '4.8', industry: '4.2' },
    ];

    const balanceSheet = [
      { item: '现金及现金等价物', value: '1280', note: '人民币亿元' },
      { item: '短期投资', value: '620', note: '主要为定期存款及理财' },
      { item: '应收账款', value: '210', note: '周转天数约28天' },
      { item: '存货', value: '380', note: '周转天数约45天' },
      { item: '固定资产', value: '420', note: '含汽车工厂及研发设备' },
      { item: '商誉', value: '85', note: '主要来自生态链投资' },
      { item: '短期借款', value: '180', note: '人民币计价' },
      { item: '长期借款', value: '320', note: '含绿色债券' },
      { item: '净资产', value: '1850', note: '归属于母公司股东权益' },
    ];

    const cashFlow = [
      { item: '经营活动现金流净额', value: '385', note: '2024年全年，同比+25%' },
      { item: '投资活动现金流净额', value: '-520', note: '主要为汽车及芯片研发投入' },
      { item: '筹资活动现金流净额', value: '120', note: '发行绿色债券及银行贷款' },
      { item: '自由现金流', value: '185', note: '经营现金流-资本开支' },
      { item: '资本开支', value: '200', note: '含汽车工厂、研发设备等' },
    ];

    const valuationRelative = [
      { metric: 'PE (TTM)', current: '22.5', percentile5y: '65', industryAvg: '18.2', note: '处于历史偏高分位，反映汽车业务增长预期' },
      { metric: 'PB', current: '2.8', percentile5y: '45', industryAvg: '2.5', note: '接近历史中位，估值相对合理' },
      { metric: 'PS (TTM)', current: '1.45', percentile5y: '58', industryAvg: '1.20', note: '略高于行业平均，考虑生态溢价可接受' },
      { metric: 'EV/EBITDA', current: '15.8', percentile5y: '52', industryAvg: '13.5', note: '含汽车业务亏损影响，调整后约12x' },
      { metric: 'PEG', current: '0.95', percentile5y: '-', industryAvg: '1.10', note: 'PEG低于1，估值与增速匹配度较好' },
      { metric: '自由现金流收益率', current: '4.2', percentile5y: '70', industryAvg: '3.5', note: 'FCF收益率高于行业，现金流质量较好' },
    ];

    const valuationSotp = [
      { segment: '智能手机业务', valuation: '2800', method: 'PE估值', multiple: '15x' },
      { segment: 'AIoT与互联网服务', valuation: '2200', method: '分部加总', multiple: '20x' },
      { segment: '电动汽车业务', valuation: '1500', method: 'PS估值', multiple: '2.5x' },
      { segment: '投资与现金', valuation: '1800', method: '账面价值', multiple: '-' },
      { segment: '合计（含协同效应）', valuation: '8500', method: 'SOTP加总', multiple: '-' },
    ];

    const trackingMetrics = [
      { metric: '全球智能手机市占率', threshold: '16%', direction: 'above' as const, frequency: '季度' },
      { metric: '汽车月交付量', threshold: '20000辆', direction: 'above' as const, frequency: '月度' },
      { metric: '汽车业务毛利率', threshold: '10%', direction: 'above' as const, frequency: '季度' },
      { metric: 'AIoT连接设备数', threshold: '8亿', direction: 'above' as const, frequency: '季度' },
      { metric: '互联网服务ARPU', threshold: '50元', direction: 'above' as const, frequency: '季度' },
      { metric: '经营现金流净额', threshold: '300亿', direction: 'above' as const, frequency: '年度' },
    ];

    const [upserted] = await this.db
      .insert(deepReport)
      .values({
        runId,
        ticker,
        rating: 'Buy',
        confidence: 'high',
        targetBear: '18.50',
        targetBase: '28.00',
        targetBull: '38.00',
        probBear: '0.20',
        probBase: '0.55',
        probBull: '0.25',
        coreThesis: `小米集团正处于从"消费电子公司"向"人车家全生态科技公司"战略跃迁的关键阶段。手机业务高端化突破验证了品牌升级能力，AIoT生态持续强化用户粘性，电动汽车业务打开第二增长曲线。当前估值尚未充分反映汽车业务的长期价值和生态协同效应，给予买入评级，目标价28港元（对应2025E 25x PE）。`,
        viewChange: '首次覆盖，给予买入评级',
        prevRating: null,
        companyOverview: `${tickerName}（${ticker}）成立于2010年，2018年在港交所主板上市。公司以智能手机为核心，逐步拓展至AIoT、互联网服务、智能电动汽车等领域，形成"手机×AIoT×汽车"全生态战略布局。截至2024年底，公司全球员工超3.5万人，业务覆盖全球100多个国家和地区，是全球第三大智能手机厂商、全球最大消费级AIoT平台之一。`,
        businessModel: '小米的商业模式以"感动人心、价格厚道"为核心理念，通过硬件引流+互联网变现+生态协同构建飞轮效应。智能手机作为流量入口，以接近成本的定价获取大规模用户；通过MIUI/澎湃OS系统和米家生态沉淀用户数据和粘性；互联网服务（广告、游戏、金融科技等）贡献高毛利收入；汽车业务作为新增长曲线，进一步拓展生态边界。公司坚持"5%综合净利率红线"，将大部分价值让渡给用户，以换取规模效应和生态壁垒。',
        moat: '小米的护城河主要来自四个维度：1）规模效应：全球第三大手机厂商带来的供应链议价能力和研发投入摊薄；2）生态网络效应：7亿+AIoT连接设备形成的用户粘性和数据壁垒，设备越多体验越好；3）品牌心智：在大众市场建立了"高品质、高性价比"的强品牌认知；4）软件与服务：澎湃OS打通手机、汽车、家居多端，形成统一账户体系和服务生态。但需注意，小米的护城河相比苹果生态仍有差距，硬件差异化不足，用户迁移成本中等。',
        revenueStructure: revenueStructure as unknown as Record<string, unknown>,
        financialAnnual: financialAnnual as unknown as Record<string, unknown>,
        financialQuarterly: financialQuarterly as unknown as Record<string, unknown>,
        profitability: profitability as unknown as Record<string, unknown>,
        balanceSheet: balanceSheet as unknown as Record<string, unknown>,
        cashFlow: cashFlow as unknown as Record<string, unknown>,
        financialQuality: '整体财务质量良好。资产负债率约55%，处于行业中等水平；现金储备充裕（现金+短投超1900亿），流动性风险低。经营现金流持续为正且增速快于净利润，盈利质量较高。需关注汽车业务投入带来的资本开支压力和潜在亏损扩大风险。应收账款周转天数28天、存货周转天数45天，运营效率在消费电子行业处于优秀水平。',
        segmentAnalysis: segmentAnalysis as unknown as Record<string, unknown>,
        valuationRelative: valuationRelative as unknown as Record<string, unknown>,
        valuationSotp: valuationSotp as unknown as Record<string, unknown>,
        valuationMethodology: '采用分部估值法（SOTP）：1）智能手机业务按15x PE估值（参考全球消费电子龙头平均，考虑高端化溢价）；2）AIoT+互联网服务按20x PE估值（高毛利、高粘性，给予生态溢价）；3）电动汽车业务按2.5x PS估值（参考新势力车企，考虑小米品牌和生态优势）；4）投资与现金按账面价值计入。目标总市值约8500亿港元，对应每股约34港元（已考虑股权稀释）。综合相对估值和绝对估值，给予目标价28港元，对应2025E PE约25x。',
        industryOverview: '全球消费电子行业处于成熟周期后段，总量增长放缓但结构性机会显著。智能手机年出货量约12亿台，5G换机和AI手机是主要驱动力。AIoT市场快速增长，全球智能家居市场规模超1500亿美元，年复合增长率约15%。智能电动汽车处于渗透率快速提升期，全球新能源汽车渗透率已超20%，中国市场超35%，但行业竞争加剧，价格战持续。整体来看，小米所处的赛道既有成熟市场的稳健性，又有新兴领域的成长性。',
        marketSize: '全球智能手机市场规模约5000亿美元；全球AIoT/智能家居市场约1500亿美元，预计2028年达2800亿美元（CAGR 15%）；全球新能源汽车市场约8000亿美元，预计2028年达1.5万亿美元（CAGR 14%）。小米三大核心赛道合计市场空间超1.5万亿美元，长期成长空间充足。',
        competitivePosition: '智能手机：全球第三（市占率约13%），仅次于三星和苹果；中国市场第四（约13%），位于荣耀、OPPO、vivo之后。AIoT：全球最大消费级AIoT平台，连接设备数超7亿，遥遥领先于竞争对手。电动汽车：新势力第二梯队头部位置，首款车型SU7月交付稳定在1.5-2万辆，仅次于特斯拉、比亚迪、理想。整体来看，小米在手机和AIoT领域具备明确的竞争优势，汽车业务仍处于追赶阶段但起点较高。',
        industryTrends: '1）AI赋能：生成式AI正在重塑消费电子体验，端侧大模型成为智能手机新卖点，AI手机渗透率快速提升；2）融合加速：手机、汽车、家居的边界日益模糊，多端协同和生态化成为竞争焦点；3）供应链重构：地缘政治推动全球供应链多元化，印度、东南亚成为新制造中心；4）软件定义：硬件同质化背景下，软件和服务的重要性持续上升，订阅制模式逐步渗透；5）出海深化：中国科技企业全球化从产品出海走向品牌出海和技术出海。',
        bullPoints: bullPoints as unknown as Record<string, unknown>,
        bearPoints: bearPoints as unknown as Record<string, unknown>,
        criticPoints: criticPoints as unknown as Record<string, unknown>,
        revisedAssumptions: '经批判性分析，修正以下关键假设：1）汽车业务盈亏平衡点从2025年底推迟至2026年底-2027年；2）综合毛利率提升幅度从5pct下调至2-3pct；3）AI业务暂不单独给予估值溢价，仅作为生态护城河要素。修正后目标价从32港元下调至28港元，维持买入评级。',
        catalystsTimeline: catalystsTimeline as unknown as Record<string, unknown>,
        riskItems: riskItems as unknown as Record<string, unknown>,
        riskGateSnapshot: riskGateSnapshot as unknown as Record<string, unknown>,
        pmAction: '买入',
        pmPriceRange: '22-25港元为理想建仓区间；28-32港元持有观望；35港元以上考虑分批止盈',
        pmPositionSize: '建议仓位5-8%，不超过10%；若跌至20港元以下可考虑加仓至10%',
        pmStopLoss: '硬止损：跌破18港元（较目标价下跌35%）止损；软止损：基本面恶化（汽车月销跌破1万、手机市占率跌破10%）触发重估',
        pmExecutionPlan: '分3-4次建仓，首次建仓3%，若下跌5%加仓2%，再下跌5%再加仓2%。持有期间跟踪月度交付数据、季度财报和行业数据。重要催化剂前可适度增配，利好兑现后减回基准仓位。每季度复盘一次投资逻辑，若核心假设发生重大变化则调整评级。',
        trackingMetrics: trackingMetrics as unknown as Record<string, unknown>,
        viewChangeTriggers: '【上调评级触发】1）汽车月交付量稳定突破3万辆；2）汽车毛利率转正并达到10%以上；3）高端机市占率突破10%；4）AI服务付费率突破5%。【下调评级触发】1）汽车月交付量跌破1万辆；2）智能手机市占率跌破10%；3）出现重大地缘政治事件（如美国全面制裁）；4）核心管理层发生重大变动。',
        owner: userId,
      })
      .onConflictDoUpdate({
        target: deepReport.runId,
        set: {
          ticker,
          rating: 'Buy',
          confidence: 'high',
          targetBear: '18.50',
          targetBase: '28.00',
          targetBull: '38.00',
          probBear: '0.20',
          probBase: '0.55',
          probBull: '0.25',
          coreThesis: `小米集团正处于从"消费电子公司"向"人车家全生态科技公司"战略跃迁的关键阶段。手机业务高端化突破验证了品牌升级能力，AIoT生态持续强化用户粘性，电动汽车业务打开第二增长曲线。当前估值尚未充分反映汽车业务的长期价值和生态协同效应，给予买入评级，目标价28港元（对应2025E 25x PE）。`,
          viewChange: '首次覆盖，给予买入评级',
          companyOverview: `${tickerName}（${ticker}）成立于2010年，2018年在港交所主板上市。公司以智能手机为核心，逐步拓展至AIoT、互联网服务、智能电动汽车等领域，形成"手机×AIoT×汽车"全生态战略布局。截至2024年底，公司全球员工超3.5万人，业务覆盖全球100多个国家和地区，是全球第三大智能手机厂商、全球最大消费级AIoT平台之一。`,
          businessModel: '小米的商业模式以"感动人心、价格厚道"为核心理念，通过硬件引流+互联网变现+生态协同构建飞轮效应。智能手机作为流量入口，以接近成本的定价获取大规模用户；通过MIUI/澎湃OS系统和米家生态沉淀用户数据和粘性；互联网服务（广告、游戏、金融科技等）贡献高毛利收入；汽车业务作为新增长曲线，进一步拓展生态边界。公司坚持"5%综合净利率红线"，将大部分价值让渡给用户，以换取规模效应和生态壁垒。',
          moat: '小米的护城河主要来自四个维度：1）规模效应：全球第三大手机厂商带来的供应链议价能力和研发投入摊薄；2）生态网络效应：7亿+AIoT连接设备形成的用户粘性和数据壁垒，设备越多体验越好；3）品牌心智：在大众市场建立了"高品质、高性价比"的强品牌认知；4）软件与服务：澎湃OS打通手机、汽车、家居多端，形成统一账户体系和服务生态。但需注意，小米的护城河相比苹果生态仍有差距，硬件差异化不足，用户迁移成本中等。',
          revenueStructure: revenueStructure as unknown as Record<string, unknown>,
          financialAnnual: financialAnnual as unknown as Record<string, unknown>,
          financialQuarterly: financialQuarterly as unknown as Record<string, unknown>,
          profitability: profitability as unknown as Record<string, unknown>,
          balanceSheet: balanceSheet as unknown as Record<string, unknown>,
          cashFlow: cashFlow as unknown as Record<string, unknown>,
          financialQuality: '整体财务质量良好。资产负债率约55%，处于行业中等水平；现金储备充裕（现金+短投超1900亿），流动性风险低。经营现金流持续为正且增速快于净利润，盈利质量较高。需关注汽车业务投入带来的资本开支压力和潜在亏损扩大风险。应收账款周转天数28天、存货周转天数45天，运营效率在消费电子行业处于优秀水平。',
          segmentAnalysis: segmentAnalysis as unknown as Record<string, unknown>,
          valuationRelative: valuationRelative as unknown as Record<string, unknown>,
          valuationSotp: valuationSotp as unknown as Record<string, unknown>,
          valuationMethodology: '采用分部估值法（SOTP）：1）智能手机业务按15x PE估值（参考全球消费电子龙头平均，考虑高端化溢价）；2）AIoT+互联网服务按20x PE估值（高毛利、高粘性，给予生态溢价）；3）电动汽车业务按2.5x PS估值（参考新势力车企，考虑小米品牌和生态优势）；4）投资与现金按账面价值计入。目标总市值约8500亿港元，对应每股约34港元（已考虑股权稀释）。综合相对估值和绝对估值，给予目标价28港元，对应2025E PE约25x。',
          industryOverview: '全球消费电子行业处于成熟周期后段，总量增长放缓但结构性机会显著。智能手机年出货量约12亿台，5G换机和AI手机是主要驱动力。AIoT市场快速增长，全球智能家居市场规模超1500亿美元，年复合增长率约15%。智能电动汽车处于渗透率快速提升期，全球新能源汽车渗透率已超20%，中国市场超35%，但行业竞争加剧，价格战持续。整体来看，小米所处的赛道既有成熟市场的稳健性，又有新兴领域的成长性。',
          marketSize: '全球智能手机市场规模约5000亿美元；全球AIoT/智能家居市场约1500亿美元，预计2028年达2800亿美元（CAGR 15%）；全球新能源汽车市场约8000亿美元，预计2028年达1.5万亿美元（CAGR 14%）。小米三大核心赛道合计市场空间超1.5万亿美元，长期成长空间充足。',
          competitivePosition: '智能手机：全球第三（市占率约13%），仅次于三星和苹果；中国市场第四（约13%），位于荣耀、OPPO、vivo之后。AIoT：全球最大消费级AIoT平台，连接设备数超7亿，遥遥领先于竞争对手。电动汽车：新势力第二梯队头部位置，首款车型SU7月交付稳定在1.5-2万辆，仅次于特斯拉、比亚迪、理想。整体来看，小米在手机和AIoT领域具备明确的竞争优势，汽车业务仍处于追赶阶段但起点较高。',
          industryTrends: '1）AI赋能：生成式AI正在重塑消费电子体验，端侧大模型成为智能手机新卖点，AI手机渗透率快速提升；2）融合加速：手机、汽车、家居的边界日益模糊，多端协同和生态化成为竞争焦点；3）供应链重构：地缘政治推动全球供应链多元化，印度、东南亚成为新制造中心；4）软件定义：硬件同质化背景下，软件和服务的重要性持续上升，订阅制模式逐步渗透；5）出海深化：中国科技企业全球化从产品出海走向品牌出海和技术出海。',
          bullPoints: bullPoints as unknown as Record<string, unknown>,
          bearPoints: bearPoints as unknown as Record<string, unknown>,
          criticPoints: criticPoints as unknown as Record<string, unknown>,
          revisedAssumptions: '经批判性分析，修正以下关键假设：1）汽车业务盈亏平衡点从2025年底推迟至2026年底-2027年；2）综合毛利率提升幅度从5pct下调至2-3pct；3）AI业务暂不单独给予估值溢价，仅作为生态护城河要素。修正后目标价从32港元下调至28港元，维持买入评级。',
          catalystsTimeline: catalystsTimeline as unknown as Record<string, unknown>,
          riskItems: riskItems as unknown as Record<string, unknown>,
          riskGateSnapshot: riskGateSnapshot as unknown as Record<string, unknown>,
          pmAction: '买入',
          pmPriceRange: '22-25港元为理想建仓区间；28-32港元持有观望；35港元以上考虑分批止盈',
          pmPositionSize: '建议仓位5-8%，不超过10%；若跌至20港元以下可考虑加仓至10%',
          pmStopLoss: '硬止损：跌破18港元（较目标价下跌35%）止损；软止损：基本面恶化（汽车月销跌破1万、手机市占率跌破10%）触发重估',
          pmExecutionPlan: '分3-4次建仓，首次建仓3%，若下跌5%加仓2%，再下跌5%再加仓2%。持有期间跟踪月度交付数据、季度财报和行业数据。重要催化剂前可适度增配，利好兑现后减回基准仓位。每季度复盘一次投资逻辑，若核心假设发生重大变化则调整评级。',
          trackingMetrics: trackingMetrics as unknown as Record<string, unknown>,
          viewChangeTriggers: '【上调评级触发】1）汽车月交付量稳定突破3万辆；2）汽车毛利率转正并达到10%以上；3）高端机市占率突破10%；4）AI服务付费率突破5%。【下调评级触发】1）汽车月交付量跌破1万辆；2）智能手机市占率跌破10%；3）出现重大地缘政治事件（如美国全面制裁）；4）核心管理层发生重大变动。',
          updatedAt: new Date(),
        },
      })
      .returning();

    return this.mapDeepReport(upserted);
  }

  /** Append an audit-log row (runId may be null for user-level events). */
  async addAuditLog(userId: string, runId: string | null, action: string, detail: Record<string, unknown> | null): Promise<AgentAuditLog> {
    const [row] = await this.db
      .insert(agentAuditLog)
      .values({
        runId,
        action,
        detail: detail ?? null,
        owner: userId,
        createdBy: userId,
      })
      .returning();

    return this.mapAuditLog(row);
  }

  /** Recent audit logs for the caller (newest first, capped at 100). */
  async getAuditLogs(userId: string, limit: number): Promise<AgentAuditLog[]> {
    const rows = await this.db
      .select()
      .from(agentAuditLog)
      .where(eq(agentAuditLog.owner, userId))
      .orderBy(desc(agentAuditLog.createdAt))
      .limit(Math.min(limit, 100));
    return rows.map((r) => this.mapAuditLog(r));
  }

  /** Mark a run as cancelled. The pipeline polls for this between phases. */
  async cancelRun(userId: string, runId: string): Promise<AgentRun> {
    const [updated] = await this.db
      .update(agentRuns)
      .set({ status: 'cancelled', updatedBy: userId })
      .where(and(eq(agentRuns.id, runId), eq(agentRuns.owner, userId)))
      .returning();

    if (!updated) throw new NotFoundException('运行记录不存在');
    return this.mapRun(updated);
  }

  /** List evidence rows for a run (owner-checked). */
  async getEvidence(userId: string, runId: string): Promise<AgentEvidence[]> {
    await this.ensureRunOwner(userId, runId);
    const rows = await this.db
      .select()
      .from(agentEvidence)
      .where(eq(agentEvidence.runId, runId))
      .orderBy(agentEvidence.createdAt);
    return rows.map((r) => this.mapEvidence(r));
  }

  /** List bull/bear arguments for a run (owner-checked). */
  async getArguments(userId: string, runId: string): Promise<BullBearArgument[]> {
    await this.ensureRunOwner(userId, runId);
    const rows = await this.db
      .select()
      .from(bullBearArguments)
      .where(eq(bullBearArguments.runId, runId))
      .orderBy(bullBearArguments.round, bullBearArguments.side);
    return rows.map((r) => this.mapArgument(r));
  }

  /** List debate turns for a run (owner-checked). */
  async getDebate(userId: string, runId: string): Promise<DebateRecord[]> {
    await this.ensureRunOwner(userId, runId);
    const rows = await this.db
      .select()
      .from(debateRecords)
      .where(eq(debateRecords.runId, runId))
      .orderBy(debateRecords.round, debateRecords.createdAt);
    return rows.map((r) => this.mapDebate(r));
  }

  /** Fetch the rating for a run, or null if not yet produced (owner-checked). */
  async getRating(userId: string, runId: string): Promise<AgentRatingRecord | null> {
    await this.ensureRunOwner(userId, runId);
    const rows = await this.db
      .select()
      .from(agentRatings)
      .where(and(eq(agentRatings.runId, runId), eq(agentRatings.owner, userId)));
    return rows.length > 0 ? this.mapRating(rows[0]) : null;
  }

  /** List risk-gate results for a run (owner-checked). */
  async getRiskGate(userId: string, runId: string): Promise<RiskGateResult[]> {
    await this.ensureRunOwner(userId, runId);
    const rows = await this.db
      .select()
      .from(riskGateResults)
      .where(eq(riskGateResults.runId, runId))
      .orderBy(riskGateResults.ruleName);
    return rows.map((r) => this.mapRiskGate(r));
  }

  /**
   * Sync a completed run's rating into the daily `analysis` table (one row per
   * user/ticker/date). Updates the existing row for today if present, otherwise
   * inserts a new one. Called from the human-decision endpoint when
   * syncToAnalysis is true (the default).
   */
  async syncRatingToAnalysis(userId: string, runId: string): Promise<boolean> {
    const [runRow, ratingRow] = await Promise.all([
      this.db
        .select()
        .from(agentRuns)
        .where(and(eq(agentRuns.id, runId), eq(agentRuns.owner, userId))),
      this.db
        .select()
        .from(agentRatings)
        .where(and(eq(agentRatings.runId, runId), eq(agentRatings.owner, userId))),
    ]);

    if (runRow.length === 0 || ratingRow.length === 0) return false;

    const run = runRow[0];
    const rating = ratingRow[0];
    const today = new Date().toISOString().split('T')[0];
    const en = run.language === 'en';

    const analysisText = [
      rating.aggregationLogic ? `${en ? 'Rationale: ' : '【综合逻辑】'}${rating.aggregationLogic}` : '',
      rating.bullSummary ? `${en ? 'Bull case: ' : '【看多要点】'}${rating.bullSummary}` : '',
      rating.bearSummary ? `${en ? 'Bear case: ' : '【看空要点】'}${rating.bearSummary}` : '',
      rating.keyUncertainty ? `${en ? 'Uncertainty: ' : '【不确定性】'}${rating.keyUncertainty}` : '',
    ].filter(Boolean).join('\n\n');

    const existing = await this.db
      .select({ id: analysis.id })
      .from(analysis)
      .where(
        and(
          eq(analysis.owner, userId),
          eq(analysis.analysisDate, today),
          eq(analysis.ticker, run.ticker),
        ),
      );

    if (existing.length > 0) {
      await this.db
        .update(analysis)
        .set({
          rating: rating.rating,
          action: rating.action,
          analysis: analysisText || null,
          targetPrice: rating.targetPrice,
          catalysts: rating.catalysts,
          risks: rating.risks,
          updatedBy: userId,
        })
        .where(eq(analysis.id, existing[0].id));
    } else {
      await this.db.insert(analysis).values({
        analysisDate: today,
        ticker: run.ticker,
        rating: rating.rating,
        action: rating.action,
        analysis: analysisText || null,
        targetPrice: rating.targetPrice,
        catalysts: rating.catalysts,
        risks: rating.risks,
        owner: userId,
        createdBy: userId,
        updatedBy: userId,
      });
    }

    return true;
  }

  /**
   * Return the latest completed rating per ticker for the caller. Joins
   * agentRatings → agentRuns, filters to runs with status='completed', then
   * picks the most recent row per ticker (case-insensitive).
   * @param tickers optional whitelist; if omitted, returns all tickers.
   */
  async getLatestRatings(userId: string, tickers?: string[]): Promise<LatestRating[]> {
    const ratingRows = await this.db
      .select({
        id: agentRatings.id,
        ticker: agentRatings.ticker,
        rating: agentRatings.rating,
        confidence: agentRatings.confidence,
        targetPrice: agentRatings.targetPrice,
        action: agentRatings.action,
        runId: agentRatings.runId,
        createdAt: agentRatings.createdAt,
        bullSummary: agentRatings.bullSummary,
        bearSummary: agentRatings.bearSummary,
      })
      .from(agentRatings)
      .innerJoin(agentRuns, eq(agentRatings.runId, agentRuns.id))
      .where(
        and(
          eq(agentRatings.owner, userId),
          eq(agentRuns.status, 'completed'),
        ),
      )
      .orderBy(desc(agentRatings.createdAt));

    const filtered = tickers && tickers.length > 0
      ? ratingRows.filter((r) => tickers.some((t) => t.toUpperCase() === r.ticker.toUpperCase()))
      : ratingRows;

    const seen = new Set<string>();
    const result: LatestRating[] = [];
    for (const r of filtered) {
      const upper = r.ticker.toUpperCase();
      if (seen.has(upper)) continue;
      seen.add(upper);
      result.push({
        ticker: r.ticker,
        rating: r.rating as LatestRating['rating'],
        confidence: r.confidence as LatestRating['confidence'],
        targetPrice: r.targetPrice?.toString() ?? null,
        action: r.action,
        runId: r.runId as string,
        createdAt: (r.createdAt as Date).toISOString(),
        bullSummary: r.bullSummary ?? null,
        bearSummary: r.bearSummary ?? null,
      });
    }

    return result.sort((a, b) => a.ticker.localeCompare(b.ticker));
  }

  /**
   * Paginated list of runs joined with both the deep-report row and the
   * rating row. This is the variant the controller's GET /runs uses.
   * Date filtering: `to` is inclusive (we add a day and use lt).
   */
  async listRunsWithRating(
    userId: string,
    query: AgentRunListQuery,
  ): Promise<{ items: AgentRunWithRating[]; total: number }> {
    const conditions = [eq(agentRuns.owner, userId)];
    if (query.activeOnly) {
      conditions.push(inArray(agentRuns.status, ['pending', 'fetching', 'debating', 'critiquing', 'risk_check']));
    }
    if (query.ticker) conditions.push(eq(agentRuns.ticker, query.ticker));
    if (query.status) conditions.push(eq(agentRuns.status, query.status));
    if (query.runMode) conditions.push(eq(agentRuns.runMode, query.runMode));
    if (query.from) conditions.push(gte(agentRuns.createdAt, new Date(query.from)));
    if (query.to) {
      // `to` is treated as an exclusive upper bound. Callers that send a
      // plain date (yyyy-MM-dd) still work: Date() parses it as midnight.
      // Callers that send a full ISO timestamp (the dashboard sends the
      // start of the next local day) get exact behavior with no timezone skew.
      const toDate = new Date(query.to);
      // Only add a day when the caller passed a bare date (no time part).
      if (query.to.length === 10) {
        toDate.setDate(toDate.getDate() + 1);
      }
      conditions.push(lt(agentRuns.createdAt, toDate));
    }

    const limit = Math.max(1, Math.min(query.limit ?? 20, query.activeOnly ? 1000 : 100));
    const offset = query.offset ?? 0;

    const [rows, countRows] = await Promise.all([
      this.db
        .select({
          run: agentRuns,
          targetBear: deepReport.targetBear,
          targetBase: deepReport.targetBase,
          targetBull: deepReport.targetBull,
          drConfidence: deepReport.confidence,
          reportId: deepReport.id,
        })
        .from(agentRuns)
        .leftJoin(deepReport, eq(agentRuns.id, deepReport.runId))
        .where(and(...conditions))
        .orderBy(desc(agentRuns.startedAt), desc(agentRuns.createdAt))
        .limit(limit)
        .offset(offset),
      this.db
        .select({ count: sql<number>`count(*)` })
        .from(agentRuns)
        .where(and(...conditions)),
      ]);

    const runIds = rows.map((r) => r.run.id);
    const ratingRows = runIds.length > 0
      ? await this.db
          .select()
          .from(agentRatings)
          .where(inArray(agentRatings.runId, runIds))
      : [];

    const ratingByRun = new Map(ratingRows.map((r) => [r.runId, r]));

    return {
      items: rows.map((r) => ({
        ...this.mapRun(r.run),
        targetBear: r.targetBear?.toString() ?? null,
        targetBase: r.targetBase?.toString() ?? null,
        targetBull: r.targetBull?.toString() ?? null,
        confidence: (r.drConfidence ?? null) as AgentRun['confidence'],
        hasReport: r.reportId !== null,
        rating: ratingByRun.has(r.run.id) ? this.mapRating(ratingByRun.get(r.run.id)!) : null,
      })),
      total: Number(countRows[0]?.count ?? 0),
    };
  }

  /** Verify that a run exists and belongs to the caller; throw otherwise. */
  private async ensureRunOwner(userId: string, runId: string): Promise<void> {
    const [row] = await this.db
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(and(eq(agentRuns.id, runId), eq(agentRuns.owner, userId)));
    if (!row) throw new NotFoundException('运行记录不存在');
  }

  /**
   * Insert the built-in default risk rules for a new user. These cover
   * position concentration, cash management, stop-loss/take-profit, and
   * buy-checklist categories. Users can later edit/delete/reorder them.
   */
  private async seedDefaultRules(userId: string): Promise<StrategyRule[]> {
    const defaults = [
      { ruleKey: 'single_company_exposure', ruleName: '单一公司合并敞口上限', ruleType: 'hard', threshold: 25, unit: '%', description: '单一公司所有相关标的（正股+转债+关联ETF等）合计仓位不超过25%', category: 'position_concentration', severity: 'hard_block', sort: 10 },
      { ruleKey: 'single_stock_limit', ruleName: '单只股票权重上限', ruleType: 'soft', threshold: 10, unit: '%', description: '单只股票建议仓位不超过10%，超过需特别理由', category: 'position_concentration', severity: 'warning', sort: 20 },
      { ruleKey: 'small_cap_weight', ruleName: '小盘股合计上限', ruleType: 'hard', threshold: 5, unit: '%', description: '市值小于50亿的小盘股总仓位不超过5%', category: 'position_concentration', severity: 'hard_block', sort: 30, enabled: false },
      { ruleKey: 'loss_maker_weight', ruleName: '亏损股合计上限', ruleType: 'hard', threshold: 10, unit: '%', description: '最近一期净利润为负的标的合计仓位不超过10%', category: 'position_concentration', severity: 'warning', sort: 40, enabled: false },
      { ruleKey: 'leverage_etf', ruleName: '杠杆ETF敞口上限', ruleType: 'hard', threshold: 3, unit: '%', description: '2x/3x 杠杆/反向 ETF 合计仓位不超过3%', category: 'position_concentration', severity: 'hard_block', sort: 50 },
      { ruleKey: 'cash_ratio', ruleName: '现金比例下限', ruleType: 'soft', threshold: 7.5, unit: '%', description: '现金占总资产比例建议保持5-10%，极端行情保留加仓能力', category: 'cash_management', severity: 'warning', sort: 60 },
      { ruleKey: 'drawdown_check', ruleName: '个股回撤强制重检', ruleType: 'hard', threshold: 20, unit: '%', description: '单只股票较成本价下跌超过阈值，必须强制重检基本面', category: 'stop_loss_take_profit', severity: 'hard_block', sort: 70 },
      { ruleKey: 'stop_loss_pct', ruleName: '个股止损线', ruleType: 'soft', threshold: 25, unit: '%', description: '单只股票较成本价下跌超过该比例触发止损评估', category: 'stop_loss_take_profit', severity: 'warning', sort: 80 },
      { ruleKey: 'take_profit_pct', ruleName: '个股止盈线', ruleType: 'soft', threshold: 50, unit: '%', description: '单只股票浮盈超过该比例触发止盈评估/分批减仓', category: 'stop_loss_take_profit', severity: 'warning', sort: 90 },
      { ruleKey: 'new_buy_checklist', ruleName: '建仓前必过清单', ruleType: 'hard', threshold: 1, unit: '项', description: '新建仓必须完成：基本面评分、行业地位、估值分位、催化剂、风险点 5 项检查', category: 'buy_conditions', severity: 'hard_block', sort: 100, enabled: false },
      { ruleKey: 'position_building_days', ruleName: '建仓节奏', ruleType: 'soft', threshold: 3, unit: '次', description: '单只股票建仓建议分至少3次买入，时间跨度不少于2周', category: 'buy_conditions', severity: 'warning', sort: 110 },
      { ruleKey: 'sector_exposure', ruleName: '单一行业敞口上限', ruleType: 'soft', threshold: 30, unit: '%', description: '单一行业/板块合计仓位建议不超过30%', category: 'position_concentration', severity: 'warning', sort: 25 },
    ];

    const values = defaults.map((d) => ({
      ruleKey: d.ruleKey,
      ruleName: d.ruleName,
      ruleType: d.ruleType,
      threshold: String(d.threshold),
      unit: d.unit,
      description: d.description,
      category: d.category,
      severity: d.severity,
      sort: d.sort,
      enabled: d.enabled ?? true,
      owner: userId,
      createdBy: userId,
      updatedBy: userId,
    }));

    const inserted = await this.db.insert(strategyRules).values(values).returning();
    return inserted.map((r) => this.mapStrategyRule(r));
  }

  /** Map a raw agent_runs row to the AgentRun API shape (dates → ISO strings). */
  private mapRun(row: typeof agentRuns.$inferSelect): AgentRun {
    return {
      id: row.id,
      ticker: row.ticker,
      tickerName: row.tickerName,
      market: row.market,
      triggerType: row.triggerType as AgentRun['triggerType'],
      runMode: row.runMode as AgentRun['runMode'],
      language: row.language === 'en' ? 'en' : 'zh-CN',
      status: row.status as AgentRun['status'],
      modelFast: row.modelFast,
      modelSlow: row.modelSlow,
      modelRoute: row.modelRoute as ModelRoute | null,
      tokensUsed: row.tokensUsed ?? 0,
      costEstimate: row.costEstimate?.toString() ?? '0',
      startedAt: row.startedAt ? row.startedAt.toISOString() : null,
      completedAt: row.completedAt ? row.completedAt.toISOString() : null,
      errorMessage: row.errorMessage ? safeAnalysisError(row.errorMessage, row.language === 'en' ? 'en' : 'zh-CN') : null,
      humanDecision: row.humanDecision as AgentRun['humanDecision'],
      humanNote: row.humanNote,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      targetBear: null,
      targetBase: null,
      targetBull: null,
      confidence: null,
    };
  }

  /** Map a raw agent_evidence row to AgentEvidence. */
  private mapEvidence(row: typeof agentEvidence.$inferSelect): AgentEvidence {
    return {
      id: row.id,
      runId: row.runId,
      role: row.role as AgentEvidence['role'],
      evidenceType: row.evidenceType as AgentEvidence['evidenceType'],
      title: row.title,
      content: row.content,
      sourceUrl: row.sourceUrl,
      sourceName: row.sourceName,
      fetchedAt: row.fetchedAt.toISOString(),
      metadata: row.metadata ?? null,
      relevanceScore: row.relevanceScore?.toString() ?? null,
      createdAt: row.createdAt.toISOString(),
    };
  }

  /** Map a raw bull_bear_arguments row to BullBearArgument. */
  private mapArgument(row: typeof bullBearArguments.$inferSelect): BullBearArgument {
    return {
      id: row.id,
      runId: row.runId,
      side: row.side as BullBearArgument['side'],
      round: row.round ?? 1,
      argument: row.argument,
      evidenceIds: Array.isArray(row.evidenceIds) ? (row.evidenceIds as string[]) : [],
      counteredBy: row.counteredBy,
      createdAt: row.createdAt.toISOString(),
    };
  }

  /** Map a raw debate_records row to DebateRecord. */
  private mapDebate(row: typeof debateRecords.$inferSelect): DebateRecord {
    return {
      id: row.id,
      runId: row.runId,
      round: row.round,
      speaker: row.speaker as DebateRecord['speaker'],
      content: row.content,
      tokensUsed: row.tokensUsed ?? 0,
      createdAt: row.createdAt.toISOString(),
    };
  }

  /** Map a raw agent_ratings row to AgentRatingRecord. */
  private mapRating(row: typeof agentRatings.$inferSelect): AgentRatingRecord {
    return {
      id: row.id,
      runId: row.runId,
      ticker: row.ticker,
      rating: row.rating as AgentRatingRecord['rating'],
      confidence: row.confidence as AgentRatingRecord['confidence'],
      targetPrice: row.targetPrice?.toString() ?? null,
      action: row.action,
      aggregationLogic: row.aggregationLogic,
      keyUncertainty: row.keyUncertainty,
      bullSummary: row.bullSummary,
      bearSummary: row.bearSummary,
      catalysts: row.catalysts,
      risks: row.risks,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /** Map a raw risk_gate_results row to RiskGateResult. */
  private mapRiskGate(row: typeof riskGateResults.$inferSelect): RiskGateResult {
    return {
      id: row.id,
      runId: row.runId,
      ruleName: row.ruleName,
      ruleType: row.ruleType as RiskGateResult['ruleType'],
      passed: row.passed,
      currentValue: row.currentValue?.toString() ?? null,
      thresholdValue: row.thresholdValue?.toString() ?? null,
      detail: row.detail,
      suggestedAction: row.suggestedAction,
      createdAt: row.createdAt.toISOString(),
    };
  }

  /** Map a raw strategy_rules row to StrategyRule. */
  private mapStrategyRule(row: typeof strategyRules.$inferSelect): StrategyRule {
    return {
      id: row.id,
      ruleKey: row.ruleKey,
      ruleName: row.ruleName,
      ruleType: row.ruleType as StrategyRule['ruleType'],
      threshold: row.threshold?.toString() ?? null,
      unit: row.unit,
      enabled: row.enabled ?? true,
      description: row.description,
      category: (row.category as StrategyRule['category']) ?? null,
      severity: (row.severity as StrategyRule['severity']) ?? 'warning',
      sort: row.sort ?? 0,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /** Map a raw deep_report row to DeepReport (JSONB columns cast to typed arrays). */
  private mapDeepReport(row: typeof deepReport.$inferSelect): DeepReport {
    return {
      id: row.id,
      runId: row.runId,
      ticker: row.ticker,
      analysisTrace: (row.analysisTrace as DeepReport['analysisTrace']) ?? null,
      rating: (row.rating as DeepReport['rating']) ?? null,
      confidence: (row.confidence as DeepReport['confidence']) ?? null,
      targetBear: row.targetBear?.toString() ?? null,
      targetBase: row.targetBase?.toString() ?? null,
      targetBull: row.targetBull?.toString() ?? null,
      probBear: row.probBear?.toString() ?? null,
      probBase: row.probBase?.toString() ?? null,
      probBull: row.probBull?.toString() ?? null,
      coreThesis: row.coreThesis,
      viewChange: row.viewChange,
      prevRating: row.prevRating,
      companyOverview: row.companyOverview,
      businessModel: row.businessModel,
      moat: row.moat,
      revenueStructure: (row.revenueStructure as DeepReport['revenueStructure']) ?? null,
      financialAnnual: (row.financialAnnual as DeepReport['financialAnnual']) ?? null,
      financialQuarterly: (row.financialQuarterly as DeepReport['financialQuarterly']) ?? null,
      profitability: (row.profitability as DeepReport['profitability']) ?? null,
      balanceSheet: (row.balanceSheet as DeepReport['balanceSheet']) ?? null,
      cashFlow: (row.cashFlow as DeepReport['cashFlow']) ?? null,
      financialQuality: row.financialQuality,
      segmentAnalysis: (row.segmentAnalysis as DeepReport['segmentAnalysis']) ?? null,
      valuationRelative: (row.valuationRelative as DeepReport['valuationRelative']) ?? null,
      valuationSotp: (row.valuationSotp as DeepReport['valuationSotp']) ?? null,
      valuationMethodology: row.valuationMethodology,
      industryOverview: row.industryOverview,
      marketSize: row.marketSize,
      competitivePosition: row.competitivePosition,
      industryTrends: row.industryTrends,
      bullPoints: (row.bullPoints as DeepReport['bullPoints']) ?? null,
      bearPoints: (row.bearPoints as DeepReport['bearPoints']) ?? null,
      criticPoints: (row.criticPoints as DeepReport['criticPoints']) ?? null,
      revisedAssumptions: row.revisedAssumptions,
      catalystsTimeline: (row.catalystsTimeline as DeepReport['catalystsTimeline']) ?? null,
      riskItems: (row.riskItems as DeepReport['riskItems']) ?? null,
      riskGateSnapshot: (row.riskGateSnapshot as DeepReport['riskGateSnapshot']) ?? null,
      pmAction: row.pmAction,
      pmPriceRange: row.pmPriceRange,
      pmPositionSize: row.pmPositionSize,
      pmStopLoss: row.pmStopLoss,
      pmExecutionPlan: row.pmExecutionPlan,
      trackingMetrics: (row.trackingMetrics as DeepReport['trackingMetrics']) ?? null,
      viewChangeTriggers: row.viewChangeTriggers,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /** Map a raw agent_audit_log row to AgentAuditLog. */
  private mapAuditLog(row: typeof agentAuditLog.$inferSelect): AgentAuditLog {
    return {
      id: row.id,
      runId: row.runId,
      action: row.action as AgentAuditLog['action'],
      detail: (row.detail as Record<string, unknown> | null) ?? null,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
