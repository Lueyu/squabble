/**
 * agent.controller.ts — LLM 分析智能体的 REST 控制器。
 *
 * 职责边界：
 *  - 暴露 /api/agent 路由：读取完整持仓状态/历史、保存每日分析与持仓评级、自选增删、
 *    保存交易日志与快照、读写深度研究报告与策略规则。全部委托给 AgentService。
 * 上下游：
 *  - 上游：LLM 分析智能体（Python 侧经工具调用访问）与前端页面。
 *  - 下游：AgentService。
 * 关键约定：
 *  - 类级 @NeedLogin()：全部路由按 request.userContext.userId 做属主隔离。
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

/** 保存某日分析笔记的载荷。 */
interface DailyAnalysisDto {
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

/** 批量应用持仓评级的载荷。 */
interface HoldingRatingsDto {
  items: Array<{
    ticker: string;
    rating?: string;
    action?: string;
    analysis?: string;
    targetPrice?: number;
  }>;
}

/** 新增/更新自选条目的载荷。 */
interface WatchItemsAddDto {
  items: Array<Omit<WatchItem, 'id' | 'dateAdded' | 'updatedAt'> & { dateAdded?: string }>;
}

/** 按代码移除自选条目的载荷。 */
interface WatchItemsRemoveDto {
  tickers: string[];
}

/**
 * 智能体 REST 控制器，全部工作委托给 AgentService。
 */
@NeedLogin()
@Controller('api/agent')
export class AgentController {
  constructor(private readonly agentService: AgentService) {}

  /**
   * GET /api/agent/state — 返回完整持仓状态（持仓、自选、分组、分析、交易、平仓、日志、快照、alpha picks、现金）（登录）。
   *
   * @param req 携带 req.userContext.userId 的已认证请求。
   */
  @Get('state')
  async getState(@Req() req: Request): Promise<AgentStateResponse> {
    const { userId } = req.userContext;
    return this.agentService.getState(userId);
  }

  /**
   * GET /api/agent/history — 返回近期历史（分析、交易、快照、持仓）， applicable 字段限最近约 180 天（登录）。
   *
   * @param req 已认证请求。
   */
  @Get('history')
  async getHistory(@Req() req: Request): Promise<{
    analysis: Analysis[];
    transactions: Transaction[];
    snapshots: Snapshot[];
    holdings: Holding[];
  }> {
    const { userId } = req.userContext;
    return this.agentService.getHistory(userId);
  }

  /**
   * POST /api/agent/daily-analysis — 保存某日的分析笔记（逐代码 upsert）（登录）。
   *
   * @param req  已认证请求。
   * @param dto  当日分析载荷。
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
   * POST /api/agent/holding-ratings — 把评级/操作/目标价应用到既有持仓（登录）。
   *
   * @param req 已认证请求。
   * @param dto 持仓评级载荷。
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
   * POST /api/agent/watch-items/add — 新增或更新自选条目（登录）。
   *
   * @param req 已认证请求。
   * @param dto 自选条目载荷。
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
   * POST /api/agent/watch-items/remove — 按代码移除自选条目（登录）。
   *
   * @param req 已认证请求。
   * @param dto 待移除代码列表。
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
   * POST /api/agent/journal — 创建或更新某日交易日志（登录）。
   *
   * @param req 已认证请求。
   * @param dto 日志载荷。
   */
  @Post('journal')
  async saveJournal(@Req() req: Request, @Body() dto: CreateJournalDto): Promise<JournalEntry> {
    const { userId } = req.userContext;
    return this.agentService.saveJournal(userId, dto);
  }

  /**
   * GET /api/agent/journal — 返回全部交易日志，最新在前（登录）。
   *
   * @param req 已认证请求。
   */
  @Get('journal')
  async getJournal(@Req() req: Request): Promise<JournalEntry[]> {
    const { userId } = req.userContext;
    return this.agentService.getJournal(userId);
  }

  /**
   * POST /api/agent/snapshot — 创建或更新某日快照（委托 SnapshotsService）（登录）。
   *
   * @param req 已认证请求。
   * @param dto 快照载荷。
   */
  @Post('snapshot')
  async saveSnapshot(@Req() req: Request, @Body() dto: CreateSnapshotDto): Promise<Snapshot> {
    const { userId } = req.userContext;
    return this.agentService.saveSnapshot(userId, dto);
  }

  /**
   * GET /api/agent/snapshots — 返回最多 365 条快照，最新在前（登录）。
   *
   * @param req 已认证请求。
   */
  @Get('snapshots')
  async getSnapshots(@Req() req: Request): Promise<Snapshot[]> {
    const { userId } = req.userContext;
    return this.agentService.getSnapshots(userId);
  }

  /**
   * POST /api/agent/deep-report — 保存深度研究报告（新建 agent run 保留历史）（登录）。
   *
   * @param req  已认证请求。
   * @param body 深度报告字段。
   */
  @Post('deep-report')
  async saveDeepReport(
    @Req() req: Request,
    @Body() body: Record<string, unknown>,
  ): Promise<{ ok: boolean; runId: string; deepReportId: string; reportDate: string }> {
    const { userId } = req.userContext;
    return this.agentService.saveDeepReport(
      userId,
      body as Parameters<typeof this.agentService.saveDeepReport>[1],
    );
  }

  /**
   * GET /api/agent/strategy-rules — 返回用户的策略规则（登录）。
   *
   * @param req 已认证请求。
   */
  @Get('strategy-rules')
  async getStrategyRules(@Req() req: Request) {
    const { userId } = req.userContext;
    return this.agentService.getStrategyRules(userId);
  }

  /**
   * GET /api/agent/deep-report/latest?ticker= — 返回某代码最近一次完成的深度报告（登录）。
   *
   * @param req    已认证请求。
   * @param ticker 目标代码。
   */
  @Get('deep-report/latest')
  async getLatestDeepReport(@Req() req: Request, @Query('ticker') ticker: string) {
    const { userId } = req.userContext;
    return this.agentService.getLatestDeepReport(userId, ticker);
  }

  /**
   * GET /api/agent/deep-reports — 列出用户已完成的深度报告，最新在前（登录）。
   *
   * @param req 已认证请求。
   */
  @Get('deep-reports')
  async listDeepReports(@Req() req: Request) {
    const { userId } = req.userContext;
    return this.agentService.listDeepReports(userId);
  }
}
