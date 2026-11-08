/**
 * BatchService — creates and schedules multi-agent runs in bulk, with two
 * independent concurrency-limited queues (one per runMode).
 *
 * Why two queues? "full" runs (full debate + critique + rating) are expensive
 * on LLM tokens; "summary" runs are cheaper. We allow more concurrent summary
 * runs than full runs to keep throughput up without blowing the LLM budget.
 *
 * Flow:
 *  - createBatch: resolve target tickers (holdings / watchlist / custom list),
 *    create a pending run row for each, then either start it immediately (if a
 *    slot is free) or push it onto the per-mode queue.
 *  - PipelineService.onRunComplete fires when a run finishes; BatchService
 *    releases a slot and calls processQueue to dequeue the next item.
 *  - Tiered mode: when `tiered=true`, high-conviction targets (holdings >5%
 *    weight, or watchlist tickers with a buy/strong signal) get `full` runs;
 *    everything else gets `summary`.
 *  - createDailyBatch: convenience that runs all holdings + buy-signal watchlist
 *    items in tiered mode.
 */
import { Injectable, Inject, Logger, OnApplicationBootstrap, OnModuleInit, BadRequestException, Optional } from '@nestjs/common';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '../../common/platform';
import { eq, and, inArray, sql } from 'drizzle-orm';
import { holdings, watchlist, agentRuns } from '@server/database/schema';
import { MultiAgentService } from './multi-agent.service';
import { PipelineService } from './pipeline.service';
import { PortfolioContextService } from '../research-core/portfolio-context.service';
import { SettingsService } from '../settings/settings.service';
import { LlmService } from '../research-core/llm.service';
import type { ModelRoute } from '../../../shared/model-route.interface';
import { normalizeAnalysisLanguage } from './analysis-report';
import { safeAnalysisError } from '../research-core/research-errors';
import type {
  BatchRunRequest,
  BatchRunResult,
  BatchRunItem,
  AgentRunMode,
  AgentRunStatus,
  AnalysisLanguage,
} from '@shared/api.interface';

/** A single pending run waiting in the in-memory queue. */
interface QueueItem {
  runId: string;
  userId: string;
  ticker: string;
  runMode: AgentRunMode;
  route?: ModelRoute;
}

@Injectable()
export class BatchService implements OnModuleInit, OnApplicationBootstrap {
  private readonly logger = new Logger(BatchService.name);
  /** Max concurrent full (expensive) runs. */
  private readonly MAX_FULL_CONCURRENT = 3;
  /** Max concurrent summary (cheap) runs. */
  private readonly MAX_SUMMARY_CONCURRENT = 5;

  /** Live counters of in-flight runs per mode. */
  private fullRunning = 0;
  private summaryRunning = 0;
  /** FIFO queues of not-yet-started runs per mode. */
  private fullQueue: QueueItem[] = [];
  private summaryQueue: QueueItem[] = [];
  private activeTargets = new Set<string>();
  private targetByRun = new Map<string, string>();
  private routeByRun = new Map<string, ModelRoute | undefined>();
  private runningLocalAgents = new Map<string, number>();

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly multiAgentService: MultiAgentService,
    private readonly pipelineService: PipelineService,
    private readonly portfolioContextService: PortfolioContextService,
    @Optional() private readonly settings?: SettingsService,
    @Optional() private readonly llm?: LlmService,
  ) {}

  /**
   * On module init, subscribe to pipeline completion so we can free slots and
   * drain the queue. Registered once here rather than per-request.
   */
  onModuleInit(): void {
    this.pipelineService.onRunComplete((runId, userId, mode) => {
      const target = this.targetByRun.get(runId);
      if (!target) return;
      this.activeTargets.delete(target);
      this.targetByRun.delete(runId);
      const route = this.routeByRun.get(runId);
      this.routeByRun.delete(runId);
      this.releaseSlot(mode, route);
      this.processQueue();
    });
  }

  /** In-memory queues disappear on process restart. Make orphaned runs retryable. */
  async onApplicationBootstrap(): Promise<void> {
    const interrupted = ['pending', 'fetching', 'debating', 'critiquing', 'risk_check'] as AgentRunStatus[];
    const rows = await this.db.update(agentRuns).set({
      status: 'failed',
      errorMessage: sql`CASE WHEN ${agentRuns.language} = 'en' THEN 'Server restarted before analysis finished. Please start a new analysis.' ELSE '服务重启前分析未完成，请重新启动分析。' END`,
      completedAt: new Date(),
    }).where(inArray(agentRuns.status, interrupted)).returning({ id: agentRuns.id });
    if (rows.length) this.logger.warn(`Marked ${rows.length} interrupted analyses as retryable`);
  }

  /** Pending work has not acquired a slot; remove it immediately without reducing live counters. */
  cancelQueuedRun(runId: string, userId: string): void {
    for (const queue of [this.fullQueue, this.summaryQueue]) {
      const index = queue.findIndex((item) => item.runId === runId && item.userId === userId);
      if (index < 0) continue;
      queue.splice(index, 1);
      const target = this.targetByRun.get(runId);
      if (target) this.activeTargets.delete(target);
      this.targetByRun.delete(runId);
      this.routeByRun.delete(runId);
      return;
    }
  }

  /**
   * Create runs for a batch request. Resolves targets, creates a pending run
   * row per target, then either starts it immediately or enqueues it.
   * Errors on individual targets are collected and returned rather than
   * aborting the whole batch.
   */
  async createBatch(userId: string, req: BatchRunRequest): Promise<BatchRunResult> {
    if (!req || !['holdings', 'watchlist', 'all', 'custom'].includes(req.scope)) {
      throw new BadRequestException('Select a valid analysis scope');
    }
    if (req.tickers !== undefined && (!Array.isArray(req.tickers) || req.tickers.length > 100
      || req.tickers.some((ticker) => typeof ticker !== 'string' || !/^[A-Za-z0-9.^_-]{1,20}$/u.test(ticker)))) {
      throw new BadRequestException('Provide up to 100 valid ticker symbols');
    }
    let language: AnalysisLanguage;
    try {
      language = normalizeAnalysisLanguage(req.language);
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : 'Invalid analysis language');
    }
    const route = req.route ?? await this.settings?.getDefaultModelRoute(userId);
    if (route && this.llm) await this.llm.validateRoute(userId, route);
    const targets = await this.resolveTargets(userId, req);
    const result: BatchRunResult = {
      created: 0,
      queued: 0,
      running: 0,
      runs: [],
      errors: [],
    };

    for (const target of targets) {
      const targetKey = `${userId}:${target.ticker.toUpperCase()}`;
      if (this.activeTargets.has(targetKey)) {
        result.errors.push({ ticker: target.ticker, error: 'Analysis is already running for this ticker' });
        continue;
      }
      this.activeTargets.add(targetKey);
      try {
        const run = await this.multiAgentService.createRun(userId, {
          ticker: target.ticker,
          tickerName: target.company ?? undefined,
          market: target.market ?? undefined,
          triggerType: 'manual',
          runMode: target.runMode,
          language,
          modelRoute: route,
        });

        const item: BatchRunItem = {
          runId: run.id,
          ticker: run.ticker,
          runMode: run.runMode,
          status: run.status,
        };
        result.runs.push(item);
        result.created += 1;
        this.targetByRun.set(run.id, targetKey);
        this.routeByRun.set(run.id, route);

        const queueItem: QueueItem = {
          runId: run.id,
          userId,
          ticker: target.ticker,
          runMode: target.runMode,
          route,
        };

        if (this.canStart(target.runMode, route)) {
          this.acquireSlot(target.runMode, route);
          this.pipelineService.startPipeline(run.id, userId, target.runMode);
          item.status = 'fetching';
          result.running += 1;
        } else {
          this.enqueue(queueItem);
          item.status = 'pending';
          result.queued += 1;
        }
      } catch (err) {
        this.activeTargets.delete(targetKey);
        result.errors.push({
          ticker: target.ticker,
          error: safeAnalysisError(err, language),
        });
      }
    }

    return result;
  }

  /**
   * Daily routine: tiered run over all holdings, plus a tiered run over
   * watchlist tickers that carry a buy/strong-buy signal.
   */
  async createDailyBatch(userId: string, language?: AnalysisLanguage, requestedRoute?: ModelRoute): Promise<{
    holdingsRuns: BatchRunItem[];
    watchlistRuns: BatchRunItem[];
    totalCreated: number;
    errors: Array<{ ticker: string; error: string }>;
  }> {
    const route = requestedRoute ?? await this.settings?.getDefaultModelRoute(userId);
    const holdingsResult = await this.createBatch(userId, {
      scope: 'holdings',
      tiered: true,
      language,
      route,
    });

    const watchlistItems = await this.getWatchlistTargets(userId);
    const holdingTickers = new Set(holdingsResult.runs.map((run) => run.ticker.toUpperCase()));
    const buySignals = watchlistItems.filter((w) => {
      if (holdingTickers.has(w.ticker.toUpperCase())) return false;
      const sig = w.signal ?? '';
      return sig.includes('买入') || sig.includes('强烈') || /^(strong\s+)?buy$/iu.test(sig.trim());
    });

    const watchlistResult = await this.createBatch(userId, {
      scope: 'custom',
      tickers: buySignals.map((w) => w.ticker),
      tiered: true,
      language,
      route,
    });

    return {
      holdingsRuns: holdingsResult.runs,
      watchlistRuns: watchlistResult.runs,
      totalCreated: holdingsResult.created + watchlistResult.created,
      errors: [...holdingsResult.errors, ...watchlistResult.errors],
    };
  }

  /**
   * Drain as many queued runs as the current concurrency caps allow, starting
   * the pipeline for each dequeued item. Called after a run completes and
   * after a new batch is created.
   */
  processQueue(): void {
    while (this.fullRunning < this.MAX_FULL_CONCURRENT && this.fullQueue.length > 0) {
      const index = this.fullQueue.findIndex(item => this.canStart(item.runMode, item.route));
      if (index < 0) break;
      const [item] = this.fullQueue.splice(index, 1);
      this.acquireSlot(item.runMode, item.route);
      this.logger.log(`Dequeued full run: ${item.ticker} (${item.runId})`);
      this.pipelineService.startPipeline(item.runId, item.userId, item.runMode);
    }

    while (this.summaryRunning < this.MAX_SUMMARY_CONCURRENT && this.summaryQueue.length > 0) {
      const index = this.summaryQueue.findIndex(item => this.canStart(item.runMode, item.route));
      if (index < 0) break;
      const [item] = this.summaryQueue.splice(index, 1);
      this.acquireSlot(item.runMode, item.route);
      this.logger.log(`Dequeued summary run: ${item.ticker} (${item.runId})`);
      this.pipelineService.startPipeline(item.runId, item.userId, item.runMode);
    }
  }

  /**
   * Translate a BatchRunRequest into a concrete list of tickers to run.
   *  - scope='holdings': all holdings rows.
   *  - scope='watchlist': all watchlist rows.
   *  - scope='all': both.
   *  - scope='custom': explicit ticker list; looks up company/market from
   *    holdings or watchlist rows.
   * When tiered=true, picks runMode per ticker: holdings >5% weight or
   * watchlist buy/strong signal → full; otherwise summary.
   */
  private async resolveTargets(
    userId: string,
    req: BatchRunRequest,
  ): Promise<Array<{ ticker: string; company: string | null; market: string | null; runMode: AgentRunMode }>> {
    const portfolio = req.tiered ? await this.portfolioContextService.getPortfolioContext(userId) : null;

    const targets: Array<{ ticker: string; company: string | null; market: string | null; runMode: AgentRunMode }> = [];

    if (req.scope === 'holdings' || req.scope === 'all') {
      const holdingRows = await this.db
        .select()
        .from(holdings)
        .where(eq(holdings.owner, userId));

      for (const h of holdingRows) {
        let runMode: AgentRunMode = 'full';
        if (req.tiered && portfolio) {
          const holding = portfolio.holdings.find(
            (p) => p.ticker.toUpperCase() === h.ticker.toUpperCase(),
          );
          runMode = holding && holding.weightPct > 5 ? 'full' : 'summary';
        }
        targets.push({
          ticker: h.ticker,
          company: h.company,
          market: h.market,
          runMode,
        });
      }
    }

    if (req.scope === 'watchlist' || req.scope === 'all') {
      const watchRows = await this.db
        .select()
        .from(watchlist)
        .where(eq(watchlist.owner, userId));

      for (const w of watchRows) {
        let runMode: AgentRunMode = 'full';
        if (req.tiered) {
          const signal = w.signal ?? '';
          runMode = signal.includes('买入') || signal.includes('强烈') ? 'full' : 'summary';
        }
        targets.push({
          ticker: w.ticker,
          company: w.company,
          market: w.market,
          runMode,
        });
      }
    }

    if (req.scope === 'custom' && req.tickers && req.tickers.length > 0) {
      const [holdingRows, watchRows] = await Promise.all([
        this.db.select().from(holdings).where(eq(holdings.owner, userId)),
        this.db.select().from(watchlist).where(eq(watchlist.owner, userId)),
      ]);

      for (const t of req.tickers) {
        const upper = t.toUpperCase();
        const h = holdingRows.find((r) => r.ticker.toUpperCase() === upper);
        const w = watchRows.find((r) => r.ticker.toUpperCase() === upper);

        let runMode: AgentRunMode = 'full';
        let company: string | null = null;
        let market: string | null = null;

        if (h) {
          company = h.company;
          market = h.market;
          if (req.tiered && portfolio) {
            const ph = portfolio.holdings.find(
              (p) => p.ticker.toUpperCase() === upper,
            );
            runMode = ph && ph.weightPct > 5 ? 'full' : 'summary';
          }
        } else if (w) {
          company = w.company;
          market = w.market;
          if (req.tiered) {
            const signal = w.signal ?? '';
            runMode = signal.includes('买入') || signal.includes('强烈') ? 'full' : 'summary';
          }
        }

        targets.push({ ticker: t, company, market, runMode });
      }
    }

    // Dedupe the complete request independently of live execution: a fast run
    // may finish (and release its active target) before later items are created.
    const uniqueTargets = new Map<string, (typeof targets)[number]>();
    for (const target of targets) {
      const key = target.ticker.toUpperCase();
      const existing = uniqueTargets.get(key);
      if (!existing) {
        uniqueTargets.set(key, target);
      } else {
        if (target.runMode === 'full') existing.runMode = 'full';
        existing.company ??= target.company;
        existing.market ??= target.market;
      }
    }
    return [...uniqueTargets.values()];
  }

  /** Fetch just ticker+signal for the caller's watchlist. */
  private async getWatchlistTargets(userId: string): Promise<Array<{ ticker: string; signal: string | null }>> {
    const rows = await this.db
      .select({ ticker: watchlist.ticker, signal: watchlist.signal })
      .from(watchlist)
      .where(eq(watchlist.owner, userId));
    return rows;
  }

  /** @returns true if a new run of the given mode can start immediately. */
  private canStart(mode: AgentRunMode, route?: ModelRoute): boolean {
    if (route?.mode === 'local' && (this.runningLocalAgents.get(route.agentId) ?? 0) > 0) return false;
    if (mode === 'full') return this.fullRunning < this.MAX_FULL_CONCURRENT;
    return this.summaryRunning < this.MAX_SUMMARY_CONCURRENT;
  }

  /** Reserve a concurrency slot for the given mode. */
  private acquireSlot(mode: AgentRunMode, route?: ModelRoute): void {
    if (mode === 'full') this.fullRunning += 1;
    else this.summaryRunning += 1;
    if (route?.mode === 'local') this.runningLocalAgents.set(route.agentId, (this.runningLocalAgents.get(route.agentId) ?? 0) + 1);
  }

  /** Release a concurrency slot after a run finishes (floored at 0). */
  private releaseSlot(mode: AgentRunMode, route?: ModelRoute): void {
    if (mode === 'full') this.fullRunning = Math.max(0, this.fullRunning - 1);
    else this.summaryRunning = Math.max(0, this.summaryRunning - 1);
    if (route?.mode === 'local') {
      const remaining = (this.runningLocalAgents.get(route.agentId) ?? 1) - 1;
      if (remaining > 0) this.runningLocalAgents.set(route.agentId, remaining);
      else this.runningLocalAgents.delete(route.agentId);
    }
  }

  /** Append an item to the appropriate per-mode queue. */
  private enqueue(item: QueueItem): void {
    if (item.runMode === 'full') this.fullQueue.push(item);
    else this.summaryQueue.push(item);
    this.logger.log(
      `Queued ${item.runMode} run: ${item.ticker} (queue full=${this.fullQueue.length}, summary=${this.summaryQueue.length})`,
    );
  }
}
