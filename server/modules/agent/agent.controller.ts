/**
 * Agent controller.
 *
 * Exposes endpoints consumed by the LLM-driven analysis agent under `/api/agent`:
 * fetching the full portfolio state / history, saving daily analysis and holding
 * ratings, mutating the watchlist, saving journal entries and snapshots, and
 * reading/writing deep research reports and strategy rules. Requires login.
 */
import { Controller, Get, Post, Body, Req, Query } from '@nestjs/common';
import { NeedLogin } from '../../common/platform';
import type { Request } from 'express';
import { AgentService } from './agent.service';
import type {
  AgentStateResponse,
  CreateJournalDto,
  CreateSnapshotDto,
  JournalEntry,
  Snapshot,
  WatchItem,
  Analysis,
  Transaction,
  Holding,
} from '@shared/api.interface';

/** Payload for saving a day's worth of analysis notes. */
interface DailyAnalysisDto {
  submissionId?: string;
  dataAsOf?: string;
  snapshot?: import('../../../shared/research-document.interface').ResearchInputSnapshot;
  date: string;
  items: Array<{
    ticker: string;
    rating?: string;
    action?: string;
    analysis?: string;
    targetPrice?: number;
    catalysts?: string;
    risks?: string;
  }>;
}

/** Payload for applying ratings/actions to existing holdings. */
interface HoldingRatingsDto {
  items: Array<{
    ticker: string;
    rating?: string;
    action?: string;
    analysis?: string;
    targetPrice?: number;
  }>;
}

/** Payload for adding/upserting watchlist items. */
interface WatchItemsAddDto {
  items: Array<Omit<WatchItem, 'id' | 'dateAdded' | 'updatedAt'> & { dateAdded?: string }>;
}

/** Payload for removing watchlist items by ticker. */
interface WatchItemsRemoveDto {
  tickers: string[];
}

/**
 * REST controller for the agent. Delegates all work to `AgentService`.
 */
@NeedLogin()
@Controller('api/agent')
export class AgentController {
  constructor(private readonly agentService: AgentService) {}

  /**
   * Returns the full portfolio state (holdings, watchlist, groups, analysis,
   * transactions, closed positions, journal, snapshots, alpha picks, cash) for the
   * agent to reason over.
   *
   * @param req Authenticated request carrying `req.userContext.userId`.
   */
  @Get('state')
  async getState(@Req() req: Request): Promise<AgentStateResponse> {
    const { userId } = req.userContext;
    return this.agentService.getState(userId);
  }

  /**
   * Returns recent history (analysis, transactions, snapshots, holdings) scoped to
   * the last ~180 days where applicable.
   *
   * @param req Authenticated request.
   */
  @Get('history')
  async getHistory(
    @Req() req: Request,
  ): Promise<{
    analysis: Analysis[];
    transactions: Transaction[];
    snapshots: Snapshot[];
    holdings: Holding[];
  }> {
    const { userId } = req.userContext;
    return this.agentService.getHistory(userId);
  }

  /**
   * Saves a batch of analysis notes for a date (upserted per ticker).
   *
   * @param req  Authenticated request.
   * @param dto  Day's analysis payload.
   */
  @Post('daily-analysis')
  async saveDailyAnalysis(
    @Req() req: Request,
    @Body() dto: DailyAnalysisDto,
  ): Promise<{ saved: number }> {
    const { userId } = req.userContext;
    return this.agentService.saveDailyAnalysis(userId, dto);
  }

  /**
   * Applies ratings/actions/targets to the user's existing holdings.
   *
   * @param req Authenticated request.
   * @param dto Holdings ratings payload.
   */
  @Post('holding-ratings')
  async applyHoldingRatings(
    @Req() req: Request,
    @Body() dto: HoldingRatingsDto,
  ): Promise<{ updated: number; skipped: number }> {
    const { userId } = req.userContext;
    return this.agentService.applyHoldingRatings(userId, dto);
  }

  /**
   * Adds or updates watchlist items.
   *
   * @param req Authenticated request.
   * @param dto Watchlist items payload.
   */
  @Post('watch-items/add')
  async addWatchItems(
    @Req() req: Request,
    @Body() dto: WatchItemsAddDto,
  ): Promise<{ added: number; updated: number }> {
    const { userId } = req.userContext;
    return this.agentService.addWatchItems(userId, dto);
  }

  /**
   * Removes watchlist items by ticker.
   *
   * @param req Authenticated request.
   * @param dto Tickers to remove.
   */
  @Post('watch-items/remove')
  async removeWatchItems(
    @Req() req: Request,
    @Body() dto: WatchItemsRemoveDto,
  ): Promise<{ removed: number }> {
    const { userId } = req.userContext;
    return this.agentService.removeWatchItems(userId, dto);
  }

  /**
   * Creates or updates the journal entry for a date.
   *
   * @param req Authenticated request.
   * @param dto Journal payload.
   */
  @Post('journal')
  async saveJournal(@Req() req: Request, @Body() dto: CreateJournalDto): Promise<JournalEntry> {
    const { userId } = req.userContext;
    return this.agentService.saveJournal(userId, dto);
  }

  /**
   * Returns all journal entries, newest first.
   *
   * @param req Authenticated request.
   */
  @Get('journal')
  async getJournal(@Req() req: Request): Promise<JournalEntry[]> {
    const { userId } = req.userContext;
    return this.agentService.getJournal(userId);
  }

  /**
   * Creates or updates the snapshot for a date (delegated to SnapshotsService).
   *
   * @param req Authenticated request.
   * @param dto Snapshot payload.
   */
  @Post('snapshot')
  async saveSnapshot(@Req() req: Request, @Body() dto: CreateSnapshotDto): Promise<Snapshot> {
    const { userId } = req.userContext;
    return this.agentService.saveSnapshot(userId, dto);
  }

  /**
   * Returns up to 365 snapshots, newest first.
   *
   * @param req Authenticated request.
   */
  @Get('snapshots')
  async getSnapshots(@Req() req: Request): Promise<Snapshot[]> {
    const { userId } = req.userContext;
    return this.agentService.getSnapshots(userId);
  }

  /**
   * Saves a deep research report (creates a new agent run to preserve history).
   *
   * @param req  Authenticated request.
   * @param body Deep report fields.
   */
  @Post('deep-report')
  async saveDeepReport(
    @Req() req: Request,
    @Body() body: Record<string, unknown>,
  ): Promise<{ ok: boolean; runId: string; deepReportId: string; reportDate: string }> {
    const { userId } = req.userContext;
    return this.agentService.saveDeepReport(userId, body as Parameters<typeof this.agentService.saveDeepReport>[1]);
  }

  /**
   * Returns the user's strategy rules.
   *
   * @param req Authenticated request.
   */
  @Get('strategy-rules')
  async getStrategyRules(@Req() req: Request) {
    const { userId } = req.userContext;
    return this.agentService.getStrategyRules(userId);
  }

  /**
   * Returns the latest completed deep report for a ticker.
   *
   * @param req    Authenticated request.
   * @param ticker Target ticker.
   */
  @Get('deep-report/latest')
  async getLatestDeepReport(@Req() req: Request, @Query('ticker') ticker: string) {
    const { userId } = req.userContext;
    return this.agentService.getLatestDeepReport(userId, ticker);
  }

  /**
   * Lists the user's completed deep reports, newest first.
   *
   * @param req Authenticated request.
   */
  @Get('deep-reports')
  async listDeepReports(@Req() req: Request) {
    const { userId } = req.userContext;
    return this.agentService.listDeepReports(userId);
  }
}
