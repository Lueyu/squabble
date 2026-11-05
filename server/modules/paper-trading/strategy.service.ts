import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, gte } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '../../common/platform';
import { holdings, paperAccounts, paperOrders, paperPositions, watchlist } from '../../database/schema';
import { strategyPlans, strategyProtections } from '../../database/strategy.schema';
import { AgentBuilderService } from './agent-builder.service';
import { PaperTradingService } from './paper-trading.service';
import { CouncilService } from '../council/council.service';
import { FxService } from '../fx/fx.service';
import { TradingMarketService } from './trading-market.service';
import { StrategyModelService } from './strategy-model.service';
import { StrategyStore, mapStrategyPlan, type StrategyTaskRow } from './strategy.store';
import { normalizeAutomation, strategyTriggerMatches, validateStrategyRules } from './strategy.rules';
import { resolveTradingTicker, type TradingMarketSchedule, type TradingMarketSnapshot } from '../../../shared/trading-market.interface';
import type { BuilderProfile, Market } from '../../../shared/api.interface';
import type { StrategyCandidate, StrategyMarketRuntime, StrategyRuntime, StrategyRule } from '../../../shared/strategy.interface';
import type { CouncilReport } from '../../../shared/council.interface';
import { strategyPlanPrompt } from './strategy-prompt';
import { marketDate } from './trading-cadence';
import { ResearchMonitorService } from '../research-memory/research-memory.monitor.service';
import { sameMonitorSymbol } from '../research-memory/research-memory.monitor.rules';

@Injectable()
export class StrategyService {
  private readonly logger = new Logger(StrategyService.name);
  private readonly running = new Set<string>();
  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly builder: AgentBuilderService, private readonly paper: PaperTradingService,
    private readonly council: CouncilService, private readonly market: TradingMarketService,
    private readonly model: StrategyModelService, private readonly store: StrategyStore,
    private readonly fx: FxService) {}

  async status(owner: string, id: string): Promise<StrategyRuntime> {
    return this.store.runtime(owner, await this.builder.getProfile(owner, id));
  }
  async stillActive(owner: string, profile: BuilderProfile): Promise<boolean> {
    const [account, active] = await Promise.all([
      this.db.select().from(paperAccounts).where(eq(paperAccounts.owner, owner)),
      this.builder.getActiveProfile(owner),
    ]);
    return Boolean(account[0]?.botEnabled && active?.id === profile.id && active.version === profile.version
      && active.config.automation?.enabled);
  }
  async tick(owner: string): Promise<StrategyRuntime | null> {
    const profile = await this.builder.getActiveProfile(owner);
    if (!profile?.config.automation?.enabled) return null;
    if (this.running.has(owner)) return this.store.runtime(owner, profile);
    if (!await this.stillActive(owner, profile)) throw new BadRequestException('Automation is stopped');
    this.running.add(owner);
    try {
      await this.monitorProtections(owner, profile);
      const universe = await this.universe(owner, profile);
      const markets = [...new Set(universe.map((ticker) => resolveTradingTicker(ticker)?.market).filter((value): value is Market => Boolean(value)))];
      for (const market of markets) {
        const tickers = universe.filter((ticker) => resolveTradingTicker(ticker)?.market === market);
        try { await this.tickMarket(owner, profile, market, tickers); }
        catch {
          this.logger.warn(`Strategy check failed for profile ${profile.id}, market ${market}`);
          if (profile.config.notifyOnProposal) await this.store.enqueue(owner, profile.id, `strategy-error:${profile.id}:${profile.version}:${market}:${new Date().toISOString().slice(0, 10)}`,
            { event: 'strategy_error', title: profile.config.language === 'en' ? 'Automatic PAPER strategy waiting' : '自动模拟策略已等待',
              body: profile.config.language === 'en' ? `${market}: data, model or risk checks did not finish. Check strategy status.`
                : `${market}: 数据、模型或风控检查未完成。请查看策略状态。` });
          await this.store.setRuntime(owner, profile, { market, marketDate: null, state: 'blocked', nextDiscussionAt: null,
            lastCheckAt: new Date().toISOString(), lastQuoteAt: null, reason: 'Strategy check failed; no new order was executed', currentPlan: null });
        }
      }
      return this.store.runtime(owner, profile);
    } finally { this.running.delete(owner); }
  }
  private async universe(owner: string, profile: BuilderProfile): Promise<string[]> {
    if (profile.config.tickers.length) return profile.config.tickers;
    const [owned, watched, positions] = await Promise.all([
      this.db.select({ ticker: holdings.ticker }).from(holdings).where(eq(holdings.owner, owner)),
      this.db.select({ ticker: watchlist.ticker }).from(watchlist).where(eq(watchlist.owner, owner)),
      this.db.select({ ticker: paperPositions.ticker }).from(paperPositions).where(eq(paperPositions.owner, owner)),
    ]);
    return [...new Set([...owned, ...watched, ...positions].map((item) => item.ticker.toUpperCase()))];
  }
  private async tickMarket(owner: string, profile: BuilderProfile, market: Market, tickers: string[]): Promise<void> {
    const now = new Date();
    const config = normalizeAutomation(profile.config.automation);
    const current = await this.market.getSchedule(market, now);
    let schedule = current;
    if (!current.isOpen && current.nextOpenAt && (!current.opensAt || now.getTime() >= Date.parse(current.closesAt ?? ''))) {
      schedule = await this.market.getSchedule(market, new Date(current.nextOpenAt));
    }
    const discussionAt = schedule.opensAt ? new Date(Date.parse(schedule.opensAt) - config.preOpenMinutes * 60000).toISOString() : null;
    let plan = await this.store.currentPlan(owner, profile, market, schedule.tradingDate);
    const runtime: StrategyMarketRuntime = { market, marketDate: schedule.tradingDate, state: 'waiting',
      nextDiscussionAt: discussionAt, lastCheckAt: now.toISOString(), lastQuoteAt: null,
      reason: 'Waiting for scheduled pre-open discussion', currentPlan: plan ? mapStrategyPlan(plan) : null };
    const finish = async (): Promise<void> => { runtime.currentPlan = plan ? mapStrategyPlan(plan) : null;
      await this.store.setRuntime(owner, profile, runtime); };
    if (!schedule.calendarVerified || !schedule.isTradingDay || !schedule.closesAt || !discussionAt) {
      runtime.state = 'blocked'; runtime.reason = schedule.reason ?? 'Trading calendar unavailable'; return finish();
    }
    if (tickers.length > 20) { runtime.state = 'blocked'; runtime.reason = 'Select at most 20 tickers per market for bounded daily discussion'; return finish(); }
    if (current.closesAt && now.getTime() >= Date.parse(current.closesAt) && config.notifyClosingSummary && profile.config.notifyOnProposal) {
      const overview = await this.paper.getOverview(owner);
      const english = profile.config.language === 'en';
      const summary = english
        ? `Equity: $${overview.equity}\nToday's P/L: $${overview.todayPl ?? 'unavailable'}\nOrders today: ${overview.todayOrderCount}\nOpen positions: ${overview.positions.length}\nDaily strategy expires at the market close.`
        : `模拟权益：$${overview.equity}\n今日盈亏：$${overview.todayPl ?? '暂无'}\n今日订单：${overview.todayOrderCount} 笔\n持仓：${overview.positions.length} 只\n当日策略于收盘失效。`;
      await this.store.enqueue(owner, profile.id, `strategy-close:${profile.id}:${profile.version}:${market}:${current.tradingDate}`,
        { event: 'strategy_daily_summary', title: `${market} ${english ? 'PAPER closing summary' : '模拟盘收盘总结'}`, body: summary });
    }
    if (now.getTime() < Date.parse(discussionAt)) return finish();
    const tasks = await this.store.tasks(owner, profile, market, schedule.tradingDate);
    const task = tasks[0];
    if (!task) {
      const claimed = await this.store.claimTask(owner, profile, market, schedule.tradingDate, 0);
      if (claimed) await this.startDiscussion(owner, profile, claimed, tickers);
      runtime.state = 'discussing'; runtime.reason = 'Daily deep research discussion started'; return finish();
    }
    if (task.state === 'discussing') {
      await this.advanceDiscussion(owner, profile, task, tickers, schedule);
      plan = await this.store.currentPlan(owner, profile, market, schedule.tradingDate);
    }
    if ((task.state === 'claimed' || task.state === 'extracting') && now.getTime() - task.updatedAt.getTime() > 15 * 60000) {
      await this.store.updateTask(task.id, 'failed', 'Interrupted or uncertain paid work; pause and save a new profile version to explicitly retry');
    }
    if (!plan) {
      runtime.state = task.state === 'discussing' ? 'discussing' : 'blocked';
      runtime.reason = task.reason ?? (task.state === 'completed' ? 'No valid strategy remains' : 'Discussion pending or interrupted; paid work is never replayed automatically');
      return finish();
    }
    runtime.state = 'ready'; runtime.reason = 'Validated daily strategy ready';
    if (!current.isOpen || current.tradingDate !== plan.marketDate) return finish();
    const previous = (await this.store.runtime(owner, profile)).markets.find((item) => item.market === market);
    if (previous?.lastCheckAt && now.getTime() - Date.parse(previous.lastCheckAt) < config.monitorSeconds * 1000) return;
    runtime.state = 'monitoring';
    let outsideBand = false;
    const memoryTriggers: Array<{ ticker: string; reason: string }> = [];
    for (const ticker of [...new Set(plan.rules.map((rule) => rule.ticker))].filter((symbol) => tickers.includes(symbol))) {
      const snapshot = await this.market.getSnapshot(ticker, now);
      runtime.lastQuoteAt = snapshot.quoteTimestamp;
      const inventory = plan.memoryInventory ?? { state: 'unknown' as const, dependencies: [], reason: 'MEMORY_LEGACY_PLAN_REVIEW_REQUIRED' };
      const breached = await new ResearchMonitorService(this.db).observe(owner, inventory, snapshot, profile.id);
      const memoryBlock = await this.store.memoryBlock(owner, inventory, ticker);
      outsideBand ||= breached || Boolean(memoryBlock);
      if (breached || memoryBlock) memoryTriggers.push({ ticker, reason: memoryBlock ?? 'MEMORY_CONDITION_BREACHED' });
      if (memoryBlock) { runtime.state = 'blocked'; runtime.reason = memoryBlock; continue; }
      if (!snapshot.usable || !snapshot.price || !snapshot.indicators || !snapshot.quoteTimestamp) {
        runtime.state = 'blocked'; runtime.reason = snapshot.reason ?? 'Market data unavailable';
        if (profile.config.notifyOnProposal) await this.store.enqueue(owner, profile.id,
          `strategy-data:${plan.id}:${ticker}`, { event: 'strategy_error',
            title: profile.config.language === 'en' ? 'Automatic PAPER strategy waiting for data' : '自动模拟策略等待行情',
            body: profile.config.language === 'en' ? `${ticker}: quote or indicator validation failed. Waiting for valid data.`
              : `${ticker}: 行情或指标数据未通过校验，等待有效数据。` });
        continue;
      }
      for (const rule of plan.rules.filter((item) => item.ticker === ticker)) {
        if (now.getTime() >= Date.parse(rule.expiresAt)) continue;
        outsideBand ||= snapshot.price < rule.minPrice || snapshot.price > rule.maxPrice;
        const held = await this.db.select().from(paperPositions).where(and(eq(paperPositions.owner, owner), eq(paperPositions.ticker, ticker)));
        const shares = Math.floor(Number(held[0]?.shares ?? 0));
        if (!strategyTriggerMatches(rule, snapshot.price, snapshot.indicators)) continue;
        if (rule.side === 'buy' && profile.config.template === 'guard') continue;
        const quantity = rule.side === 'sell' ? await this.sellableQuantity(owner, ticker, market, shares)
          : await this.buyQuantity(owner, profile, rule.maxPositionPct, snapshot, shares);
        if (quantity <= 0) { runtime.reason = 'No available cash, position allowance or sellable quantity'; continue; }
        const reviewAttempt = await this.store.nextReviewAttempt(owner, plan.id, rule.id, snapshot.quoteTimestamp);
        if (reviewAttempt === null) continue;
        const candidate: StrategyCandidate = { signalId: randomUUID(), planId: plan.id, planVersion: plan.version,
          ruleId: rule.id, ticker, market, side: rule.side, quantity, price: snapshot.price,
          quoteAt: snapshot.quoteTimestamp, protectiveStop: false, reason: rule.rationale, reviewAttempt };
        if (!await this.store.claimSignal(owner, profile, candidate)) continue;
        runtime.reason = await this.reviewAndExecute(owner, profile, candidate, snapshot, rule);
      }
    }
    if (outsideBand && task.state === 'completed' && task.attempt < config.maxEventReplansPerDay
      && now.getTime() - task.createdAt.getTime() >= config.eventReplanCooldownMinutes * 60000) {
      const replan = await this.store.claimTask(owner, profile, market, schedule.tradingDate, task.attempt + 1);
      if (replan) { await this.startDiscussion(owner, profile, replan, tickers, memoryTriggers.length ? JSON.stringify({ triggers: memoryTriggers.slice(0, 3),
        dependencies: plan.memoryInventory?.dependencies.filter(ref => memoryTriggers.some(trigger => sameMonitorSymbol(trigger.ticker, ref.ticker))).slice(0, 3)
          .map(ref => ({ thesisId: ref.thesisId, version: ref.version, ticker: ref.ticker })) }) : undefined);
        runtime.reason = 'Price left strategy bounds; bounded event replan started'; }
    }
    return finish();
  }
  private async startDiscussion(owner: string, profile: BuilderProfile, task: StrategyTaskRow, tickers: string[], memoryTrigger?: string): Promise<void> {
    const ids: string[] = [];
    try {
      for (const ticker of tickers) {
        if (!await this.stillActive(owner, profile)) throw new Error('Profile stopped');
        const session = await this.council.createSession(owner, { profileId: profile.id, ticker,
          goal: 'comprehensive',
          language: profile.config.language, members: profile.config.council?.members, webResearch: profile.config.council?.webResearch });
        ids.push(session.id);
        await this.store.updateTask(task.id, 'claimed', null, ids);
        await this.council.addMessage(owner, session.id,
          `Prepare deep daily research for ${task.marketDate} ${task.market}. Discuss evidence, disagreement, catalysts, measured indicators, entry/exit conditions, price invalidation and protective stops for ${ticker}. This is PAPER-only planning, not an order approval. Investor rules: ${profile.config.customPrompt.slice(0, 800)}. A deterministic validated strategy will later be derived from the final report; unsupported facts must be identified.${memoryTrigger ? ` Triggered thesis review: ${memoryTrigger}. A prior breach stays latched. Only an explicitly reviewed replacement of an actually supplied thesis/version can resolve it.` : ''}`);
      }
      await this.store.updateTask(task.id, 'discussing', null, ids);
      if (ids[0]) {
        await this.store.updateTask(task.id, 'discussing', `dispatching:${ids[0]}`, ids);
        await this.council.runSession(owner, ids[0]);
      }
    } catch {
      await this.store.updateTask(task.id, 'failed', 'Daily discussion could not start; no automatic replay', ids);
      for (const id of ids) await this.council.pauseSession(owner, id).catch(() => undefined);
    }
  }
  private async advanceDiscussion(owner: string, profile: BuilderProfile, task: StrategyTaskRow,
    tickers: string[], schedule: TradingMarketSchedule): Promise<void> {
    const sessions = await Promise.all(task.sessionIds.map((id) => this.council.getSession(owner, id)));
    if (!sessions.length || sessions.some((session) => session.status === 'failed' || session.status === 'paused')) {
      await this.store.updateTask(task.id, 'failed', 'Daily discussion failed or was paused; previous valid plan retained'); return;
    }
    if (sessions.some((session) => session.status === 'running')) return;
    const idle = sessions.find((session) => session.status === 'idle');
    if (idle) {
      if (task.reason === `dispatching:${idle.id}`) {
        await this.store.updateTask(task.id, 'failed', 'Interrupted discussion dispatch; no automatic replay'); return;
      }
      await this.store.updateTask(task.id, 'discussing', `dispatching:${idle.id}`);
      await this.council.runSession(owner, idle.id);
      return;
    }
    try {
      const selectedSessions = sessions.filter((session) => tickers.includes(session.ticker));
      const reports = selectedSessions.map((session) => session.reports.filter((report) => report.revision === session.revision).at(-1))
        .filter((report): report is CouncilReport => Boolean(report));
      if (!selectedSessions.length || reports.length !== selectedSessions.length || reports.some((report) => !report.evidence.length)) throw new Error('Incomplete research evidence');
      if (selectedSessions.some((session, index) => session.workflow && (!reports[index].coverage?.complete
        || reports[index].coverage?.revision !== session.revision || reports[index].coverage?.tasks.some(t => t.state !== 'accepted' || !t.acceptedAttemptId)))) {
        throw new Error('Research tasks have not all passed review; no new strategy can be generated');
      }
      const inventory = await this.store.inspectMemory(owner, reports.map(report => report.id));
      const memoryBlock = await this.store.memoryBlock(owner, inventory);
      if (memoryBlock) {
        await this.store.updateTask(task.id, 'discussing', memoryBlock);
        return;
      }
      if (!await this.store.claimExtraction(task.id)) return;
      const snapshots = await Promise.all(selectedSessions.map(async (session) => ({ ...await this.market.getSnapshot(session.ticker), ticker: session.ticker })));
      const packed = strategyPlanPrompt(profile, reports, snapshots, schedule.closesAt!);
      const output = await this.model.json(owner, profile.config.council?.members.find((member) => member.role === 'manager'), task.id,
        'daily-strategy-plan', packed.prompt,
        () => this.stillActive(owner, profile), false);
      if (!output || typeof output !== 'object' || Array.isArray(output)) throw new Error('Invalid strategy output');
      const data = output as Record<string, unknown>;
      const rules = validateStrategyRules(data.rules, { tickers: packed.tickers, evidenceIds: packed.evidenceIds,
        evidenceIdsByTicker: Object.fromEntries(selectedSessions.map((session, index) => [session.ticker,
          reports[index].evidence.map((item) => item.id)])),
        expiresAt: new Date(schedule.closesAt!), now: new Date(), maxPositionPct: profile.config.maxOrderPct });
      if (profile.config.template === 'guard' && rules.some((rule) => rule.side === 'buy')) throw new Error('Guard cannot open positions');
      if (typeof data.summary !== 'string' || !data.summary.trim()) throw new Error('Strategy summary missing');
      await this.store.publish(task, rules, reports.map((report) => report.id), data.summary, new Date(schedule.closesAt!),
        selectedSessions.flatMap((session, index) => session.workflow ? [{ sessionId: session.id, reportId: reports[index].id,
          revision: session.revision, cycleId: reports[index].coverage!.cycleId }] : []));
    } catch {
      await this.store.updateTask(task.id, 'failed', 'Strategy generation failed validation; previous valid plan retained');
      if (profile.config.notifyOnProposal) await this.store.enqueue(owner, profile.id, `strategy-task-failed:${task.id}`, { event: 'strategy_error',
        title: profile.config.language === 'en' ? 'Daily strategy generation incomplete' : '每日策略生成未完成',
        body: profile.config.language === 'en' ? 'Model or evidence validation failed. No new plan published; a previous valid plan is retained. See discussion history.'
          : '模型或证据校验未通过，未发布新策略；仍有效的旧策略保留。请查看讨论记录。' });
    }
  }
  private async buyQuantity(owner: string, profile: BuilderProfile, maxPositionPct: number,
    snapshot: TradingMarketSnapshot, heldShares: number): Promise<number> {
    if (!snapshot.currency || !snapshot.price) return 0;
    const overview = await this.paper.getOverview(owner);
    const fx = await this.fx.convert(1, snapshot.currency, 'USD');
    if (!Number.isFinite(fx) || fx <= 0) return 0;
    const equity = Number(overview.equity);
    const unit = snapshot.price * fx;
    const available = Math.min(Number(overview.account.cashBalance), equity * profile.config.maxOrderPct / 100,
      equity * maxPositionPct / 100 - heldShares * unit);
    return Math.max(0, Math.floor(available / unit));
  }
  private async sellableQuantity(owner: string, ticker: string, market: Market, held: number): Promise<number> {
    if (market !== 'CN') return held;
    const orders = await this.db.select().from(paperOrders).where(and(eq(paperOrders.owner, owner),
      eq(paperOrders.ticker, ticker), eq(paperOrders.side, 'buy'), eq(paperOrders.status, 'filled'),
      gte(paperOrders.createdAt, new Date(Date.now() - 48 * 3600000))));
    const today = marketDate('CN');
    const bought = orders.filter((order) => marketDate('CN', order.createdAt) === today)
      .reduce((sum, order) => sum + Number(order.quantity), 0);
    return Math.max(0, held - bought);
  }
  private async monitorProtections(owner: string, profile: BuilderProfile): Promise<void> {
    const previous = await this.store.runtime(owner, profile);
    for (const protection of await this.store.protections(owner)) {
      const market = protection.market as Market;
      const checkedAt = previous.markets.find((item) => item.market === market)?.lastCheckAt;
      if (checkedAt && Date.now() - Date.parse(checkedAt) < normalizeAutomation(profile.config.automation).monitorSeconds * 1000) continue;
      if (!(await this.market.getSchedule(market)).isOpen) continue;
      const [position] = await this.db.select().from(paperPositions).where(and(eq(paperPositions.owner, owner),
        eq(paperPositions.accountId, protection.accountId), eq(paperPositions.ticker, protection.ticker)));
      if (!position || Number(position.shares) <= 0) {
        await this.db.delete(strategyProtections).where(eq(strategyProtections.id, protection.id)); continue;
      }
      const snapshot = await this.market.getSnapshot(protection.ticker);
      if (!snapshot.quoteUsable || !snapshot.price || !snapshot.quoteTimestamp || snapshot.price > Number(protection.stopLossPrice)) continue;
      const quantity = await this.sellableQuantity(owner, protection.ticker, market, Math.floor(Number(position.shares)));
      if (quantity <= 0) continue;
      const [plan] = await this.db.select().from(strategyPlans).where(and(eq(strategyPlans.owner, owner), eq(strategyPlans.id, protection.planId)));
      const rule = plan?.rules.find((item) => item.id === protection.ruleId);
      if (!plan || !rule) continue;
      const candidate: StrategyCandidate = { signalId: randomUUID(), planId: plan.id, planVersion: plan.version,
        ruleId: protection.ruleId, ticker: protection.ticker, market, side: 'sell', quantity, price: snapshot.price,
        quoteAt: snapshot.quoteTimestamp, protectiveStop: true, protectionId: protection.id,
        protectionVersion: protection.version, reason: 'Protective stop loss' };
      if (await this.store.claimSignal(owner, profile, candidate)) await this.reviewAndExecute(owner, profile, candidate, snapshot, rule);
    }
  }
  private async reviewAndExecute(owner: string, profile: BuilderProfile, candidate: StrategyCandidate,
    snapshot: TradingMarketSnapshot, rule: StrategyRule): Promise<string> {
    try {
      if (!candidate.protectiveStop) {
        const overview = await this.paper.getOverview(owner);
        const output = await this.model.json(owner, profile.config.automation?.fastReviewer, candidate.signalId, 'strategy-fast-review',
          `Review this immutable PAPER candidate. Return only {"decision":"approve|wait|veto","reason":"short explanation"}. You cannot modify ticker, direction, quantity, price or plan. If evidence is insufficient, wait or veto. Language ${profile.config.language ?? 'zh-CN'}. Candidate: ${JSON.stringify(candidate)}. Validated rule: ${JSON.stringify(rule)}. Measured indicators: ${JSON.stringify(snapshot.indicators)}. Account: ${JSON.stringify({ equity: overview.equity, cash: overview.account.cashBalance, todayPl: overview.todayPl, todayOrderCount: overview.todayOrderCount, circuitBreaker: overview.circuitBreakerActive, holding: overview.positions.find((position) => position.ticker === candidate.ticker) ?? null })}. Instructions: ${profile.config.customPrompt.slice(0, 300)}`,
          () => this.stillActive(owner, profile), true);
        const data = output && typeof output === 'object' && !Array.isArray(output) ? output as Record<string, unknown> : null;
        const decision = data?.decision;
        const reason = typeof data?.reason === 'string' ? data.reason.slice(0, 500) : 'Invalid fast review response';
        if (decision !== 'approve') { await this.store.finishSignal(candidate.signalId, decision === 'wait' ? 'wait' : 'veto', reason); return reason; }
        await this.store.finishSignal(candidate.signalId, 'approved', reason);
      }
      const order = await this.paper.placeOrder(owner, { ticker: candidate.ticker, side: candidate.side,
        quantity: candidate.quantity, orderType: 'market', reason: candidate.reason }, 'agent', undefined, true, true,
      profile, undefined, candidate.signalId);
      return order.status === 'filled' ? `PAPER filled: ${candidate.ticker} ${candidate.side} ${candidate.quantity}` : order.reason ?? 'Hard risk blocked order';
    } catch {
      await this.store.finishSignal(candidate.signalId, 'blocked', 'Execution stopped: profile, price, data or risk validation failed');
      return 'Execution stopped: profile, price, data or risk validation failed';
    }
  }
}
