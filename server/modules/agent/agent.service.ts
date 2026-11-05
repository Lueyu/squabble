/**
 * Agent service.
 *
 * Backing service for the LLM-driven analysis agent. It aggregates the user's
 * entire portfolio state (holdings, watchlist, groups, analysis, transactions,
 * closed positions, journal, snapshots, alpha picks, cash) into a single payload
 * for the agent, and persists agent-driven writes: daily analysis notes, holding
 * ratings, watchlist add/remove, journal, snapshots, and deep research reports
 * (each tied to an `agentRuns` row to preserve historical versions). All reads
 * and writes are owner-scoped.
 */
import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '../../common/platform';
import { eq, and, desc, gte, inArray, ne, notIlike } from 'drizzle-orm';
import {
  holdings,
  watchlist,
  groups,
  analysis,
  transactions,
  closed,
  journal,
  snapshots,
  alphaPicks,
  cashAccounts,
  agentRuns,
  deepReport,
  strategyRules,
} from '@server/database/schema';
import type {
  AgentStateResponse,
  Holding,
  WatchItem,
  Group,
  Analysis,
  Transaction,
  ClosedPosition,
  JournalEntry,
  Snapshot,
  AlphaPick,
  CashAccount,
  CreateJournalDto,
  CreateSnapshotDto,
  DeepReport,
  StrategyRule,
} from '@shared/api.interface';
import { SnapshotsService } from '../snapshots/snapshots.service';
import { ResearchDocumentsService } from '../research-documents/research-documents.service';
import { contentHash } from '../research-documents/research-documents.rules';
import type { ResearchInputSnapshot } from '../../../shared/research-document.interface';

/** A single analysis item within a daily-analysis payload. */
interface AnalysisItemDto {
  ticker: string;
  rating?: string;
  action?: string;
  analysis?: string;
  targetPrice?: number;
  catalysts?: string;
  risks?: string;
}

/** Payload for saving a day's analysis notes. */
interface DailyAnalysisDto {
  submissionId?: string;
  dataAsOf?: string;
  snapshot?: ResearchInputSnapshot;
  date: string;
  items: AnalysisItemDto[];
}

/** A single holding-rating update item. */
interface HoldingRatingItem {
  ticker: string;
  rating?: string;
  action?: string;
  analysis?: string;
  targetPrice?: number;
}

/** Payload for applying ratings to holdings. */
interface HoldingRatingsDto {
  items: HoldingRatingItem[];
}

/** Payload for adding/upserting watchlist items. */
interface WatchItemAddDto {
  items: Array<Omit<WatchItem, 'id' | 'dateAdded' | 'updatedAt'> & { dateAdded?: string }>;
}

/** Payload for removing watchlist items by ticker. */
interface WatchItemRemoveDto {
  tickers: string[];
}

/**
 * Provides portfolio aggregation and agent-driven writes. Depends on the Drizzle
 * database and `SnapshotsService` (for snapshot upsert/list).
 */
@Injectable()
export class AgentService {
  private readonly logger = new Logger(AgentService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly snapshotsService: SnapshotsService,
  ) {}

  /**
   * Builds the full portfolio state for the agent: loads all owner-scoped tables
   * in parallel and maps them to API DTOs.
   *
   * @param userId Owner id.
   */
  async getState(userId: string): Promise<AgentStateResponse> {
    const [
      holdingRows,
      watchRows,
      groupRows,
      analysisRows,
      txRows,
      closedRows,
      journalRows,
      snapshotRows,
      alphaRows,
      cashRows,
    ] = await Promise.all([
      this.db.select().from(holdings).where(eq(holdings.owner, userId)),
      this.db.select().from(watchlist).where(eq(watchlist.owner, userId)),
      this.db.select().from(groups).where(eq(groups.owner, userId)).orderBy(groups.sort),
      this.db.select().from(analysis).where(eq(analysis.owner, userId)).orderBy(desc(analysis.analysisDate)),
      this.db.select().from(transactions).where(eq(transactions.owner, userId)).orderBy(desc(transactions.txDate)),
      this.db.select().from(closed).where(eq(closed.owner, userId)).orderBy(desc(closed.closeDate)),
      this.db.select().from(journal).where(eq(journal.owner, userId)).orderBy(desc(journal.journalDate)),
      this.db.select().from(snapshots).where(eq(snapshots.owner, userId)).orderBy(desc(snapshots.snapshotDate)),
      this.db.select().from(alphaPicks).where(eq(alphaPicks.owner, userId)).orderBy(desc(alphaPicks.datePicked)),
      this.db.select().from(cashAccounts).where(eq(cashAccounts.owner, userId)),
    ]);

    const cashAccountsList: CashAccount[] = cashRows.map((row) => ({
      id: row.id,
      currency: row.currency as CashAccount['currency'],
      balance: String(row.balance),
      updatedAt: row.updatedAt.toISOString(),
    }));

    const usdCash = cashAccountsList.find((c) => c.currency === 'USD')?.balance ?? '0';

    return {
      holdings: holdingRows.map((row) => this.mapHolding(row)),
      watchlist: watchRows.map((row) => this.mapWatchItem(row)),
      groups: groupRows.map((row) => this.mapGroup(row)),
      analysis: analysisRows.map((row) => this.mapAnalysis(row)),
      transactions: txRows.map((row) => this.mapTransaction(row)),
      closed: closedRows.map((row) => this.mapClosed(row)),
      journal: journalRows.map((row) => this.mapJournal(row)),
      snapshots: snapshotRows.map((row) => this.mapSnapshot(row)),
      alphaPicks: alphaRows.map((row) => this.mapAlphaPick(row)),
      cash: usdCash,
      cashAccounts: cashAccountsList,
    };
  }

  /**
   * Returns recent history for the agent: analysis and snapshots from the last 180
   * days, all transactions, and all holdings.
   *
   * @param userId Owner id.
   */
  async getHistory(userId: string): Promise<{
    analysis: Analysis[];
    transactions: Transaction[];
    snapshots: Snapshot[];
    holdings: Holding[];
  }> {
    const now = new Date();
    const cutoff = new Date(now.getTime() - 180 * 24 * 60 * 60 * 1000);
    const cutoffStr = cutoff.toISOString().split('T')[0];

    const [analysisRows, txRows, snapshotRows, holdingRows] = await Promise.all([
      this.db
        .select()
        .from(analysis)
        .where(and(eq(analysis.owner, userId), gte(analysis.analysisDate, cutoffStr)))
        .orderBy(desc(analysis.analysisDate)),
      this.db
        .select()
        .from(transactions)
        .where(eq(transactions.owner, userId))
        .orderBy(desc(transactions.txDate)),
      this.db
        .select()
        .from(snapshots)
        .where(and(eq(snapshots.owner, userId), gte(snapshots.snapshotDate, cutoffStr)))
        .orderBy(desc(snapshots.snapshotDate)),
      this.db.select().from(holdings).where(eq(holdings.owner, userId)),
    ]);

    return {
      analysis: analysisRows.map((row) => this.mapAnalysis(row)),
      transactions: txRows.map((row) => this.mapTransaction(row)),
      snapshots: snapshotRows.map((row) => this.mapSnapshot(row)),
      holdings: holdingRows.map((row) => this.mapHolding(row)),
    };
  }

  /**
   * Saves a batch of analysis notes for a date, upserting each ticker on
   * (owner, date, ticker).
   *
   * @param userId Owner id.
   * @param dto    Day's analysis payload.
   */
  async saveDailyAnalysis(userId: string, dto: DailyAnalysisDto): Promise<{ saved: number }> {
    if (!Array.isArray(dto.items) || dto.items.length > 200 || !/^\d{4}-\d{2}-\d{2}$/u.test(dto.date)) {
      throw new BadRequestException('REPORT_INVALID_SUBMISSION');
    }
    const documents = new ResearchDocumentsService(this.db);
    return documents.withSubmission(userId, `agent-daily:${dto.submissionId ?? contentHash(dto)}`, dto, async tx => {
      for (const item of dto.items) {
        if (!/^[A-Z0-9.^/_-]{1,20}$/iu.test(item.ticker)) throw new BadRequestException('REPORT_INVALID_SUBMISSION');
        await documents.writeDailyInTransaction(tx, userId, { analysisDate: dto.date, ticker: item.ticker,
          rating: item.rating, action: item.action, analysis: item.analysis,
          targetPrice: item.targetPrice !== undefined ? String(item.targetPrice) : undefined,
          catalysts: item.catalysts, risks: item.risks },
        { dataAsOf: dto.dataAsOf ?? null, availableAt: new Date().toISOString(), snapshot: dto.snapshot ?? null });
      }
      return { saved: dto.items.length };
    });
  }

  /**
   * Applies ratings/actions/targets to the user's existing holdings. Items with
   * no updatable fields, or matching no holding, are skipped.
   *
   * @param userId Owner id.
   * @param dto    Holdings ratings payload.
   */
  async applyHoldingRatings(
    userId: string,
    dto: HoldingRatingsDto,
  ): Promise<{ updated: number; skipped: number }> {
    let updated = 0;
    let skipped = 0;

    for (const item of dto.items) {
      const patch: Record<string, unknown> = {};
      if (item.rating !== undefined) patch.rating = item.rating;
      if (item.action !== undefined) patch.action = item.action;
      if (item.analysis !== undefined) patch.analysis = item.analysis;
      if (item.targetPrice !== undefined) patch.targetPrice = String(item.targetPrice);

      if (Object.keys(patch).length === 0) {
        skipped += 1;
        continue;
      }

      patch.updatedAt = new Date();
      patch.updatedBy = userId;

      const rows = await this.db
        .update(holdings)
        .set(patch)
        .where(and(eq(holdings.ticker, item.ticker), eq(holdings.owner, userId)))
        .returning({ id: holdings.id });

      if (rows.length === 0) {
        skipped += 1;
      } else {
        updated += 1;
      }
    }

    return { updated, skipped };
  }

  /**
   * Adds or updates watchlist items. Existing tickers are patched; new ones are
   * inserted (dateAdded defaults to today).
   *
   * @param userId Owner id.
   * @param dto    Watchlist items payload.
   */
  async addWatchItems(
    userId: string,
    dto: WatchItemAddDto,
  ): Promise<{ added: number; updated: number }> {
    let added = 0;
    let updated = 0;

    const today = new Date().toISOString().split('T')[0];

    for (const item of dto.items) {
      const existing = await this.db
        .select({ id: watchlist.id })
        .from(watchlist)
        .where(and(eq(watchlist.ticker, item.ticker), eq(watchlist.owner, userId)));

      if (existing.length > 0) {
        const patch: Record<string, unknown> = {};
        if (item.company !== undefined) patch.company = item.company;
        if (item.sector !== undefined) patch.sector = item.sector;
        if (item.entryPrice !== undefined) patch.entryPrice = String(item.entryPrice);
        if (item.currentPrice !== undefined) patch.currentPrice = String(item.currentPrice);
        if (item.rating !== undefined) patch.rating = item.rating;
        if (item.signal !== undefined) patch.signal = item.signal;
        if (item.targetBuy !== undefined) patch.targetBuy = String(item.targetBuy);
        if (item.analysis !== undefined) patch.analysis = item.analysis;
        patch.updatedAt = new Date();
        patch.updatedBy = userId;

        await this.db
          .update(watchlist)
          .set(patch)
          .where(and(eq(watchlist.ticker, item.ticker), eq(watchlist.owner, userId)));
        updated += 1;
      } else {
        await this.db.insert(watchlist).values({
          ticker: item.ticker,
          company: item.company,
          sector: item.sector,
          dateAdded: item.dateAdded ?? today,
          entryPrice: item.entryPrice !== undefined ? String(item.entryPrice) : undefined,
          currentPrice: item.currentPrice !== undefined ? String(item.currentPrice) : undefined,
          rating: item.rating,
          signal: item.signal,
          targetBuy: item.targetBuy !== undefined ? String(item.targetBuy) : undefined,
          analysis: item.analysis,
          owner: userId,
        });
        added += 1;
      }
    }

    return { added, updated };
  }

  /**
   * Removes owned watchlist items by ticker.
   *
   * @param userId Owner id.
   * @param dto    Tickers to remove.
   */
  async removeWatchItems(userId: string, dto: WatchItemRemoveDto): Promise<{ removed: number }> {
    if (dto.tickers.length === 0) return { removed: 0 };

    const rows = await this.db
      .delete(watchlist)
      .where(and(inArray(watchlist.ticker, dto.tickers), eq(watchlist.owner, userId)))
      .returning({ id: watchlist.id });

    return { removed: rows.length };
  }

  /**
   * Creates or updates (upserts) the journal entry for a date on
   * (owner, journalDate).
   *
   * @param userId Owner id.
   * @param dto    Journal payload.
   */
  async saveJournal(userId: string, dto: CreateJournalDto): Promise<JournalEntry> {
    const rows = await this.db
      .insert(journal)
      .values({
        journalDate: dto.journalDate,
        marketSummary: dto.marketSummary,
        portfolioSummary: dto.portfolioSummary,
        actions: dto.actions,
        plan: dto.plan,
        lessons: dto.lessons,
        owner: userId,
      })
      .onConflictDoUpdate({
        target: [journal.owner, journal.journalDate],
        set: {
          marketSummary: dto.marketSummary,
          portfolioSummary: dto.portfolioSummary,
          actions: dto.actions,
          plan: dto.plan,
          lessons: dto.lessons,
          updatedAt: new Date(),
          updatedBy: userId,
        },
      })
      .returning();

    return this.mapJournal(rows[0]);
  }

  /**
   * Returns all journal entries for the user, newest first.
   *
   * @param userId Owner id.
   */
  async getJournal(userId: string): Promise<JournalEntry[]> {
    const rows = await this.db
      .select()
      .from(journal)
      .where(eq(journal.owner, userId))
      .orderBy(desc(journal.journalDate));

    return rows.map((row) => this.mapJournal(row));
  }

  /**
   * Creates or updates the snapshot for a date (delegated to SnapshotsService,
   * which also recomputes net deposits and daily P&L).
   *
   * @param userId Owner id.
   * @param dto    Snapshot payload.
   */
  async saveSnapshot(userId: string, dto: CreateSnapshotDto): Promise<Snapshot> {
    return this.snapshotsService.upsert(userId, dto);
  }

  /**
   * Returns up to 365 snapshots, newest first.
   *
   * @param userId Owner id.
   */
  async getSnapshots(userId: string): Promise<Snapshot[]> {
    const result = await this.snapshotsService.list(userId, 365);
    return result.items;
  }

  /**
   * Saves a deep research report. Validates the ticker (rejects malformed or
   * TESTDEEP tickers). Each distinct submission creates a new `agentRuns` row;
   * retries return the same saved source and immutable document version.
   *
   * @param userId Owner id.
   * @param input  Deep report fields (without id/runId timestamps).
   * @throws BadRequestException if the ticker is invalid.
   */
  async saveDeepReport(
    userId: string,
    input: Omit<DeepReport, 'id' | 'runId' | 'createdAt' | 'updatedAt'> & { reportDate?: string; submissionId?: string; dataAsOf?: string; snapshot?: ResearchInputSnapshot },
  ): Promise<{ ok: boolean; runId: string; deepReportId: string; reportDate: string }> {
    const ticker = input.ticker?.trim().toUpperCase() ?? '';
    const tickerRegex = /^[A-Z0-9.]{1,20}$/;
    if (!tickerRegex.test(ticker)) {
      throw new BadRequestException(`无效的股票代码: ${input.ticker}`);
    }
    if (/TESTDEEP/i.test(ticker)) {
      throw new BadRequestException(`无效的股票代码: ${input.ticker}`);
    }

    const reportDate = input.reportDate ?? this.getTodayInShanghai();
    const inputExtra = input as unknown as { tickerName?: string; companyName?: string };
    const tickerName = inputExtra.tickerName ?? inputExtra.companyName ?? null;

    const documents = new ResearchDocumentsService(this.db);
    return documents.withSubmission(userId, `agent-deep:${input.submissionId ?? contentHash(input)}`, input, async tx => {
      // The durable submission receipt prevents retries from creating another run.
      const [inserted] = await tx
        .insert(agentRuns)
        .values({
          ticker,
          tickerName,
          triggerType: 'agent',
          runMode: 'full',
          status: 'completed',
          startedAt: new Date(),
          completedAt: new Date(),
          owner: userId,
        })
        .returning({ id: agentRuns.id });
      const runId = inserted.id;

      // Upsert deep report by run_id
      const deepValues = {
        runId,
        ticker,
        rating: input.rating ?? null,
        confidence: input.confidence ?? null,
        targetBear: input.targetBear ?? null,
        targetBase: input.targetBase ?? null,
        targetBull: input.targetBull ?? null,
        probBear: input.probBear ?? null,
        probBase: input.probBase ?? null,
        probBull: input.probBull ?? null,
        coreThesis: input.coreThesis ?? null,
        viewChange: input.viewChange ?? null,
        prevRating: input.prevRating ?? null,
        companyOverview: input.companyOverview ?? null,
        businessModel: input.businessModel ?? null,
        moat: input.moat ?? null,
        revenueStructure: (input.revenueStructure as unknown as Record<string, unknown> | null) ?? null,
        financialAnnual: (input.financialAnnual as unknown as Record<string, unknown> | null) ?? null,
        financialQuarterly: (input.financialQuarterly as unknown as Record<string, unknown> | null) ?? null,
        profitability: (input.profitability as unknown as Record<string, unknown> | null) ?? null,
        balanceSheet: (input.balanceSheet as unknown as Record<string, unknown> | null) ?? null,
        cashFlow: (input.cashFlow as unknown as Record<string, unknown> | null) ?? null,
        financialQuality: input.financialQuality ?? null,
        segmentAnalysis: (input.segmentAnalysis as unknown as Record<string, unknown> | null) ?? null,
        valuationRelative: (input.valuationRelative as unknown as Record<string, unknown> | null) ?? null,
        valuationSotp: (input.valuationSotp as unknown as Record<string, unknown> | null) ?? null,
        valuationMethodology: input.valuationMethodology ?? null,
        industryOverview: input.industryOverview ?? null,
        marketSize: input.marketSize ?? null,
        competitivePosition: input.competitivePosition ?? null,
        industryTrends: input.industryTrends ?? null,
        bullPoints: (input.bullPoints as unknown as Record<string, unknown> | null) ?? null,
        bearPoints: (input.bearPoints as unknown as Record<string, unknown> | null) ?? null,
        criticPoints: (input.criticPoints as unknown as Record<string, unknown> | null) ?? null,
        revisedAssumptions: input.revisedAssumptions ?? null,
        catalystsTimeline: (input.catalystsTimeline as unknown as Record<string, unknown> | null) ?? null,
        riskItems: (input.riskItems as unknown as Record<string, unknown> | null) ?? null,
        riskGateSnapshot: (input.riskGateSnapshot as unknown as Record<string, unknown> | null) ?? null,
        pmAction: input.pmAction ?? null,
        pmPriceRange: input.pmPriceRange ?? null,
        pmPositionSize: input.pmPositionSize ?? null,
        pmStopLoss: input.pmStopLoss ?? null,
        pmExecutionPlan: input.pmExecutionPlan ?? null,
        trackingMetrics: (input.trackingMetrics as unknown as Record<string, unknown> | null) ?? null,
        viewChangeTriggers: input.viewChangeTriggers ?? null,
        owner: userId,
      };

      const [upserted] = await tx
        .insert(deepReport)
        .values(deepValues)
          .onConflictDoUpdate({
            target: [deepReport.runId],
            set: {
              ticker,
            rating: input.rating ?? null,
            confidence: input.confidence ?? null,
            targetBear: input.targetBear ?? null,
            targetBase: input.targetBase ?? null,
            targetBull: input.targetBull ?? null,
            probBear: input.probBear ?? null,
            probBase: input.probBase ?? null,
            probBull: input.probBull ?? null,
            coreThesis: input.coreThesis ?? null,
            viewChange: input.viewChange ?? null,
            prevRating: input.prevRating ?? null,
            companyOverview: input.companyOverview ?? null,
            businessModel: input.businessModel ?? null,
            moat: input.moat ?? null,
            revenueStructure: (input.revenueStructure as unknown as Record<string, unknown> | null) ?? null,
            financialAnnual: (input.financialAnnual as unknown as Record<string, unknown> | null) ?? null,
            financialQuarterly: (input.financialQuarterly as unknown as Record<string, unknown> | null) ?? null,
            profitability: (input.profitability as unknown as Record<string, unknown> | null) ?? null,
            balanceSheet: (input.balanceSheet as unknown as Record<string, unknown> | null) ?? null,
            cashFlow: (input.cashFlow as unknown as Record<string, unknown> | null) ?? null,
            financialQuality: input.financialQuality ?? null,
            segmentAnalysis: (input.segmentAnalysis as unknown as Record<string, unknown> | null) ?? null,
            valuationRelative: (input.valuationRelative as unknown as Record<string, unknown> | null) ?? null,
            valuationSotp: (input.valuationSotp as unknown as Record<string, unknown> | null) ?? null,
            valuationMethodology: input.valuationMethodology ?? null,
            industryOverview: input.industryOverview ?? null,
            marketSize: input.marketSize ?? null,
            competitivePosition: input.competitivePosition ?? null,
            industryTrends: input.industryTrends ?? null,
            bullPoints: (input.bullPoints as unknown as Record<string, unknown> | null) ?? null,
            bearPoints: (input.bearPoints as unknown as Record<string, unknown> | null) ?? null,
            criticPoints: (input.criticPoints as unknown as Record<string, unknown> | null) ?? null,
            revisedAssumptions: input.revisedAssumptions ?? null,
            catalystsTimeline: (input.catalystsTimeline as unknown as Record<string, unknown> | null) ?? null,
            riskItems: (input.riskItems as unknown as Record<string, unknown> | null) ?? null,
            riskGateSnapshot: (input.riskGateSnapshot as unknown as Record<string, unknown> | null) ?? null,
            pmAction: input.pmAction ?? null,
            pmPriceRange: input.pmPriceRange ?? null,
            pmPositionSize: input.pmPositionSize ?? null,
            pmStopLoss: input.pmStopLoss ?? null,
            pmExecutionPlan: input.pmExecutionPlan ?? null,
            trackingMetrics: (input.trackingMetrics as unknown as Record<string, unknown> | null) ?? null,
            viewChangeTriggers: input.viewChangeTriggers ?? null,
            updatedAt: new Date(),
            updatedBy: userId,
          },
        })
        .returning({ id: deepReport.id });

      await documents.importSourceInTransaction(tx, userId, { type: 'deep', id: upserted.id },
        { dataAsOf: input.dataAsOf ?? null, availableAt: new Date().toISOString(), snapshot: input.snapshot ?? null });
      return {
        ok: true,
        runId,
        deepReportId: upserted.id,
        reportDate,
      };
    });
  }

  /**
   * Returns the user's strategy rules, ordered by sort then rule key.
   *
   * @param userId Owner id.
   */
  async getStrategyRules(userId: string): Promise<StrategyRule[]> {
    const rows = await this.db
      .select()
      .from(strategyRules)
      .where(eq(strategyRules.owner, userId))
      .orderBy(strategyRules.sort, strategyRules.ruleKey);

    return rows.map((row) => ({
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
    }));
  }

  /**
   * Returns the latest completed full deep report for a ticker (excluding test
   * runs), joined from agentRuns + deepReport.
   *
   * @param userId Owner id.
   * @param ticker Target ticker.
   */
  async getLatestDeepReport(
    userId: string,
    ticker: string,
  ): Promise<{
    runId: string;
    ticker: string;
    tickerName: string | null;
    rating: string | null;
    confidence: string | null;
    targetBear: string | null;
    targetBase: string | null;
    targetBull: string | null;
    updatedAt: string;
  } | null> {
    const rows = await this.db
      .select({
        runId: agentRuns.id,
        ticker: agentRuns.ticker,
        tickerName: agentRuns.tickerName,
        rating: deepReport.rating,
        confidence: deepReport.confidence,
        targetBear: deepReport.targetBear,
        targetBase: deepReport.targetBase,
        targetBull: deepReport.targetBull,
        updatedAt: deepReport.updatedAt,
      })
      .from(agentRuns)
      .innerJoin(deepReport, eq(agentRuns.id, deepReport.runId))
      .where(
        and(
          eq(agentRuns.owner, userId),
          eq(agentRuns.ticker, ticker),
          eq(agentRuns.runMode, 'full'),
          eq(agentRuns.status, 'completed'),
          notIlike(agentRuns.ticker, '%testdeep%'),
        ),
      )
      .orderBy(desc(agentRuns.completedAt), desc(agentRuns.createdAt))
      .limit(1);

    if (rows.length === 0) return null;
    const row = rows[0];
    return {
      runId: row.runId,
      ticker: row.ticker,
      tickerName: row.tickerName ?? null,
      rating: row.rating ?? null,
      confidence: row.confidence ?? null,
      targetBear: row.targetBear?.toString() ?? null,
      targetBase: row.targetBase?.toString() ?? null,
      targetBull: row.targetBull?.toString() ?? null,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /**
   * Lists the user's completed full deep reports, newest first (excluding test
   * runs).
   *
   * @param userId Owner id.
   */
  async listDeepReports(
    userId: string,
  ): Promise<Array<{
    runId: string;
    ticker: string;
    tickerName: string | null;
    rating: string | null;
    confidence: string | null;
    targetBear: string | null;
    targetBase: string | null;
    targetBull: string | null;
     reportDate: string;
     completedAt: string;
     updatedAt: string;
   }>> {
    const rows = await this.db
      .select({
        runId: agentRuns.id,
        ticker: agentRuns.ticker,
        tickerName: agentRuns.tickerName,
        rating: deepReport.rating,
        confidence: deepReport.confidence,
        targetBear: deepReport.targetBear,
        targetBase: deepReport.targetBase,
        targetBull: deepReport.targetBull,
        completedAt: agentRuns.completedAt,
        updatedAt: deepReport.updatedAt,
      })
      .from(agentRuns)
      .innerJoin(deepReport, eq(agentRuns.id, deepReport.runId))
      .where(
        and(
          eq(agentRuns.owner, userId),
          eq(agentRuns.runMode, 'full'),
          eq(agentRuns.status, 'completed'),
          notIlike(agentRuns.ticker, '%testdeep%'),
        ),
      )
      .orderBy(desc(agentRuns.completedAt), desc(deepReport.updatedAt));

    return rows.map((row) => ({
      runId: row.runId,
      ticker: row.ticker,
      tickerName: row.tickerName ?? null,
      rating: row.rating ?? null,
      confidence: row.confidence ?? null,
      targetBear: row.targetBear?.toString() ?? null,
      targetBase: row.targetBase?.toString() ?? null,
      targetBull: row.targetBull?.toString() ?? null,
       reportDate: (row.completedAt ?? row.updatedAt).toISOString().slice(0, 10),
       completedAt: (row.completedAt ?? row.updatedAt).toISOString(),
       updatedAt: row.updatedAt.toISOString(),
     }));
  }

  /**
   * Returns today's date (YYYY-MM-DD) in the Shanghai (UTC+8) timezone, used as
   * the default report date.
   */
  private getTodayInShanghai(): string {
    const now = new Date();
    const shanghaiTime = new Date(now.getTime() + 8 * 60 * 60 * 1000);
    return shanghaiTime.toISOString().slice(0, 10);
  }

  /** Maps a raw holdings row to the API `Holding` DTO. */
  private mapHolding(row: typeof holdings.$inferSelect): Holding {
    return {
      id: row.id,
      ticker: row.ticker,
      company: row.company ?? null,
      sector: row.sector ?? null,
      buyDate: row.buyDate ?? null,
      buyPrice: row.buyPrice ? String(row.buyPrice) : null,
      shares: String(row.shares),
      currentPrice: row.currentPrice ? String(row.currentPrice) : null,
      rating: row.rating ?? null,
      action: row.action ?? null,
      analysis: row.analysis ?? null,
      targetPrice: row.targetPrice ? String(row.targetPrice) : null,
      groupId: row.groupId ?? null,
      market: (row.market as Holding['market']) || 'US',
      currency: (row.currency as Holding['currency']) || 'USD',
      symbolNative: row.symbolNative ?? null,
      displaySymbol: row.displaySymbol ?? null,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /** Maps a raw watchlist row to the API `WatchItem` DTO. */
  private mapWatchItem(row: typeof watchlist.$inferSelect): WatchItem {
    return {
      id: row.id,
      ticker: row.ticker,
      company: row.company ?? null,
      sector: row.sector ?? null,
      dateAdded: row.dateAdded ?? null,
      entryPrice: row.entryPrice ? String(row.entryPrice) : null,
      currentPrice: row.currentPrice ? String(row.currentPrice) : null,
      rating: row.rating ?? null,
      signal: row.signal ?? null,
      targetBuy: row.targetBuy ? String(row.targetBuy) : null,
      analysis: row.analysis ?? null,
      market: (row.market as WatchItem['market']) || 'US',
      currency: (row.currency as WatchItem['currency']) || 'USD',
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /** Maps a raw groups row to the API `Group` DTO. */
  private mapGroup(row: typeof groups.$inferSelect): Group {
    return {
      id: row.id,
      name: row.name,
      color: row.color ?? null,
      sort: row.sort ?? 0,
    };
  }

  /** Maps a raw analysis row to the API `Analysis` DTO. */
  private mapAnalysis(row: typeof analysis.$inferSelect): Analysis {
    return {
      id: row.id,
      analysisDate: row.analysisDate,
      ticker: row.ticker,
      rating: row.rating ?? null,
      action: row.action ?? null,
      analysis: row.analysis ?? null,
      targetPrice: row.targetPrice ? String(row.targetPrice) : null,
      catalysts: row.catalysts ?? null,
      risks: row.risks ?? null,
      createdAt: row.createdAt.toISOString(),
    };
  }

  /** Maps a raw transactions row to the API `Transaction` DTO. */
  private mapTransaction(row: typeof transactions.$inferSelect): Transaction {
    return {
      id: row.id,
      txDate: String(row.txDate),
      ticker: row.ticker,
      txType: row.txType as Transaction['txType'],
      shares: String(row.shares),
      price: String(row.price),
      fees: String(row.fees ?? '0'),
      notes: row.notes ?? null,
      currency: (row.currency as Transaction['currency']) || 'USD',
    };
  }

  /** Maps a raw closed-positions row to the API `ClosedPosition` DTO. */
  private mapClosed(row: typeof closed.$inferSelect): ClosedPosition {
    return {
      id: row.id,
      ticker: row.ticker,
      company: row.company ?? null,
      openDate: row.openDate ?? null,
      closeDate: row.closeDate ?? null,
      buyPrice: row.buyPrice ? String(row.buyPrice) : null,
      sellPrice: row.sellPrice ? String(row.sellPrice) : null,
      shares: row.shares ? String(row.shares) : null,
      realizedPl: row.realizedPl ? String(row.realizedPl) : null,
      returnPct: row.returnPct ? String(row.returnPct) : null,
      notes: row.notes ?? null,
    };
  }

  /** Maps a raw journal row to the API `JournalEntry` DTO. */
  private mapJournal(row: typeof journal.$inferSelect): JournalEntry {
    return {
      id: row.id,
      journalDate: row.journalDate,
      marketSummary: row.marketSummary ?? null,
      portfolioSummary: row.portfolioSummary ?? null,
      actions: row.actions ?? null,
      plan: row.plan ?? null,
      lessons: row.lessons ?? null,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /** Maps a raw snapshots row to the API `Snapshot` DTO. */
  private mapSnapshot(row: typeof snapshots.$inferSelect): Snapshot {
    const dateStr =
      typeof row.snapshotDate === 'string'
        ? row.snapshotDate
        : (row.snapshotDate as unknown as Date).toISOString().slice(0, 10);
    return {
      id: row.id,
      snapshotDate: dateStr,
      accountValue: row.accountValue != null ? String(row.accountValue) : null,
      totalMv: row.totalMv != null ? String(row.totalMv) : null,
      cost: row.cost != null ? String(row.cost) : null,
      cash: row.cash != null ? String(row.cash) : null,
      totalPl: row.totalPl != null ? String(row.totalPl) : null,
      dailyPl: row.dailyPl != null ? String(row.dailyPl) : null,
      dailyPct: row.dailyPct != null ? String(row.dailyPct) : null,
      netDeposit: row.netDeposit != null ? String(row.netDeposit) : null,
      cumulativeNetDeposit:
        row.cumulativeNetDeposit != null ? String(row.cumulativeNetDeposit) : null,
    };
  }

  /** Maps a raw alpha-picks row to the API `AlphaPick` DTO. */
  private mapAlphaPick(row: typeof alphaPicks.$inferSelect): AlphaPick {
    return {
      id: row.id,
      ticker: row.ticker,
      company: row.company ?? null,
      sector: row.sector ?? null,
      datePicked: row.datePicked ?? null,
      returnPct: row.returnPct ? String(row.returnPct) : null,
      rating: row.rating ?? null,
      weightPct: row.weightPct ? String(row.weightPct) : null,
    };
  }
}
