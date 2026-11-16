/**
 * batch.service.ts — BatchService — 批量创建并调度多智能体分析任务，含两条
 * 相互独立、各带并发上限的队列（按 runMode 各一条）。
 *
 * 为什么两条队列？"full" 运行（完整辩论+评审+评级）消耗大量 LLM token；
 * "summary" 运行更便宜。允许 summary 并发数高于 full，在不打爆 LLM 预算的
 * 前提下保持吞吐。
 *
 * 流程：
 *  - createBatch：解析目标代码（持仓/自选/自定义清单），为每个目标建一条
 *  pending 运行记录，然后有空槽就立即启动，否则推入对应模式队列。
 *  - PipelineService.onRunComplete 在单次运行结束时触发；BatchService 释放
 *  槽位并调用 processQueue 取出下一项。
 *  - 分层模式：`tiered=true` 时，高确信目标（权重 >5% 的持仓，或带买入/强烈
 *  信号的自选股）跑 `full`，其余跑 `summary`。
 *  - createDailyBatch：便捷入口，分层模式跑全部持仓 + 带买入信号的自选股。
 *
 * 上下游：
 *  - 上游（谁调用这里）：multi-agent.controller.ts（批量/每日批次端点）、
 *    定时任务（如日报调度）经 createDailyBatch 进入。
 *  - 下游（本文件调用谁）：MultiAgentService.createRun（建运行记录）、
 *    PipelineService.startPipeline / onRunComplete（启动与完成回调）、
 *    PortfolioContextService.getPortfolioContext（分层模式的持仓权重）。
 * 关键约定：
 *  - 队列只存内存：进程重启后队列丢失，onApplicationBootstrap 会把中断的
 *    运行标记为 failed 使其可重试。
 *  - 同一 (userId, ticker) 同时只能有一个活跃目标（activeTargets 去重）。
 */
import {
  Injectable,
  Inject,
  Logger,
  OnApplicationBootstrap,
  OnModuleInit,
  BadRequestException,
} from '@nestjs/common';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '../../common/platform';
import { eq, and, inArray, sql } from 'drizzle-orm';
import { holdings, watchlist, agentRuns } from '@server/database/schema';
import { MultiAgentService } from './multi-agent.service';
import { PipelineService } from './pipeline.service';
import { PortfolioContextService } from './portfolio-context.service';
import { normalizeAnalysisLanguage, safeAnalysisError } from './analysis-report';
import type {
  BatchRunRequest,
  BatchRunResult,
  BatchRunItem,
  AgentRunMode,
  AgentRunStatus,
  AnalysisLanguage,
} from '@shared/api.interface';

/** 一条在内存队列中等待启动的运行。 */
interface QueueItem {
  runId: string;
  userId: string;
  ticker: string;
  runMode: AgentRunMode;
}

@Injectable()
export class BatchService implements OnModuleInit, OnApplicationBootstrap {
  private readonly logger = new Logger(BatchService.name);
  /** full（昂贵）运行的最大并发数。 */
  private readonly MAX_FULL_CONCURRENT = 3;
  /** summary（便宜）运行的最大并发数。 */
  private readonly MAX_SUMMARY_CONCURRENT = 5;

  /** 各模式下在途运行的实时计数。 */
  private fullRunning = 0;
  private summaryRunning = 0;
  /** 各模式下尚未启动的 FIFO 队列。 */
  private fullQueue: QueueItem[] = [];
  private summaryQueue: QueueItem[] = [];
  private activeTargets = new Set<string>();
  private targetByRun = new Map<string, string>();

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly multiAgentService: MultiAgentService,
    private readonly pipelineService: PipelineService,
    private readonly portfolioContextService: PortfolioContextService,
  ) {}

  /**
   * 模块初始化时订阅流水线完成事件，以便释放槽位并继续清空队列。
   * 只在此注册一次，而不是每次请求都注册。
   */
  onModuleInit(): void {
    this.pipelineService.onRunComplete((runId, userId, mode) => {
      // 运行结束：清掉目标占用与 run→target 映射，释放槽位后立刻补位
      const target = this.targetByRun.get(runId);
      if (!target) return;
      this.activeTargets.delete(target);
      this.targetByRun.delete(runId);
      this.releaseSlot(mode);
      this.processQueue();
    });
  }

  /** 内存队列在进程重启后消失：把孤儿运行标记为可重试。 */
  async onApplicationBootstrap(): Promise<void> {
    // 五种中间态都是"流水线曾持有但进程已丢失"的状态
    const interrupted = [
      'pending',
      'fetching',
      'debating',
      'critiquing',
      'risk_check',
    ] as AgentRunStatus[];
    // 错误文案按运行语言双写（SQL CASE），保持与运行记录的语言一致
    const rows = await this.db
      .update(agentRuns)
      .set({
        status: 'failed',
        errorMessage: sql`CASE WHEN ${agentRuns.language} = 'en' THEN 'Server restarted before analysis finished. Please start a new analysis.' ELSE '服务重启前分析未完成，请重新启动分析。' END`,
        completedAt: new Date(),
      })
      .where(inArray(agentRuns.status, interrupted))
      .returning({ id: agentRuns.id });
    if (rows.length) this.logger.warn(`Marked ${rows.length} interrupted analyses as retryable`);
  }

  /** 排队中的任务尚未占用槽位：直接移除，不减少实时计数。 */
  cancelQueuedRun(runId: string, userId: string): void {
    // 依次查 full、summary 两条队列；找到即摘除并清理目标占用
    for (const queue of [this.fullQueue, this.summaryQueue]) {
      const index = queue.findIndex((item) => item.runId === runId && item.userId === userId);
      if (index < 0) continue;
      queue.splice(index, 1);
      const target = this.targetByRun.get(runId);
      if (target) this.activeTargets.delete(target);
      this.targetByRun.delete(runId);
      return;
    }
  }

  /**
   * 为批量请求创建运行。解析目标、为每个目标建一条 pending 运行记录，
   * 然后立即启动或入队。单个目标的错误被收集后随结果返回，不会中断整批。
   */
  async createBatch(userId: string, req: BatchRunRequest): Promise<BatchRunResult> {
    // 入参校验：scope 必须是四个合法值之一
    if (!req || !['holdings', 'watchlist', 'all', 'custom'].includes(req.scope)) {
      throw new BadRequestException('Select a valid analysis scope');
    }
    // tickers：可选，最多 100 个，每个 1-20 位字母数字与 .^_- 符号
    if (
      req.tickers !== undefined &&
      (!Array.isArray(req.tickers) ||
        req.tickers.length > 100 ||
        req.tickers.some(
          (ticker) => typeof ticker !== 'string' || !/^[A-Za-z0-9.^_-]{1,20}$/u.test(ticker),
        ))
    ) {
      throw new BadRequestException('Provide up to 100 valid ticker symbols');
    }
    // 语言规范化：非法值转成 BadRequest，保留原始错误消息
    let language: AnalysisLanguage;
    try {
      language = normalizeAnalysisLanguage(req.language);
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : 'Invalid analysis language',
      );
    }
    const targets = await this.resolveTargets(userId, req);
    const result: BatchRunResult = {
      created: 0,
      queued: 0,
      running: 0,
      runs: [],
      errors: [],
    };

    // 逐个目标创建运行；同目标已在跑的记一条错误并跳过
    for (const target of targets) {
      const targetKey = `${userId}:${target.ticker.toUpperCase()}`;
      if (this.activeTargets.has(targetKey)) {
        result.errors.push({
          ticker: target.ticker,
          error: 'Analysis is already running for this ticker',
        });
        continue;
      }
      this.activeTargets.add(targetKey);
      try {
        // 建运行记录（pending 态），登记 run→target 映射
        const run = await this.multiAgentService.createRun(userId, {
          ticker: target.ticker,
          tickerName: target.company ?? undefined,
          market: target.market ?? undefined,
          triggerType: 'manual',
          runMode: target.runMode,
          language,
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

        const queueItem: QueueItem = {
          runId: run.id,
          userId,
          ticker: target.ticker,
          runMode: target.runMode,
        };

        // 有空槽则占槽立即启动；否则入对应模式队列等待补位
        if (this.canStart(target.runMode)) {
          this.acquireSlot(target.runMode);
          this.pipelineService.startPipeline(run.id, userId, target.runMode);
          item.status = 'fetching';
          result.running += 1;
        } else {
          this.enqueue(queueItem);
          item.status = 'pending';
          result.queued += 1;
        }
      } catch (err) {
        // 创建失败：释放目标占用，错误用白名单文案归一化后返回
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
   * 每日例行：分层模式跑全部持仓，再分层跑带买入/强烈买入信号的自选股。
   */
  async createDailyBatch(
    userId: string,
    language?: AnalysisLanguage,
  ): Promise<{
    holdingsRuns: BatchRunItem[];
    watchlistRuns: BatchRunItem[];
    totalCreated: number;
    errors: Array<{ ticker: string; error: string }>;
  }> {
    const holdingsResult = await this.createBatch(userId, {
      scope: 'holdings',
      tiered: true,
      language,
    });

    const watchlistItems = await this.getWatchlistTargets(userId);
    // 已在持仓批里出现的代码不再重复分析；自选股按中英文买入信号关键词过滤
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
    });

    return {
      holdingsRuns: holdingsResult.runs,
      watchlistRuns: watchlistResult.runs,
      totalCreated: holdingsResult.created + watchlistResult.created,
      errors: [...holdingsResult.errors, ...watchlistResult.errors],
    };
  }

  /**
   * 在并发上限允许的范围内尽量清空队列，为每个出队项启动流水线。
   * 在单次运行结束后和新批次创建后都会被调用。
   */
  processQueue(): void {
    // full 队列：受 MAX_FULL_CONCURRENT 限制，FIFO 补位
    while (this.fullRunning < this.MAX_FULL_CONCURRENT && this.fullQueue.length > 0) {
      const item = this.fullQueue.shift();
      if (!item) break;
      this.fullRunning += 1;
      this.logger.log(`Dequeued full run: ${item.ticker} (${item.runId})`);
      this.pipelineService.startPipeline(item.runId, item.userId, item.runMode);
    }

    // summary 队列：独立上限，互不占用 full 的槽位
    while (this.summaryRunning < this.MAX_SUMMARY_CONCURRENT && this.summaryQueue.length > 0) {
      const item = this.summaryQueue.shift();
      if (!item) break;
      this.summaryRunning += 1;
      this.logger.log(`Dequeued summary run: ${item.ticker} (${item.runId})`);
      this.pipelineService.startPipeline(item.runId, item.userId, item.runMode);
    }
  }

  /**
   * 把 BatchRunRequest 翻译成待运行的具体代码清单。
   *  - scope='holdings'：全部持仓行。
   *  - scope='watchlist'：全部自选行。
   *  - scope='all'：两者都取。
   *  - scope='custom'：显式代码清单；从持仓/自选行反查公司与市场。
   * tiered=true 时逐代码决定 runMode：权重 >5% 的持仓或买入/强烈信号的自选 →
   * full；否则 summary。
   */
  private async resolveTargets(
    userId: string,
    req: BatchRunRequest,
  ): Promise<
    Array<{ ticker: string; company: string | null; market: string | null; runMode: AgentRunMode }>
  > {
    // 分层模式需要组合权重；非分层请求不查组合上下文
    const portfolio = req.tiered
      ? await this.portfolioContextService.getPortfolioContext(userId)
      : null;

    const targets: Array<{
      ticker: string;
      company: string | null;
      market: string | null;
      runMode: AgentRunMode;
    }> = [];

    // 持仓目标：非分层全部 full；分层按组合权重 >5% 判 full，否则 summary
    if (req.scope === 'holdings' || req.scope === 'all') {
      const holdingRows = await this.db.select().from(holdings).where(eq(holdings.owner, userId));

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

    // 自选目标：分层按中文信号关键词（买入/强烈）判 full
    if (req.scope === 'watchlist' || req.scope === 'all') {
      const watchRows = await this.db.select().from(watchlist).where(eq(watchlist.owner, userId));

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

    // 自定义清单：并行查持仓与自选行，反查公司/市场，并按同一分层规则定 runMode
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
            const ph = portfolio.holdings.find((p) => p.ticker.toUpperCase() === upper);
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

    // 对完整请求做去重，与实时执行状态无关：快速运行可能在后续项创建前
    // 就结束并释放了活跃目标。
    const uniqueTargets = new Map<string, (typeof targets)[number]>();
    for (const target of targets) {
      const key = target.ticker.toUpperCase();
      const existing = uniqueTargets.get(key);
      if (!existing) {
        uniqueTargets.set(key, target);
      } else {
        // 重复代码合并：任一来源要求 full 则升级为 full；公司/市场补空
        if (target.runMode === 'full') existing.runMode = 'full';
        existing.company ??= target.company;
        existing.market ??= target.market;
      }
    }
    return [...uniqueTargets.values()];
  }

  /** 只取调用方自选清单的代码与信号两列。 */
  private async getWatchlistTargets(
    userId: string,
  ): Promise<Array<{ ticker: string; signal: string | null }>> {
    const rows = await this.db
      .select({ ticker: watchlist.ticker, signal: watchlist.signal })
      .from(watchlist)
      .where(eq(watchlist.owner, userId));
    return rows;
  }

  /** @returns 给定模式的新运行能否立即启动。 */
  private canStart(mode: AgentRunMode): boolean {
    if (mode === 'full') return this.fullRunning < this.MAX_FULL_CONCURRENT;
    return this.summaryRunning < this.MAX_SUMMARY_CONCURRENT;
  }

  /** 为给定模式预留一个并发槽位。 */
  private acquireSlot(mode: AgentRunMode): void {
    if (mode === 'full') this.fullRunning += 1;
    else this.summaryRunning += 1;
  }

  /** 运行结束后释放并发槽位（下限 0，防负数）。 */
  private releaseSlot(mode: AgentRunMode): void {
    if (mode === 'full') this.fullRunning = Math.max(0, this.fullRunning - 1);
    else this.summaryRunning = Math.max(0, this.summaryRunning - 1);
  }

  /** 把条目追加到对应模式的队列。 */
  private enqueue(item: QueueItem): void {
    if (item.runMode === 'full') this.fullQueue.push(item);
    else this.summaryQueue.push(item);
    this.logger.log(
      `Queued ${item.runMode} run: ${item.ticker} (queue full=${this.fullQueue.length}, summary=${this.summaryQueue.length})`,
    );
  }
}
