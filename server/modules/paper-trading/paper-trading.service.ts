/**
 * @file server/modules/paper-trading/paper-trading.service.ts
 * @description AI paper-trading engine.
 *
 * The paper book is fully isolated from real records: dedicated tables,
 * dedicated cash ledger, no code path touches holdings/transactions. The
 * broker adapter is paper-only by construction — there is no real-broker
 * implementation to misconfigure.
 *
 * All fills require validated recent source quotes, the trading calendar,
 * available FX and a solvent currency ledger; free quotes may be delayed.
 * No real-broker order is sent.
 *
 * Guardrails (bot orders only; manual orders still require sufficient
 * cash/shares but skip the bot caps, so a human always stays in control):
 *  - daily loss circuit breaker: stop trading for the day once equity has
 *    dropped `dailyLossLimitPct`% from the day-start equity
 *  - per-order cap: a single order may not exceed `maxOrderPct`% of equity
 *  - per-day cap: at most `maxOrdersPerDay` bot orders per day
 */
import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { and, desc, eq, gt, gte, or, sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '../../common/platform';
import {
  holdings,
  agentRatings,
  agentRuns,
  agentSessions,
  builderProfiles,
  builderProposals,
  paperAccounts,
  paperEvents,
  paperOrders,
  paperPositions,
  paperSnapshots,
  paperTrades,
  watchlist,
} from '../../database/schema';
import { paperRiskDay, paperRiskTimezone } from './paper-risk-day';
import { executionEconomics } from './simulation-experiments.rules';
import { settleStrategyReservation } from './strategy-reservation';
import { strategyMandates, strategyReservations } from '../../database/strategy-mandates.schema';
import { simulationLotRejection } from './simulation-order.rules';
import { requireActivePaperAccount } from './simulation-account';
import { assertMandateExecution } from './strategy-mandate.fence';
import { evaluatePortfolioRisk, preparePortfolioRiskInputs, readPortfolioRiskSnapshot } from './strategy-portfolio-risk';
import { simulationCash, simulationSeeds } from '../../database/simulation-experiments.schema';
import { recordSimulationCashFill, settleSimulationCash } from './simulation-ledger';
import { persistCorporateActionGaps, readCorporateActionGaps } from './simulation-corporate-actions';
import { FxService } from '../fx/fx.service';
import { QuoteService } from '../quote/quote.service';
import { NotificationService, type NotificationPayload } from '../notifications/notification.service';
import { isMarketOpen } from '../../common/market-clock';
import { AgentBuilderService } from './agent-builder.service';
import { decideBuilderSignal } from './agent-builder.rules';
import { BuilderCadenceService } from './builder-cadence.service';
import { cadenceRejection, normalizeCadence, marketDate } from './trading-cadence';
import { CouncilService } from '../council/council.service';
import { councilReports, councilSessions } from '../../database/council.schema';
import type { CouncilCandidate } from '@shared/council.interface';
import { strategyOutbox, strategyPlans, strategyProtections, strategySignals } from '../../database/strategy.schema';
import { TradingMarketService } from './trading-market.service';
import { strategyTriggerMatches } from './strategy.rules';
import { lockMemoryOwner } from '../research-memory/research-memory.fence';
import { strategyMemoryBlock } from '../research-memory/research-memory.dependencies';
import { observeThesisMonitors } from '../research-memory/research-memory.monitor.service';
import type { StrategyRule } from '../../../shared/strategy.interface';
import type {
  BuilderProfile,
  Market,
  CreatePaperOrderDto,
  PaperAccount,
  PaperGuardrails,
  PaperOrder,
  PaperOrderSource,
  PaperOverview,
  PaperSide,
} from '@shared/api.interface';

/** Static FX fallback (units per USD) when the FX service is unavailable. */

/** Default guardrails for new accounts. */
const DEFAULT_GUARDRAILS: PaperGuardrails = {
  dailyLossLimitPct: 3,
  maxOrderPct: 5,
  maxOrdersPerDay: 10,
};

/** A resolved price for a ticker (USD notional included). */
interface ResolvedPrice {
  price: number;
  market: 'US' | 'HK' | 'CN';
  currency: 'USD' | 'HKD' | 'CNY';
  company: string | null;
  /** Conversion rate from the quote currency to USD. */
  fxToUsd: number;
}

/** Risk-gate evaluation snapshot stored on every order. */
interface RiskCheck {
  passed: boolean;
  side: PaperSide;
  notionalUsd: number;
  equityUsd: number;
  orderPct: number;
  todayOrderCount: number;
  circuitBreaker: boolean;
  reason?: string;
  feeUsd?: number;
  cashAmountUsd?: number;
  executionModel?: { version: string; feeBps: number; slippageBps: number };
}

@Injectable()
export class PaperTradingService {
  private readonly logger = new Logger('PaperTrading');
  private readonly activeBuilderScans = new Set<string>();

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly quoteService: QuoteService,
    private readonly fxService: FxService,
    private readonly notifications: NotificationService,
    private readonly builder: AgentBuilderService,
    private readonly cadence: BuilderCadenceService,
    private readonly council: CouncilService,
    @Optional() private readonly tradingMarket?: TradingMarketService,
  ) {}

  /** Get (or lazily create) the caller's paper account. */
  async ensureAccount(userId: string): Promise<PaperAccount> {
    return this.db.transaction(async (tx) => {
      await lockMemoryOwner(tx, userId);
      const [current] = await tx.select().from(paperAccounts).where(and(eq(paperAccounts.owner, userId), eq(paperAccounts.isActive, true)));
      if (current) return this.mapAccount(current);
      const [created] = await tx.insert(paperAccounts).values({ owner: userId, guardrails: DEFAULT_GUARDRAILS }).returning();
      return this.mapAccount(created);
    });
  }

  /** Legacy reset endpoint now creates an independent cash experiment; history is retained. */
  async resetAccount(userId: string, initialCash?: number): Promise<PaperAccount> {
    if (initialCash !== undefined && (!Number.isFinite(initialCash) || initialCash <= 0)) {
      throw new BadRequestException('Initial cash must be positive');
    }
    const created = await this.db.transaction(async (tx) => {
      await lockMemoryOwner(tx, userId);
      await tx.update(paperAccounts).set({ isActive: false, botEnabled: false, updatedAt: new Date() }).where(eq(paperAccounts.owner, userId));
      await tx.update(builderProfiles).set({ status: 'paused', version: sql`${builderProfiles.version} + 1`, updatedAt: new Date() })
        .where(and(eq(builderProfiles.owner, userId), eq(builderProfiles.status, 'active')));
      await tx.update(strategySignals).set({ state: 'blocked', reason: 'New paper account selected', updatedAt: new Date() })
        .where(and(eq(strategySignals.owner, userId), sql`${strategySignals.state} IN ('pending', 'reviewing', 'approved', 'claimed')`));
      await tx.update(strategyReservations).set({ status: 'released', reason: 'New paper account selected', updatedAt: new Date() })
        .where(and(eq(strategyReservations.owner, userId), eq(strategyReservations.status, 'active')));
      await tx.update(paperOrders).set({ status: 'cancelled', reason: 'New paper account selected' })
        .where(and(eq(paperOrders.owner, userId), eq(paperOrders.status, 'pending_approval')));
      const [account] = await tx.insert(paperAccounts).values({ owner: userId, name: 'Cash experiment', ledgerMode: 'native_currency',
        initialCash: String(initialCash ?? 1_000_000), cashBalance: String(initialCash ?? 1_000_000), isActive: true }).returning();
      await tx.insert(simulationCash).values({ owner: userId, accountId: account.id, currency: 'USD',
        available: account.cashBalance, availabilityKnown: true });
      await tx.insert(paperEvents).values({ owner: userId, accountId: account.id, eventType: 'opening_balance',
        detail: { initialCash: account.initialCash, previousHistoryRetained: true, modelVersion: 'paper-v1' } });
      return account;
    });
    return this.mapAccount(created);
  }

  /** Full overview for the paper page: account, positions, curve, feeds. */
  /**
   * Mirror the caller's real portfolio into the paper account.
   * Copies every real holding (ticker, shares, cost) into paper positions,
   * sets cash to zero (all capital is "deployed"), and clears prior paper data.
   */
  async mirrorRealPortfolio(userId: string): Promise<PaperAccount> {
    const account = await this.requireAccount(userId);
    const realHoldings = await this.db
      .select()
      .from(holdings)
      .where(eq(holdings.owner, userId));

    if (realHoldings.length === 0) {
      throw new BadRequestException('No real holdings to mirror');
    }

    // Clear existing paper positions, orders, trades and events.
    await this.db.delete(paperTrades).where(eq(paperTrades.accountId, account.id));
    await this.db.delete(paperOrders).where(eq(paperOrders.accountId, account.id));
    await this.db.delete(paperEvents).where(eq(paperEvents.accountId, account.id));
    await this.db.delete(paperSnapshots).where(eq(paperSnapshots.accountId, account.id));
    await this.db.delete(paperPositions).where(eq(paperPositions.accountId, account.id));

    // Copy real holdings into paper positions.
    for (const h of realHoldings) {
      const info = this.quoteService.detectMarket(h.ticker);
      await this.db.insert(paperPositions).values({
        owner: userId,
        accountId: account.id,
        ticker: h.ticker,
        market: (h.market as 'US' | 'HK' | 'CN') ?? info.market,
        currency: (h.currency as 'USD' | 'HKD' | 'CNY') ?? info.currency,
        company: h.company ?? null,
        shares: h.shares,
        avgCost: h.buyPrice ?? '0',
      });
    }

    // Cash is zero: the mirror assumes all capital is in the positions.
    const [updated] = await this.db
      .update(paperAccounts)
      .set({ cashBalance: '0', updatedAt: new Date() })
      .where(eq(paperAccounts.id, account.id))
      .returning();

    await this.recordEvent(userId, account.id, 'account_reset', {
      action: 'mirror-real-portfolio',
      positions: realHoldings.length,
    });

    return this.mapAccount(updated);
  }

  async getOverview(userId: string): Promise<PaperOverview> {
    const account = await this.requireAccount(userId);
    if (account.ledgerMode === 'native_currency') await this.db.transaction(async (tx) => {
      await lockMemoryOwner(tx, userId);
      await tx.select({ id: paperAccounts.id }).from(paperAccounts).where(eq(paperAccounts.id, account.id)).for('update');
      await settleSimulationCash(tx, account.id);
    });
    const valuationGaps: string[] = [];
    try { await this.ensureDailySnapshot(userId, account.id); }
    catch (error) { valuationGaps.push(error instanceof Error ? error.message : 'Valuation unavailable'); }
    const positions = await this.db
      .select()
      .from(paperPositions)
      .where(eq(paperPositions.accountId, account.id));

    // Missing current quotes or FX remain unknown in the USD valuation.
    const enriched = await Promise.all(
      positions.map(async (p) => {
        const price = await this.resolvePrice(userId, p.ticker);
        const shares = Number(p.shares);
        const avgCost = Number(p.avgCost);
        if (!price) {
          valuationGaps.push(`QUOTE_OR_FX_UNAVAILABLE:${p.ticker}`);
          return {
            ...this.mapPosition(p),
            lastPrice: null,
            marketValue: null,
            unrealizedPl: null,
            unrealizedPct: null,
          };
        }
        const costUsd = shares * avgCost * price.fxToUsd;
        const valueUsd = shares * price.price * price.fxToUsd;
        const pl = valueUsd - costUsd;
        return {
          ...this.mapPosition(p),
          lastPrice: price.price.toFixed(2),
          marketValue: valueUsd.toFixed(2),
          unrealizedPl: pl.toFixed(2),
          unrealizedPct: costUsd > 0 ? ((pl / costUsd) * 100).toFixed(2) : '0.00',
        };
      }),
    );

    const positionsValue = valuationGaps.length || enriched.some((p) => p.marketValue === null) ? null : enriched.reduce((sum, p) => sum + Number(p.marketValue), 0);
    let cash: number | null = null;
    try { cash = await this.cashValue(userId, account); } catch { valuationGaps.push('CASH_FX_UNAVAILABLE'); }
    const equity = positionsValue === null || cash === null ? null : cash + positionsValue;

    const todayOrders = await this.todayOrders(userId, account.id);
    const curveRows = await this.db
      .select()
      .from(paperSnapshots)
      .where(eq(paperSnapshots.accountId, account.id))
      .orderBy(desc(paperSnapshots.snapshotDate))
      .limit(60);
    const curve = curveRows
      .slice()
      .reverse()
      .map((s) => ({
        date: s.snapshotDate,
        equity: String(s.equity),
        cash: String(s.cash),
        positionsValue: String(s.positionsValue),
        dailyPl: String(s.dailyPl),
      }));

    const recentOrders = await this.db
      .select()
      .from(paperOrders)
      .where(eq(paperOrders.accountId, account.id))
      .orderBy(desc(paperOrders.createdAt))
      .limit(20);
    const recentEvents = await this.db
      .select()
      .from(paperEvents)
      .where(eq(paperEvents.accountId, account.id))
      .orderBy(desc(paperEvents.createdAt))
      .limit(30);

    let dayStart: number | null = null;
    try { dayStart = await this.dayStartEquity(userId, account.id, account.initialCash); } catch { /* Missing valuation is exposed above. */ }
    const todayPl = equity === null || dayStart === null ? null : equity - dayStart;
    const totalPl = equity === null ? null : equity - Number(account.initialCash);

    const mappedAccount = this.mapAccount(
      (await this.db.select().from(paperAccounts).where(eq(paperAccounts.id, account.id)))[0],
    );
    mappedAccount.cashBalance = cash === null ? '—' : cash.toFixed(2);
    return {
      account: mappedAccount,
      positions: enriched,
      equity: equity?.toFixed(2) ?? null,
      positionsValue: positionsValue?.toFixed(2) ?? null,
      todayPl: todayPl?.toFixed(2) ?? null,
      totalPl: totalPl?.toFixed(2) ?? null,
      totalPlPct: totalPl === null ? null : ((totalPl / Number(account.initialCash)) * 100).toFixed(2),
      valuationGaps: [...new Set(valuationGaps)],
      todayOrderCount: todayOrders.length,
      circuitBreakerActive: equity !== null && dayStart !== null && this.circuitBreakerHit(dayStart, equity, this.parseGuardrails(account.guardrails)),
      curve,
      recentOrders: recentOrders.map((o) => this.mapOrder(o)),
      recentEvents: recentEvents.map((e) => ({
        id: e.id,
        eventType: e.eventType as PaperOverview['recentEvents'][number]['eventType'],
        detail: (e.detail as Record<string, unknown>) ?? null,
        createdAt: e.createdAt.toISOString(),
      })),
    };
  }

  /** Place an order (market orders only in V1; limits are rejected early). */
  async placeOrder(
    userId: string,
    dto: CreatePaperOrderDto,
    source: PaperOrderSource,
    agentInfo?: { sessionId: string; agentName: string; approvalMode: 'auto' | 'require_approval' },
    suppressNotification = false,
    strictQuote = false,
    builderProfile?: BuilderProfile,
    councilApproval?: { sessionId: string; reportId: string; candidate: CouncilCandidate },
    strategySignalId?: string,
    expectedAccountId?: string,
    approvedPendingOrderId?: string,
  ): Promise<PaperOrder> {
    const initialAccount = await this.requireAccount(userId);
    if (expectedAccountId && expectedAccountId !== initialAccount.id) throw new BadRequestException('Paper account changed');
    if (typeof dto.ticker !== 'string' || !/^[A-Za-z0-9.^-]{1,20}$/.test(dto.ticker.trim())) throw new BadRequestException('Invalid ticker');
    dto = { ...dto, ticker: dto.ticker.trim() };
    // Every execution path requires a fresh server quote; AI cannot use a manual fallback.
    strictQuote = true;
    if (dto.orderType && dto.orderType !== 'market') {
      throw new BadRequestException('V1 only supports market orders');
    }
    const quantity = Number(dto.quantity);
    if (!Number.isSafeInteger(quantity) || quantity <= 0) {
      throw new BadRequestException('Quantity must be a positive integer');
    }
    if (dto.side !== 'buy' && dto.side !== 'sell') {
      throw new BadRequestException('Side must be buy or sell');
    }

    if (!this.tradingMarket) throw new BadRequestException('Validated market service unavailable / 无法获取近期报价');
    const strategySnapshot = await this.tradingMarket.getSnapshot(dto.ticker, new Date(), true);
    let needsIndicators = false;
    let needsPortfolioRisk = false;
    if (strategySignalId) {
      if (source !== 'agent' || !builderProfile?.config.automation?.enabled) throw new BadRequestException('A current automatic strategy is required');
      const [requestedSignal] = await this.db.select({ candidate: strategySignals.candidate }).from(strategySignals)
        .where(and(eq(strategySignals.id, strategySignalId), eq(strategySignals.owner, userId)));
      needsIndicators = requestedSignal?.candidate.protectiveStop !== true;
      needsPortfolioRisk = Boolean(requestedSignal?.candidate.mandateId && !requestedSignal.candidate.protectiveStop);
    }
    const now = Date.now();
    if (!strategySnapshot.quoteUsable || (needsIndicators && !strategySnapshot.usable) || strategySnapshot.halted
      || !Number.isFinite(strategySnapshot.price) || !strategySnapshot.price || !strategySnapshot.currency || !strategySnapshot.market
      || !strategySnapshot.quoteTimestamp || !strategySnapshot.schedule?.calendarVerified || !strategySnapshot.schedule.isOpen
      || !strategySnapshot.schedule.sessions.some((session) => now >= Date.parse(session.opensAt) && now < Date.parse(session.closesAt))) {
      throw new BadRequestException(`无法获取 ${dto.ticker} 的近期报价 / Fresh validated market data is unavailable: ${strategySnapshot.quoteReason ?? strategySnapshot.reason ?? 'market_closed'}`);
    }
    const fxToUsd = await this.fxService.convert(1, strategySnapshot.currency, 'USD');
    if (!Number.isFinite(fxToUsd) || fxToUsd <= 0) throw new BadRequestException('FX data unavailable / 汇率不可用');
    const price: ResolvedPrice = { price: strategySnapshot.price, market: strategySnapshot.market,
      currency: strategySnapshot.currency, company: null, fxToUsd };
    if (price.market === 'US') dto = { ...dto, ticker: dto.ticker.toUpperCase() };
    const quoteTimestamp = Date.parse(strategySnapshot.quoteTimestamp);
    const portfolioInputs = needsPortfolioRisk ? await preparePortfolioRiskInputs(this.db, userId, initialAccount.id,
      this.tradingMarket, this.fxService, new Date(), [dto.ticker]) : undefined;
    // Fetch expensive portfolio valuations before taking the account row lock.
    // Solvency and order-count checks below use the locked, current ledger.
    let equityBeforeLock: number;
    try { equityBeforeLock = await this.equityOf(userId, initialAccount); }
    catch (error) { if (dto.side === 'buy') throw error; equityBeforeLock = 0; }
    let dayStart = 0;
    try { dayStart = await this.dayStartEquity(userId, initialAccount.id, initialAccount.initialCash); }
    catch (error) { if (dto.side === 'buy') throw error; }

    const committed = await this.db.transaction(async (tx) => {
      await lockMemoryOwner(tx, userId);
      const [lockedAccount] = await tx.select().from(paperAccounts)
        .where(and(eq(paperAccounts.id, initialAccount.id), eq(paperAccounts.owner, userId)))
        .for('update');
      if (!lockedAccount || !lockedAccount.isActive || (expectedAccountId && lockedAccount.id !== expectedAccountId)) throw new BadRequestException('Paper account changed during execution');
      const execution = executionEconomics(price.price, quantity, dto.side, lockedAccount.executionModel?.feeBps ?? 0, lockedAccount.executionModel?.slippageBps ?? 0);
      if (approvedPendingOrderId) {
        const [pending] = await tx.select().from(paperOrders).where(and(eq(paperOrders.id, approvedPendingOrderId), eq(paperOrders.accountId, lockedAccount.id), eq(paperOrders.owner, userId))).for('update');
        if (!pending || pending.status !== 'pending_approval' || pending.ticker !== dto.ticker || pending.side !== dto.side || Number(pending.quantity) !== quantity) throw new BadRequestException('Order is no longer pending approval');
      }
      if (source === 'agent' && !lockedAccount.botEnabled) {
        throw new BadRequestException('Bot is not enabled');
      }
      if (source === 'agent' && !builderProfile) {
        const [configured] = await tx.select({ id: builderProfiles.id }).from(builderProfiles)
          .where(and(eq(builderProfiles.owner, userId), eq(builderProfiles.status, 'active')));
        if (configured) throw new BadRequestException('Use the active Builder scan to review this order');
      }
      if (builderProfile) {
        const [active] = await tx.select({ version: builderProfiles.version })
          .from(builderProfiles)
          .where(and(
            eq(builderProfiles.id, builderProfile.id),
            eq(builderProfiles.owner, userId),
            eq(builderProfiles.status, 'active'),
          )).for('update');
        if (!active || active.version !== builderProfile.version) {
          throw new BadRequestException('Agent configuration changed during the scan');
        }
      }
      if (builderProfile?.config.automation?.enabled && !strategySignalId) {
        throw new BadRequestException('An immutable approved strategy signal is required');
      }
      let strategyRule: StrategyRule | null = null;
      let lockedPortfolioEquity: number | null = null;
      let protectiveStrategyStop = false;
      let strategyPlanId: string | null = null;
      if (strategySignalId) {
        const [signal] = await tx.select().from(strategySignals).where(and(eq(strategySignals.id, strategySignalId),
          eq(strategySignals.owner, userId))).for('update');
        const [plan] = signal ? await tx.select().from(strategyPlans).where(and(eq(strategyPlans.id, signal.planId),
          eq(strategyPlans.owner, userId))).for('update') : [];
        const candidate = signal?.candidate;
        strategyRule = plan?.rules.find((rule) => rule.id === signal?.ruleId) ?? null;
        const now = Date.now();
        if (!signal || signal.state !== 'approved' || signal.orderId || !candidate || !plan || !strategyRule
          || !builderProfile || signal.profileId !== builderProfile.id
          || (candidate.accountId && candidate.accountId !== lockedAccount.id)
          || candidate.planVersion !== plan.version || candidate.ticker !== dto.ticker || candidate.side !== dto.side
          || candidate.quantity !== quantity || candidate.signalId !== signal.id
          || candidate.market !== price.market || plan.market !== price.market
          || strategyRule.ticker !== dto.ticker || !strategySnapshot?.schedule?.calendarVerified
          || !strategySnapshot.schedule.isOpen || !strategySnapshot.schedule.sessions.some((session) =>
            now >= Date.parse(session.opensAt) && now < Date.parse(session.closesAt))
          || Math.abs(now - Date.parse(candidate.quoteAt)) > strategySnapshot.maxQuoteAgeSeconds * 1000) {
          throw new BadRequestException('Strategy signal is stale, changed, consumed or no longer triggered');
        }
        if (!candidate.protectiveStop && (execution.price < strategyRule.minPrice || execution.price > strategyRule.maxPrice)) {
          throw new BadRequestException('Slippage-adjusted fill price exceeds the authorized strategy band');
        }
        let portfolioRisk: ReturnType<typeof evaluatePortfolioRisk> | undefined;
        if (candidate.mandateId && !candidate.protectiveStop) {
          if (!portfolioInputs) throw new BadRequestException('Portfolio inputs changed; create a new candidate');
          const [mandate] = await tx.select().from(strategyMandates).where(and(eq(strategyMandates.id, candidate.mandateId), eq(strategyMandates.owner, userId))).for('share');
          if (!mandate) throw new BadRequestException('Published strategy unavailable');
          const portfolio = await readPortfolioRiskSnapshot(tx, userId, lockedAccount.id, this.tradingMarket!, this.fxService,
            new Date(), portfolioInputs);
          lockedPortfolioEquity = portfolio.equityUsd;
          portfolioRisk = evaluatePortfolioRisk(portfolio, mandate.config, candidate, execution.price * price.fxToUsd,
            execution.fee * price.fxToUsd, new Date());
        }
        await assertMandateExecution(tx, userId, lockedAccount.id, candidate, strategyRule,
          lockedPortfolioEquity ?? Math.min(equityBeforeLock, equityBeforeLock + Number(lockedAccount.cashBalance) - Number(initialAccount.cashBalance)),
          execution.price * price.fxToUsd, new Date(), strategySnapshot ?? undefined, portfolioRisk);
        strategyPlanId = plan.id;
        if (candidate.protectiveStop) {
          const [protection] = candidate.protectionId ? await tx.select().from(strategyProtections).where(and(
            eq(strategyProtections.id, candidate.protectionId), eq(strategyProtections.owner, userId),
            eq(strategyProtections.accountId, lockedAccount.id))).for('update') : [];
          if (!protection || protection.version !== candidate.protectionVersion || protection.ticker !== dto.ticker
            || protection.planId !== plan.id || protection.ruleId !== strategyRule.id
            || dto.side !== 'sell' || price.price > Number(protection.stopLossPrice)) {
            throw new BadRequestException('Position protection is no longer valid or triggered');
          }
          protectiveStrategyStop = true;
        } else if (plan.profileId !== builderProfile.id || plan.profileVersion !== builderProfile.version
          || plan.status !== 'active' || plan.expiresAt.getTime() <= now || Date.parse(strategyRule.expiresAt) <= now
          || strategySnapshot.schedule.tradingDate !== plan.marketDate || Math.abs(price.price / candidate.price - 1) > 0.005
          || strategyRule.side !== dto.side || !strategyTriggerMatches(strategyRule, price.price, strategySnapshot.indicators)) {
          throw new BadRequestException('Entry plan is expired, superseded or price moved');
        }
        if (!protectiveStrategyStop) {
          const inventory = plan.memoryInventory ?? { state: 'unknown' as const, dependencies: [], reason: 'MEMORY_LEGACY_PLAN_REVIEW_REQUIRED' };
          await observeThesisMonitors(tx, userId, inventory, strategySnapshot!, builderProfile.id);
          const memoryBlock = await strategyMemoryBlock(tx, userId, inventory, dto.ticker, new Date(), true);
          if (memoryBlock) {
            await tx.update(strategySignals).set({ state: 'blocked', reason: memoryBlock, updatedAt: new Date() }).where(eq(strategySignals.id, signal.id));
            await settleStrategyReservation(tx, userId, signal.id, 'released', memoryBlock);
            return { memoryBlock };
          }
          if (builderProfile.config.tickers.length && !builderProfile.config.tickers.includes(dto.ticker)) {
            throw new BadRequestException('Ticker is outside the current investor allowlist');
          }
          if (!builderProfile.config.tickers.length) {
            const owned = await tx.select({ id: holdings.id }).from(holdings).where(and(eq(holdings.owner, userId), eq(holdings.ticker, dto.ticker))).limit(1);
            const watched = await tx.select({ id: watchlist.id }).from(watchlist).where(and(eq(watchlist.owner, userId), eq(watchlist.ticker, dto.ticker))).limit(1);
            const held = await tx.select({ id: paperPositions.id }).from(paperPositions).where(and(eq(paperPositions.accountId, lockedAccount.id), eq(paperPositions.ticker, dto.ticker))).limit(1);
            if (!owned.length && !watched.length && !held.length) throw new BadRequestException('Ticker was removed from the investor universe');
          }
        }
      }
      if (builderProfile?.config.council?.enabled && !councilApproval && !strategySignalId) {
        throw new BadRequestException('A current council approval is required');
      }
      if (councilApproval) {
        // Serialize with user steering/pause and consume approval with the fill.
        const [session] = await tx.select().from(councilSessions).where(and(
          eq(councilSessions.id, councilApproval.sessionId), eq(councilSessions.owner, userId),
        )).for('update');
        const [report] = await tx.select().from(councilReports).where(and(
          eq(councilReports.id, councilApproval.reportId), eq(councilReports.owner, userId),
        )).for('update');
        const candidate = report?.candidate;
        if (!session || !report || !builderProfile || session.profileId !== builderProfile.id
          || session.profileVersion !== builderProfile.version || session.status !== 'completed'
          || report.sessionId !== session.id || report.revision !== session.revision
          || report.decision !== 'approve' || report.paperOrderId || !candidate
          || candidate.ticker !== dto.ticker.toUpperCase() || candidate.side !== dto.side
          || candidate.quantity !== quantity || candidate.price !== councilApproval.candidate.price
          || Date.now() - report.createdAt.getTime() > 30 * 60000
          || Math.abs(price.price / candidate.price - 1) > 0.005) {
          throw new BadRequestException('Council approval is obsolete, already used, or price moved; review again');
        }
      }
      if (strictQuote && (quoteTimestamp === null
        || Math.abs(Date.now() - quoteTimestamp) > (strategySnapshot?.maxQuoteAgeSeconds ?? 300) * 1000)) {
        throw new BadRequestException(`无法获取 ${dto.ticker} 的近期报价，订单未执行`);
      }
      const account = lockedAccount;

      const notionalUsd = quantity * execution.price * price.fxToUsd;
      const equity = lockedPortfolioEquity ?? Math.min(equityBeforeLock, equityBeforeLock + Number(account.cashBalance) - Number(initialAccount.cashBalance));
      const riskTimezone = await paperRiskTimezone(tx, userId, account.id);
      const riskDay = paperRiskDay(new Date(), riskTimezone);
      const recentStart = new Date(Date.now() - 48 * 3600_000);
      const recentAccountOrders = await tx.select().from(paperOrders).where(and(eq(paperOrders.accountId, account.id),
        or(gte(paperOrders.createdAt, recentStart), gte(paperOrders.filledAt, recentStart), eq(paperOrders.status, 'pending_approval'))));
      const todayOrders = recentAccountOrders.filter((order) => order.status === 'pending_approval'
        || paperRiskDay(order.filledAt ?? order.createdAt, riskTimezone) === riskDay);
      const todayBotCount = todayOrders.filter((o) => o.source === 'agent' && o.id !== approvedPendingOrderId).length;
      const accountGuardrails = this.parseGuardrails(account.guardrails);
      const guardrails = builderProfile ? {
        maxOrderPct: Math.min(accountGuardrails.maxOrderPct, builderProfile.config.maxOrderPct),
        dailyLossLimitPct: Math.min(accountGuardrails.dailyLossLimitPct, builderProfile.config.dailyLossLimitPct),
        maxOrdersPerDay: Math.min(accountGuardrails.maxOrdersPerDay, builderProfile.config.maxOrdersPerDay),
      } : accountGuardrails;

      // ---- Risk gate (bot orders; manual orders skip caps but keep solvency) ----
      let rejection: string | undefined;
      const knownActionGaps = await readCorporateActionGaps(tx, userId, account.id);
      const [targetPosition] = await tx.select().from(paperPositions).where(and(eq(paperPositions.accountId, account.id), eq(paperPositions.ticker, dto.ticker)));
      const newActions = targetPosition ? strategySnapshot.corporateActions?.filter((event) => Date.parse(event.occurredAt) >= targetPosition.openedAt.getTime()
        && Date.parse(event.occurredAt) <= Date.now()) ?? [] : [];
      if (newActions.length || knownActionGaps.some(gap => gap.ticker === dto.ticker)) {
        rejection = 'Corporate action detected since opening; reconcile and create a new seed before further orders';
        await persistCorporateActionGaps(tx, userId, account.id, dto.ticker, newActions);
      }
      let circuitBreaker = false;
      let sessionRequiresApproval = agentInfo?.approvalMode === 'require_approval';
      if (agentInfo) {
        const [session] = await tx.select().from(agentSessions).where(and(eq(agentSessions.id, agentInfo.sessionId), eq(agentSessions.owner, userId))).for('update');
        if (!session || session.status !== 'active' || session.permission !== 'trade') throw new BadRequestException('Agent session is no longer authorized to trade');
        sessionRequiresApproval = session.approvalMode !== 'auto';
        const sessionOrders = await tx.select().from(paperOrders).where(and(eq(paperOrders.owner, userId),
          eq(paperOrders.accountId, account.id), eq(paperOrders.sessionId, session.id), eq(paperOrders.side, 'buy'),
          or(and(eq(paperOrders.status, 'filled'), gte(paperOrders.filledAt, recentStart)), eq(paperOrders.status, 'pending_approval'))));
        const committedSpend = sessionOrders.filter((o) => o.id !== approvedPendingOrderId
          && (o.status === 'pending_approval' || paperRiskDay(o.filledAt ?? o.createdAt, riskTimezone) === riskDay))
          .reduce((sum, o) => {
            const risk = o.riskCheck as RiskCheck | null;
            return sum + Number(risk?.cashAmountUsd ?? (Number(risk?.notionalUsd ?? 0) + Number(risk?.feeUsd ?? 0)));
          }, 0);
        if (dto.side === 'buy' && committedSpend + execution.cashAmount * price.fxToUsd > Number(session.dailyLimitUsd)) rejection = 'Agent session daily USD spending limit exceeded';
      }
      if (source === 'agent') {
        if (!isMarketOpen(price.market)) {
          rejection = `${dto.ticker} 所在市场当前未开盘`;
        } else if (dto.side === 'buy' && !protectiveStrategyStop && this.circuitBreakerHit(dayStart, equity, guardrails)) {
          circuitBreaker = true;
          rejection = `日亏损熔断：当日权益回撤已超过 ${guardrails.dailyLossLimitPct}%，今日停止交易`;
        } else if (dto.side === 'buy' && notionalUsd > (equity * guardrails.maxOrderPct) / 100) {
          // The per-order cap constrains exposure on the way in; closing a
          // position must never be blocked by it.
          rejection = `单笔金额 ${(notionalUsd / equity * 100).toFixed(1)}% 超过上限 ${guardrails.maxOrderPct}%`;
        } else if (dto.side === 'buy' && !protectiveStrategyStop && todayBotCount >= guardrails.maxOrdersPerDay) {
          rejection = `今日 bot 订单已达 ${guardrails.maxOrdersPerDay} 笔上限`;
        }
        const recentOrders = await tx.select().from(paperOrders).where(and(
          eq(paperOrders.accountId, account.id), or(gte(paperOrders.createdAt, new Date(Date.now() - 100 * 86400000)), eq(paperOrders.status, 'pending_approval')),
        ));
        const cadenceReason = cadenceRejection(normalizeCadence(builderProfile?.config.cadence), {
          ticker: dto.ticker, market: price.market, notionalUsd, equityUsd: equity,
          orders: recentOrders.filter((order) => order.id !== approvedPendingOrderId).map((order) => ({ ticker: order.ticker, market: order.market as Market,
            createdAt: order.createdAt, status: order.status,
            notionalUsd: Number((order.riskCheck as RiskCheck | null)?.notionalUsd ?? 0) })),
        });
        if (dto.side === 'buy' && !protectiveStrategyStop) rejection ??= cadenceReason ?? undefined;
        const rule = builderProfile?.config.priceRules?.find((item) => item.ticker === dto.ticker.toUpperCase());
        if (!strategySignalId && dto.side === 'buy' && rule?.buyAtOrBelow !== undefined && execution.price > rule.buyAtOrBelow) {
          rejection ??= 'Price is above the investor buy threshold';
        }
        const originalReason = councilApproval?.candidate.reason ?? dto.reason ?? '';
        if (!strategySignalId && !protectiveStrategyStop && dto.side === 'sell' && rule?.sellAtOrAbove !== undefined
          && originalReason.includes('Investor price rule:') && execution.price < rule.sellAtOrAbove) {
          rejection ??= 'Price is below the investor sell threshold';
        }
      }

      // ---- Solvency checks (both sources) ----
      const cash = Number(account.cashBalance);
      const reservations = (await tx.select().from(strategyReservations).where(and(eq(strategyReservations.owner, userId),
        eq(strategyReservations.accountId, account.id), eq(strategyReservations.status, 'active'), gt(strategyReservations.expiresAt, new Date()))))
        .filter(reservation => reservation.signalId !== strategySignalId);
      const reservedCash = reservations.filter(reservation => reservation.side === 'buy'
        && reservation.currency === (account.ledgerMode === 'native_currency' ? price.currency : 'USD'))
        .reduce((sum, reservation) => sum + Number(reservation.cash), 0);
      const reservedShares = reservations.filter(reservation => reservation.side === 'sell'
        && reservation.ticker === (price.market === 'US' ? dto.ticker.toUpperCase() : dto.ticker))
        .reduce((sum, reservation) => sum + Number(reservation.shares), 0);
      const [existing] = await tx
        .select()
        .from(paperPositions)
        .where(and(eq(paperPositions.accountId, account.id), eq(paperPositions.ticker, price.market === 'US' ? dto.ticker.toUpperCase() : dto.ticker)));
      if (account.ledgerMode === 'native_currency') {
        await settleSimulationCash(tx, account.id);
        const [nativeCash] = await tx.select().from(simulationCash).where(and(eq(simulationCash.accountId, account.id), eq(simulationCash.currency, price.currency)));
        if (dto.side === 'buy' && execution.cashAmount > Number(nativeCash?.available ?? 0) - reservedCash) rejection ??= `Insufficient unreserved available ${price.currency}; convert cash explicitly`;
      } else if (price.currency !== 'USD') {
        rejection ??= 'Create a native-currency experiment and explicitly convert cash before foreign-currency trading';
      }
      if (dto.side === 'buy' && account.ledgerMode !== 'native_currency' && execution.cashAmount * price.fxToUsd > cash - reservedCash) {
        rejection = rejection ?? `现金不足：需 ${notionalUsd.toFixed(2)} USD，可用 ${cash.toFixed(2)} USD`;
      }
      if (strategyRule && dto.side === 'buy') {
        const totalExposure = (quantity + Number(existing?.shares ?? 0)) * execution.price * price.fxToUsd;
        if (builderProfile?.config.template === 'guard' || totalExposure > equity * strategyRule.maxPositionPct / 100) {
          rejection ??= 'Strategy maximum position or template limit exceeded';
        }
      }
      let sellable = Math.max(0, Number(existing?.shares ?? 0) - Number(existing?.restrictedShares ?? 0));
      if (dto.side === 'sell') {
        const held = existing ? Number(existing.shares) : 0;
        if (quantity > held) {
          rejection = rejection ?? `持仓不足：仅有 ${held} 股，无法卖出 ${quantity} 股`;
        }
        if (quantity > Math.max(0, held - Number(existing?.restrictedShares ?? 0))) rejection ??= 'Opening shares have unknown or restricted sellability';
        if (price.market === 'CN') {
          const buys = await tx.select().from(paperOrders).where(and(eq(paperOrders.accountId, account.id),
            eq(paperOrders.ticker, dto.ticker), eq(paperOrders.side, 'buy'), eq(paperOrders.status, 'filled'),
            gte(paperOrders.filledAt, new Date(Date.now() - 48 * 3600000))));
          const boughtToday = buys.filter((order) => order.filledAt && marketDate('CN', order.filledAt) === marketDate('CN'))
            .reduce((sum, order) => sum + Number(order.quantity), 0);
          sellable = Math.max(0, held - Number(existing?.restrictedShares ?? 0) - boughtToday);
          if (quantity > sellable) rejection ??= 'CN T+1 shares are not yet sellable';
        }
        sellable = Math.max(0, sellable - reservedShares);
        if (quantity > sellable) rejection ??= 'Shares reserved by another active candidate are unavailable';
      }

      rejection ??= simulationLotRejection(dto.ticker, price.market, dto.side, quantity, sellable, strategySnapshot.lotSize) ?? undefined;

      const riskCheck: RiskCheck = {
        passed: !rejection,
        side: dto.side,
        notionalUsd: Number(notionalUsd.toFixed(2)),
        equityUsd: Number(equity.toFixed(2)),
        orderPct: equity > 0 ? Number(((notionalUsd / equity) * 100).toFixed(2)) : 0,
        todayOrderCount: todayBotCount,
        circuitBreaker,
        reason: rejection, feeUsd: execution.fee * price.fxToUsd,
        cashAmountUsd: execution.cashAmount * price.fxToUsd,
        executionModel: { version: 'paper-v1', feeBps: account.executionModel?.feeBps ?? 0, slippageBps: account.executionModel?.slippageBps ?? 0 },
      };

      const ticker = price.market === 'US' ? dto.ticker.toUpperCase() : dto.ticker;
      // Determine the final status: agent orders in require_approval mode go
      // to pending_approval instead of filling immediately.
      const needsApproval =
        source === 'agent' && sessionRequiresApproval && !approvedPendingOrderId;
      const finalStatus = rejection ? 'rejected_risk' : needsApproval ? 'pending_approval' : 'filled';

      const orderValues = {
          owner: userId,
          accountId: account.id,
          ticker,
          market: price.market,
          currency: price.currency,
          company: price.company,
          side: dto.side,
          orderType: 'market',
          quantity: String(quantity),
          status: finalStatus,
          source,
          reason: rejection ?? dto.reason ?? null,
          riskCheck,
          filledPrice: rejection || needsApproval ? null : String(execution.price),
          filledAt: rejection || needsApproval ? null : new Date(),
          sessionId: agentInfo?.sessionId ?? null,
          agentName: agentInfo?.agentName ?? null,
      };
      const [order] = approvedPendingOrderId
        ? await tx.update(paperOrders).set(orderValues).where(and(eq(paperOrders.id, approvedPendingOrderId), eq(paperOrders.accountId, account.id))).returning()
        : await tx.insert(paperOrders).values(orderValues).returning();

      if (strategySignalId && builderProfile) {
        await tx.update(strategySignals).set({ state: finalStatus === 'filled' ? 'filled' : 'blocked',
          orderId: order.id, reason: rejection ?? dto.reason ?? '', updatedAt: new Date() })
          .where(and(eq(strategySignals.id, strategySignalId), eq(strategySignals.owner, userId)));
        await settleStrategyReservation(tx, userId, strategySignalId, finalStatus === 'filled' ? 'consumed' : 'released', rejection ?? dto.reason ?? finalStatus);
        if (builderProfile.config.notifyOnProposal) await tx.insert(strategyOutbox).values({ owner: userId, profileId: builderProfile.id,
          eventKey: `strategy-order:${order.id}`, payload: { event: finalStatus === 'filled' ? 'strategy_filled' : 'strategy_blocked',
            title: builderProfile.config.language === 'en'
              ? finalStatus === 'filled' ? 'Automatic PAPER fill' : 'Automatic PAPER risk block'
              : finalStatus === 'filled' ? '自动模拟盘成交' : '自动模拟盘风控拦截',
            body: `${ticker} ${dto.side} ${quantity} @ ${execution.price} ${price.currency}\n${rejection ?? dto.reason ?? ''}` } });
      }

      if (rejection) {
        await tx.insert(paperEvents).values({
          owner: userId,
          accountId: account.id,
          eventType: circuitBreaker ? 'circuit_breaker' : 'order_rejected',
          detail: { orderId: order.id, ticker, side: dto.side, reason: rejection },
        });
        return { order, notification: suppressNotification ? null : {
          event: circuitBreaker ? 'circuit_breaker' : 'order_rejected',
          title: circuitBreaker ? '熔断触发' : '订单被风控拦截',
          body: `${ticker} ${dto.side === 'buy' ? '买入' : '卖出'} ${quantity} 股被拦截：${rejection}`,
        } as NotificationPayload };
      }

      // Agent order awaiting user approval: record event, notify, return.
      if (needsApproval) {
        await tx.insert(paperEvents).values({
          owner: userId,
          accountId: account.id,
          eventType: 'order_placed',
          detail: {
            orderId: order.id, ticker, side: dto.side, quantity,
            reason: dto.reason ?? '', agentName: agentInfo?.agentName ?? '',
            pendingApproval: true,
          },
        });
        return { order, notification: suppressNotification ? null : {
          event: 'pending_approval',
          title: `AI 代理 ${agentInfo?.agentName ?? ''} 请求${dto.side === 'buy' ? '买入' : '卖出'} ${ticker}`,
          body: `数量 ${quantity} 股，理由：${dto.reason ?? '未提供'}。请到模拟盘页面审批。`,
        } as NotificationPayload };
      }

      // ---- Execute the fill ----
      if (account.ledgerMode === 'native_currency') await recordSimulationCashFill(tx, userId, account.id,
        price.currency, price.market, dto.side, execution.cashAmount);
      let cashAfter = cash;
      let realizedPl: number | null = null;
      if (dto.side === 'buy') {
        cashAfter = cash - execution.cashAmount * price.fxToUsd;
        const totalShares = (existing ? Number(existing.shares) : 0) + quantity;
        const totalCost = (existing ? Number(existing.shares) * Number(existing.avgCost) : 0) + execution.gross + execution.fee;
        const avgCost = totalShares > 0 ? totalCost / totalShares : 0;
        if (existing) {
          await tx
            .update(paperPositions)
            .set({ shares: String(totalShares), avgCost: String(avgCost), updatedAt: new Date() })
            .where(eq(paperPositions.id, existing.id));
        } else {
          await tx.insert(paperPositions).values({
            owner: userId,
            accountId: account.id,
            ticker,
            market: price.market,
            currency: price.currency,
            company: price.company,
            shares: String(totalShares),
            avgCost: String(avgCost),
          });
        }
        if (strategyRule && strategyPlanId) await tx.insert(strategyProtections).values({ owner: userId,
          accountId: account.id, ticker, market: price.market, stopLossPrice: String(strategyRule.stopLossPrice),
          planId: strategyPlanId, ruleId: strategyRule.id }).onConflictDoUpdate({
          target: [strategyProtections.owner, strategyProtections.accountId, strategyProtections.ticker],
          set: { stopLossPrice: sql`greatest(${strategyProtections.stopLossPrice}, ${strategyRule.stopLossPrice})`,
            planId: strategyPlanId, ruleId: strategyRule.id, version: sql`${strategyProtections.version} + 1`, updatedAt: new Date() },
        });
      } else {
        cashAfter = cash + execution.cashAmount * price.fxToUsd;
        realizedPl = ((execution.price - Number(existing.avgCost)) * quantity - execution.fee) * price.fxToUsd;
        const remaining = Number(existing.shares) - quantity;
        if (remaining > 0) {
          await tx
            .update(paperPositions)
            .set({ shares: String(remaining), updatedAt: new Date() })
            .where(eq(paperPositions.id, existing.id));
        } else {
          await tx.delete(paperPositions).where(eq(paperPositions.id, existing.id));
          await tx.delete(strategyProtections).where(and(eq(strategyProtections.owner, userId),
            eq(strategyProtections.accountId, account.id), eq(strategyProtections.ticker, ticker)));
        }
      }

      await tx
        .update(paperAccounts)
        .set({ cashBalance: cashAfter.toFixed(2), updatedAt: new Date() })
        .where(eq(paperAccounts.id, account.id));

      await tx.insert(paperTrades).values({
        owner: userId,
        accountId: account.id,
        orderId: order.id,
        ticker,
        market: price.market,
        side: dto.side,
        quantity: String(quantity),
        price: String(execution.price),
        fee: (execution.fee * price.fxToUsd).toFixed(8),
        realizedPl: realizedPl === null ? null : realizedPl.toFixed(2),
        cashAfter: cashAfter.toFixed(2),
      });

      await tx.insert(paperEvents).values({
        owner: userId,
        accountId: account.id,
        eventType: 'order_filled',
        detail: {
          orderId: order.id, ticker, side: dto.side, quantity, price: execution.price,
          source, notionalUsd: Number(notionalUsd.toFixed(2)),
          realizedPl: realizedPl === null ? undefined : Number(realizedPl.toFixed(2)),
        },
      });

      // The proposal is committed with the fill under the same account lock.
      // A second replica hitting the daily unique key rolls back its entire
      // paper order instead of leaving a duplicate fill without an inbox row.
      if (builderProfile && !strategySignalId) {
        const now = new Date();
        const [proposal] = await tx.insert(builderProposals).values({
          owner: userId,
          profileId: builderProfile.id,
          profileVersion: builderProfile.version,
          signalDate: now.toISOString().slice(0, 10),
          ticker,
          market: price.market,
          currency: price.currency,
          side: dto.side,
          quantity: String(quantity),
          referencePrice: String(execution.price),
          reason: dto.reason ?? '',
          paperOrderId: order.id,
          expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
        }).onConflictDoNothing().returning({ id: builderProposals.id });
        if (!proposal) throw new BadRequestException('Signal already processed today');
      }
      if (councilApproval) {
        await tx.update(councilReports).set({ paperOrderId: order.id })
          .where(and(eq(councilReports.id, councilApproval.reportId), eq(councilReports.owner, userId)));
      }

      return { order, notification: suppressNotification ? null : {
        event: 'order_filled',
        title: `模拟盘成交：${ticker} ${dto.side === 'buy' ? '买入' : '卖出'} ${quantity} 股`,
        body: `成交价 ${execution.price}（${price.currency}），约 ${notionalUsd.toFixed(2)} USD`
          + (realizedPl !== null ? `，已实现盈亏 ${realizedPl >= 0 ? '+' : ''}${realizedPl.toFixed(2)} USD` : '')
          + (source === 'agent' ? '\n来源：AI 盯盘代理' : '\n来源：手动下单'),
      } as NotificationPayload };
    });
    if ('memoryBlock' in committed) throw new BadRequestException(committed.memoryBlock);
    if (committed.notification) {
      await this.notifications.notifyUser(userId, committed.notification);
    }
    if (builderProfile?.config.notifyOnProposal && !strategySignalId && committed.order.status === 'filled') {
      await this.notifications.notifyUser(userId, {
        event: 'builder_proposal',
        title: `${builderProfile.config.name}: ${committed.order.ticker} ${dto.side === 'buy' ? 'buy' : 'sell'} idea`,
        body: `${dto.reason ?? ''}\nPaper: ${quantity} @ ${price.price} ${price.currency}. Review in Squabble; place a real order yourself if desired.`,
      });
    }
    return this.mapOrder(committed.order);
  }

  /** Enable/disable the bot for the caller's account. */
  async toggleBot(userId: string, enabled: boolean): Promise<PaperAccount> {
    const account = await this.requireAccount(userId);
    if (!enabled) {
      const active = await this.builder.getActiveProfile(userId);
      if (active) await this.builder.pauseProfile(userId, active.id);
    } else {
      // Establish the first day opening equity before the scheduler can trade.
      await this.ensureDailySnapshot(userId, account.id);
    }
    const updated = await this.db.transaction(async (tx) => {
      await lockMemoryOwner(tx, userId);
      const [current] = await tx.select().from(paperAccounts).where(and(eq(paperAccounts.id, account.id), eq(paperAccounts.isActive, true))).for('update');
      if (!current) throw new BadRequestException('Paper account changed');
      const [row] = await tx.update(paperAccounts).set({ botEnabled: enabled, updatedAt: new Date() })
        .where(eq(paperAccounts.id, account.id)).returning();
      return row;
    });
    await this.recordEvent(userId, account.id, enabled ? 'bot_started' : 'bot_stopped', {});
    return this.mapAccount(updated);
  }

  /**
   * Approve a pending agent order: fill it at the current price.
   * Uses the same fresh-quote, currency, settlement and agent risk gates.
   */
  async approveOrder(userId: string, orderId: string): Promise<PaperOrder> {
    const account = await this.requireAccount(userId);
    const [order] = await this.db.select().from(paperOrders).where(and(eq(paperOrders.id, orderId),
      eq(paperOrders.owner, userId), eq(paperOrders.accountId, account.id)));
    if (!order) throw new NotFoundException('Order not found in the active paper account');
    if (order.status !== 'pending_approval') throw new BadRequestException('Order is not in pending approval state');
    const agentInfo = order.sessionId ? { sessionId: order.sessionId, agentName: order.agentName ?? '', approvalMode: 'auto' as const } : undefined;
    return this.placeOrder(userId, { ticker: order.ticker, side: order.side as PaperSide, quantity: Number(order.quantity),
      orderType: 'market', reason: order.reason ?? undefined }, 'agent', agentInfo, false, true,
      undefined, undefined, undefined, account.id, order.id);
  }

  /** Reject a pending agent order. */
  async rejectOrder(userId: string, orderId: string): Promise<PaperOrder> {
    const account = await this.requireAccount(userId);
    const [order] = await this.db
      .select()
      .from(paperOrders)
      .where(and(eq(paperOrders.id, orderId), eq(paperOrders.owner, userId), eq(paperOrders.accountId, account.id)));
    if (!order) throw new NotFoundException('订单不存在');
    if (order.status !== 'pending_approval') {
      throw new BadRequestException('Order is not in pending approval state');
    }
    const [updated] = await this.db
      .update(paperOrders)
      .set({ status: 'cancelled', reason: '用户拒绝审批' })
      .where(and(eq(paperOrders.id, orderId), eq(paperOrders.owner, userId), eq(paperOrders.accountId, account.id), eq(paperOrders.status, 'pending_approval')))
      .returning();
    if (!updated) throw new BadRequestException('Order is no longer pending approval');
    await this.recordEvent(userId, account.id, 'order_rejected', {
      orderId,
      ticker: order.ticker,
      side: order.side,
      reason: '用户拒绝审批',
      agentName: order.agentName,
    });
    return this.mapOrder(updated);
  }

  /** Update guardrail thresholds. */
  async updateGuardrails(userId: string, patch: Partial<PaperGuardrails>): Promise<PaperAccount> {
    const account = await this.requireAccount(userId);
    const next: PaperGuardrails = { ...this.parseGuardrails(account.guardrails) };
    for (const key of ['dailyLossLimitPct', 'maxOrderPct', 'maxOrdersPerDay'] as const) {
      const value = Number(patch[key]);
      if (Number.isFinite(value) && value > 0 && value <= 100) next[key] = value;
    }
    const [updated] = await this.db
      .update(paperAccounts)
      .set({ guardrails: next, updatedAt: new Date() })
      .where(eq(paperAccounts.id, account.id))
      .returning();
    return this.mapAccount(updated);
  }

  /**
   * One bot scan: derive signals from the caller's own analysis ratings and
   * targets, run them through the risk gate, place orders. Used by the
   * scheduler and by the manual "scan now" button.
   */
  async runBotScan(userId: string, expectedAccountId?: string): Promise<{
    scanned: number;
    signals: Array<{ ticker: string; side: PaperSide; reason: string }>;
    placed: number;
    rejected: number;
  }> {
    const account = await this.requireAccount(userId);
    if (expectedAccountId && account.id !== expectedAccountId) throw new BadRequestException('Paper account changed');
    if (!account.botEnabled) {
      throw new BadRequestException('Bot is not enabled');
    }
    const activeProfile = await this.builder.getActiveProfile(userId);
    if (activeProfile?.config.automation?.enabled) {
      throw new BadRequestException('Use the daily automation monitor for this profile');
    }
    if (activeProfile) {
      if (this.activeBuilderScans.has(userId)) {
        throw new BadRequestException('An agent scan is already running');
      }
      this.activeBuilderScans.add(userId);
      let lease: string | null = null;
      try {
        lease = await this.cadence.claimScan(userId);
        if (!lease) throw new BadRequestException('An agent scan is already running');
        return await this.runConfiguredScan(userId, this.mapAccount(account), activeProfile);
      } finally {
        this.activeBuilderScans.delete(userId);
        if (lease) await this.cadence.releaseScan(userId, lease);
      }
    }

    // Universe: the caller's real holdings + watchlist carry the ratings and
    // targets produced by the multi-agent research pipeline.
    const realHoldings = await this.db
      .select()
      .from(holdings)
      .where(eq(holdings.owner, userId));
    const watchItems = await this.db
      .select()
      .from(watchlist)
      .where(eq(watchlist.owner, userId));
    const positions = await this.db
      .select()
      .from(paperPositions)
      .where(eq(paperPositions.accountId, account.id));
    const todayOrders = await this.todayOrders(userId, account.id);
    const tradedToday = new Set(todayOrders.map((o) => o.ticker));

    const universe = new Map<
      string,
      { rating: string | null; targetBuy: number | null; targetPrice: number | null; market: 'US' | 'HK' | 'CN' }
    >();
    for (const h of realHoldings) {
      universe.set(h.ticker, {
        rating: h.rating ?? null,
        targetBuy: null,
        targetPrice: h.targetPrice != null ? Number(h.targetPrice) : null,
        market: (h.market as 'US' | 'HK' | 'CN') ?? 'US',
      });
    }
    for (const w of watchItems) {
      const existing = universe.get(w.ticker);
      universe.set(w.ticker, {
        rating: w.rating ?? existing?.rating ?? null,
        targetBuy: w.targetBuy != null ? Number(w.targetBuy) : null,
        targetPrice: existing?.targetPrice ?? null,
        market: (w.market as 'US' | 'HK' | 'CN') ?? 'US',
      });
    }

    const equity = await this.equityOf(userId, account);
    const guardrails = this.parseGuardrails(account.guardrails);
    const signals: Array<{ ticker: string; side: PaperSide; reason: string; quantity: number }> = [];

    for (const [ticker, info] of universe) {
      if (tradedToday.has(ticker)) continue;
      const held = positions.find((p) => p.ticker === ticker);
      const price = await this.resolvePrice(userId, ticker);
      if (!price || price.price <= 0) continue;
      const bullish = info.rating === 'Buy' || info.rating === 'Strong Buy';
      const bearish = info.rating === 'Sell' || info.rating === 'Strong Sell';

      if (held && Number(held.shares) > 0) {
        if (bearish) {
          signals.push({
            ticker,
            side: 'sell',
            reason: `分析评级为 ${info.rating}，按信号清仓`,
            quantity: Math.floor(Number(held.shares)),
          });
          continue;
        }
        if (info.targetPrice != null && price.price >= info.targetPrice) {
          signals.push({
            ticker,
            side: 'sell',
            reason: `现价 ${price.price} 已达分析目标价 ${info.targetPrice}，止盈清仓`,
            quantity: Math.floor(Number(held.shares)),
          });
          continue;
        }
      }

      if (!held && bullish) {
        const withinBuyZone = info.targetBuy == null || price.price <= info.targetBuy * 1.02;
        if (withinBuyZone && isMarketOpen(price.market)) {
          const notional = Math.min(
            (equity * guardrails.maxOrderPct) / 100,
            Number(account.cashBalance) * 0.9,
          );
          const perShareUsd = price.price * price.fxToUsd;
          const quantity = Math.floor(notional / perShareUsd);
          if (quantity > 0) {
            signals.push({
              ticker,
              side: 'buy',
              reason:
                info.targetBuy != null
                  ? `分析评级 ${info.rating}，现价 ${price.price} 已进入目标买区（≤ ${info.targetBuy}）`
                  : `分析评级 ${info.rating}，按信号建仓`,
              quantity,
            });
          }
        }
      }
    }

    let placed = 0;
    let rejected = 0;
    for (const signal of signals) {
      try {
        const order = await this.placeOrder(
          userId,
          { ticker: signal.ticker, side: signal.side, quantity: signal.quantity, orderType: 'market', reason: signal.reason },
          'agent', undefined, false, true, undefined, undefined, undefined, account.id,
        );
        if (order.status === 'filled') placed += 1;
        else rejected += 1;
      } catch (error) {
        rejected += 1;
        this.logger.warn(`bot order failed for ${signal.ticker}: ${String(error)}`);
      }
    }

    await this.recordEvent(userId, account.id, 'bot_scan', {
      scanned: universe.size,
      signals: signals.map((s) => ({ ticker: s.ticker, side: s.side, reason: s.reason })),
      placed,
      rejected,
    });
    await this.ensureDailySnapshot(userId, account.id);

    return {
      scanned: universe.size,
      signals: signals.map((s) => ({ ticker: s.ticker, side: s.side, reason: s.reason })),
      placed,
      rejected,
    };
  }

  /** Builder scans use recent completed research, fetched quotes and fixed limits. */
  private async runConfiguredScan(userId: string, account: PaperAccount, profile: BuilderProfile): Promise<{
    scanned: number;
    signals: Array<{ ticker: string; side: PaperSide; reason: string }>;
    placed: number;
    rejected: number;
  }> {
    const [realHoldings, watchItems, positions, todayOrders, ratingRows] = await Promise.all([
      this.db.select().from(holdings).where(eq(holdings.owner, userId)),
      this.db.select().from(watchlist).where(eq(watchlist.owner, userId)),
      this.db.select().from(paperPositions).where(eq(paperPositions.accountId, account.id)),
      this.todayOrders(userId, account.id),
      this.db.select({
        ticker: agentRatings.ticker,
        rating: agentRatings.rating,
        confidence: agentRatings.confidence,
        targetPrice: agentRatings.targetPrice,
        createdAt: agentRatings.createdAt,
      }).from(agentRatings)
        .innerJoin(agentRuns, eq(agentRatings.runId, agentRuns.id))
        .where(and(eq(agentRatings.owner, userId), eq(agentRuns.status, 'completed')))
        .orderBy(desc(agentRatings.createdAt)),
    ]);

    const ratings = new Map<string, typeof ratingRows[number]>();
    const seenRatings = new Set<string>();
    const maxResearchAgeMs = 7 * 24 * 60 * 60 * 1000;
    for (const row of ratingRows) {
      const ticker = row.ticker.toUpperCase();
      if (seenRatings.has(ticker)) continue;
      seenRatings.add(ticker);
      if (Date.now() - row.createdAt.getTime() > maxResearchAgeMs) continue;
      if (row.confidence === 'low') continue;
      ratings.set(ticker, row);
    }

    const universe = new Map<string, {
      source: 'holding' | 'watchlist';
      targetBuy: number | null;
    }>();
    for (const holding of realHoldings) {
      universe.set(holding.ticker.toUpperCase(), {
        source: 'holding',
        targetBuy: null,
      });
    }
    for (const item of watchItems) {
      const ticker = item.ticker.toUpperCase();
      universe.set(ticker, {
        source: 'watchlist',
        targetBuy: item.targetBuy == null ? null : Number(item.targetBuy),
      });
    }

    // A non-empty allowlist can include researched names outside the portfolio.
    for (const ticker of profile.config.tickers) {
      if (!universe.has(ticker)) {
        universe.set(ticker, { source: 'watchlist', targetBuy: null });
      }
    }
    for (const rule of profile.config.priceRules ?? []) {
      if (!universe.has(rule.ticker)) {
        universe.set(rule.ticker, { source: 'watchlist', targetBuy: null });
      }
    }
    if (profile.config.tickers.length > 0) {
      for (const ticker of universe.keys()) {
        if (!profile.config.tickers.includes(ticker)) universe.delete(ticker);
      }
    }

    const tradedToday = new Set(todayOrders.map((order) => order.ticker.toUpperCase()));
    const equityUsd = await this.equityOf(userId, account);
    const dayStart = await this.dayStartEquity(userId, account.id, account.initialCash);
    const circuitOpen = this.circuitBreakerHit(dayStart, equityUsd, profile.config);
    const result: {
      scanned: number;
      signals: Array<{ ticker: string; side: PaperSide; reason: string }>;
      placed: number;
      rejected: number;
    } = { scanned: universe.size, signals: [], placed: 0, rejected: 0 };

    for (const [ticker, item] of universe) {
      if (circuitOpen) continue;
      if (todayOrders.filter((order) => order.source === 'agent').length + result.placed >= profile.config.maxOrdersPerDay) break;
      const rating = ratings.get(ticker);
      const priceRule = profile.config.priceRules?.find((rule) => rule.ticker === ticker);
      if (!rating && !priceRule) continue;
      const quote = await this.quoteService.getQuote(ticker);
      if (!quote || Number(quote.price) <= 0 || !isMarketOpen(quote.market)) continue;
      // QuoteService marks all free providers as delayed. The timestamp is
      // retrieval time, not exchange time; a real order requires broker review.
      const fetchedRecently = Number.isFinite(quote.timestamp)
        && Math.abs(Date.now() - quote.timestamp) <= 5 * 60 * 1000;
      if (!fetchedRecently) continue;
      let fxToUsd: number;
      try {
        fxToUsd = await this.fxService.convert(1, quote.currency, 'USD');
      } catch {
        continue;
      }
      const heldShares = Number(positions.find((position) => position.ticker.toUpperCase() === ticker)?.shares ?? 0);
      const signal = decideBuilderSignal(profile.config, {
        ticker,
        source: item.source,
        rating: rating?.rating ?? null,
        heldShares,
        price: Number(quote.price),
        fxToUsd,
        equityUsd,
        cashUsd: Number(account.cashBalance),
        targetBuy: item.targetBuy,
        targetPrice: rating?.targetPrice == null ? null : Number(rating.targetPrice),
        marketOpen: true,
        quoteFresh: fetchedRecently,
        tradedToday: tradedToday.has(ticker),
      });
      if (!signal || await this.builder.hasDailyProposal(profile.id, ticker, signal.side)) continue;
      // Cheap ledger gates precede every model call, including denied ideas.
      const recentOrders = await this.db.select().from(paperOrders).where(and(
        eq(paperOrders.accountId, account.id), or(gte(paperOrders.createdAt, new Date(Date.now() - 100 * 86400000)), eq(paperOrders.status, 'pending_approval')),
      ));
      if (cadenceRejection(normalizeCadence(profile.config.cadence), {
        ticker, market: quote.market, notionalUsd: signal.quantity * Number(quote.price) * fxToUsd, equityUsd,
        orders: recentOrders.map((order) => ({ ticker: order.ticker, market: order.market as Market, createdAt: order.createdAt,
          status: order.status, notionalUsd: Number((order.riskCheck as RiskCheck | null)?.notionalUsd ?? 0) })),
      })) continue;
      const inputHash = createHash('sha256').update(JSON.stringify({
        version: profile.version, ticker, side: signal.side, heldShares, research: rating?.createdAt,
        rating: rating?.rating, priceRule,
      })).digest('hex');
      if (!(await this.cadence.claimReview(userId, profile, ticker, quote.market, inputHash))) continue;
      try {
        let approval: { sessionId: string; reportId: string; candidate: CouncilCandidate } | undefined;
        let reviewed: string | null;
        if (profile.config.council?.enabled) {
          const candidate: CouncilCandidate = { ticker, side: signal.side, quantity: signal.quantity,
            price: Number(quote.price), reason: signal.reason };
          const review = await this.council.reviewCandidate(userId, profile, candidate);
          reviewed = review.approved && review.reportId ? review.reason : null;
          if (review.approved && review.reportId) approval = { sessionId: review.sessionId, reportId: review.reportId, candidate };
          await this.cadence.finishReview(userId, profile.id, ticker, reviewed ? 'approve' : 'wait', review.reason);
        } else {
          reviewed = await this.builder.reviewSignal(userId, profile.config, ticker,
            `${signal.side.toUpperCase()} ${signal.quantity}; ${signal.reason}`);
          await this.cadence.finishReview(userId, profile.id, ticker, reviewed ? 'approve' : 'wait', reviewed ?? 'Review declined');
        }
        if (!reviewed) continue;
        const reason = `${reviewed}. Public quote may be delayed; verify live broker price before any real action.`;
        result.signals.push({ ticker, side: signal.side, reason });
        const order = await this.placeOrder(userId, {
          ticker, side: signal.side, quantity: signal.quantity, orderType: 'market', reason,
        }, 'agent', undefined, true, true, profile, approval, undefined, account.id);
        if (order.status !== 'filled') {
          result.rejected += 1;
          continue;
        }
        result.placed += 1;
      } catch (error) {
        result.rejected += 1;
        await this.cadence.finishReview(userId, profile.id, ticker, 'failed', 'Review or order could not complete; no automatic retry today');
        this.logger.warn(`configured scan order failed for ${ticker}: ${error instanceof BadRequestException ? error.message : 'Review unavailable'}`);
      }
    }

    await this.recordEvent(userId, account.id, 'bot_scan', {
      profileId: profile.id,
      profileVersion: profile.version,
      scanned: result.scanned,
      signals: result.signals,
      placed: result.placed,
      rejected: result.rejected,
    });
    await this.ensureDailySnapshot(userId, account.id);
    return result;
  }

  /** Upsert today's equity snapshot (idempotent per account+date). */
  async ensureDailySnapshot(userId: string, accountId: string): Promise<void> {
    const today = paperRiskDay(new Date(), await paperRiskTimezone(this.db, userId, accountId));
    const [existing] = await this.db
      .select()
      .from(paperSnapshots)
      .where(and(eq(paperSnapshots.accountId, accountId), eq(paperSnapshots.snapshotDate, today)));
    const equityData = await this.equityOf(userId, { id: accountId } as PaperAccount);
    const [account] = await this.db.select().from(paperAccounts).where(and(eq(paperAccounts.id, accountId), eq(paperAccounts.owner, userId)));
    if (!account) throw new NotFoundException('Paper account not found');
    const cash = await this.cashValue(userId, account);
    const benchmarkEquity = await this.benchmarkValue(userId, accountId);
    const indexBenchmarkEquity = await this.indexBenchmarkValue(userId, accountId);
    const dayStart = await this.dayStartEquity(
      userId, accountId, account?.initialCash ?? '1000000',
    );

    if (existing) {
      await this.db
        .update(paperSnapshots)
        .set({
          equity: equityData.toString(),
          valuedAt: new Date(),
          cash: cash.toFixed(2), benchmarkEquity, indexBenchmarkEquity,
          positionsValue: (equityData - cash).toFixed(2),
          dailyPl: (equityData - dayStart).toFixed(2),
        })
        .where(eq(paperSnapshots.id, existing.id));
    } else {
      await this.db.insert(paperSnapshots).values({
        owner: userId,
        accountId,
        snapshotDate: today,
        equity: equityData.toFixed(2),
        valuedAt: new Date(),
        cash: cash.toFixed(2), benchmarkEquity, indexBenchmarkEquity,
        positionsValue: (equityData - cash).toFixed(2),
        dailyPl: (equityData - dayStart).toFixed(2),
      }).onConflictDoUpdate({ target: [paperSnapshots.accountId, paperSnapshots.snapshotDate], set: {
        valuedAt: new Date(),
        equity: equityData.toFixed(2), cash: cash.toFixed(2), benchmarkEquity, indexBenchmarkEquity,
        positionsValue: (equityData - cash).toFixed(2),
        dailyPl: sql`${equityData.toFixed(2)}::numeric - (${paperSnapshots.equity} - ${paperSnapshots.dailyPl})`,
      } });
    }
  }

  // ------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------

  /** Throw 404 unless the caller has a paper account. */
  private async requireAccount(userId: string) {
    return requireActivePaperAccount(this.db, userId);
  }

  /**
   * Resolve a tradeable price for a ticker. Fallback chain: live quote ->
   * the user's real holdings/watchlist stored price -> paper position avg
   * cost -> null.
   */
  private async resolvePrice(userId: string, rawTicker: string): Promise<ResolvedPrice | null> {
    const ticker = rawTicker.trim();
    try {
      const quote = await this.quoteService.getQuote(ticker);
      if (quote && Number.isFinite(Number(quote.price)) && Number(quote.price) > 0 && Number.isFinite(quote.timestamp)
        && Math.abs(Date.now() - quote.timestamp) <= 300_000) {
        return {
          price: Number(quote.price),
          market: quote.market,
          currency: quote.currency,
          company: quote.companyName ?? null,
          fxToUsd: await this.fxToUsd(quote.currency),
        };
      }
    } catch {
      // Leave the valuation unknown; historical costs are not current quotes.
    }


    return null;
  }

  /** Convert one unit of currency into USD; unavailable FX fails visibly. */
  private async fxToUsd(currency: 'USD' | 'HKD' | 'CNY'): Promise<number> {
    if (currency === 'USD') return 1;
    return this.fxService.convert(1, currency, 'USD');
  }

  private async cashValue(userId: string, account: { id: string; cashBalance?: string; ledgerMode?: string }): Promise<number> {
    if (account.ledgerMode !== 'native_currency') return Number(account.cashBalance ?? 0);
    const rows = await this.db.select().from(simulationCash).where(and(eq(simulationCash.accountId, account.id), eq(simulationCash.owner, userId)));
    let value = 0;
    for (const cash of rows) value += await this.fxService.convert(Number(cash.available) + Number(cash.frozen) + Number(cash.unsettled), cash.currency, 'USD');
    return value;
  }

  private async benchmarkValue(userId: string, accountId: string): Promise<string | null> {
    const [row] = await this.db.select().from(simulationSeeds).where(and(eq(simulationSeeds.accountId, accountId), eq(simulationSeeds.owner, userId)));
    if (!row) return null;
    let value = 0;
    try {
      for (const p of row.seed.positions) {
        const quote = await this.quoteService.getQuote(p.ticker);
        if (!quote || Number(quote.price) <= 0 || Math.abs(Date.now() - quote.timestamp) > 300_000) return null;
        value += await this.fxService.convert(Number(p.shares) * Number(quote.price), p.currency, 'USD');
      }
      for (const cash of row.seed.cash) value += await this.fxService.convert(Number(cash.total), cash.currency, 'USD');
      return value.toFixed(2);
    } catch { return null; }
  }

  private async indexBenchmarkValue(userId: string, accountId: string): Promise<string | null> {
    const [row] = await this.db.select().from(simulationSeeds).where(and(eq(simulationSeeds.accountId, accountId), eq(simulationSeeds.owner, userId)));
    const benchmark = row?.seed.benchmark;
    if (!benchmark?.initialPrice || !row.seed.initialEquityUsd) return null;
    try {
      const quote = await this.quoteService.getQuote(benchmark.ticker);
      if (!quote || quote.currency !== 'USD' || !Number.isFinite(Number(quote.price)) || Number(quote.price) <= 0
        || Math.abs(Date.now() - quote.timestamp) > 300_000) return null;
      return (Number(row.seed.initialEquityUsd) * Number(quote.price) / Number(benchmark.initialPrice)).toFixed(2);
    } catch { return null; }
  }

  /** Current equity: cash + market value of paper positions (USD). */
  private async equityOf(userId: string, account: { id: string; cashBalance?: string }): Promise<number> {
    const unresolved = await readCorporateActionGaps(this.db, userId, account.id);
    if (unresolved.length) throw new BadRequestException(`CORPORATE_ACTION_RECONCILIATION_REQUIRED:${unresolved.map(gap => gap.ticker).join(',')}`);
    const positions = await this.db
      .select()
      .from(paperPositions)
      .where(eq(paperPositions.accountId, account.id));
    const [acct] = await this.db.select().from(paperAccounts).where(and(eq(paperAccounts.id, account.id), eq(paperAccounts.owner, userId)));
    if (!acct) throw new NotFoundException('Paper account not found');
    const cash = await this.cashValue(userId, acct);
    let value = 0;
    for (const p of positions) {
      if (this.tradingMarket) {
        const data = await this.tradingMarket.getSnapshot(p.ticker);
        const actions = data.corporateActions?.filter((event) => Date.parse(event.occurredAt) >= p.openedAt.getTime()
          && Date.parse(event.occurredAt) <= Date.now()) ?? [];
        if (actions.length) {
          await this.db.transaction(async tx => {
            await lockMemoryOwner(tx, userId);
            await tx.select({ id: paperAccounts.id }).from(paperAccounts).where(eq(paperAccounts.id, acct.id)).for('update');
            await persistCorporateActionGaps(tx, userId, acct.id, p.ticker, actions);
          });
          throw new BadRequestException(`CORPORATE_ACTION_RECONCILIATION_REQUIRED:${p.ticker}`);
        }
      }
      const price = await this.resolvePrice(userId, p.ticker);
      if (price) value += Number(p.shares) * price.price * price.fxToUsd;
      else throw new BadRequestException(`VALUATION_UNAVAILABLE:${p.ticker}; missing quote or FX, increasing risk is blocked`);
    }
    return cash + value;
  }

  /** Day-start equity: prior closing snapshot, today's opening, or current equity. */
  private async dayStartEquity(userId: string, accountId: string, _initialCash: string): Promise<number> {
    const today = paperRiskDay(new Date(), await paperRiskTimezone(this.db, userId, accountId));
    const rows = await this.db
      .select()
      .from(paperSnapshots)
      .where(eq(paperSnapshots.accountId, accountId))
      .orderBy(desc(paperSnapshots.snapshotDate));
    const prev = rows.find((r) => r.snapshotDate < today);
    if (prev) return Number(prev.equity);
    // No prior snapshot: if today's exists use its opening (equity - dailyPl).
    const todayRow = rows.find((r) => r.snapshotDate === today);
    if (todayRow) return Number(todayRow.equity) - Number(todayRow.dailyPl);
    // Existing accounts may already have deposits and positions before their
    // first snapshot. Initial cash would make the loss breaker inaccurate.
    return this.equityOf(userId, { id: accountId });
  }

  /** Orders in the account's business-risk day, plus outstanding approvals. */
  private async todayOrders(userId: string, accountId: string) {
    const timezone = await paperRiskTimezone(this.db, userId, accountId);
    const today = paperRiskDay(new Date(), timezone);
    const rows = await this.db.select().from(paperOrders).where(and(eq(paperOrders.accountId, accountId),
      or(gte(paperOrders.createdAt, new Date(Date.now() - 48 * 3600_000)),
        gte(paperOrders.filledAt, new Date(Date.now() - 48 * 3600_000)), eq(paperOrders.status, 'pending_approval'))));
    return rows.filter((o) => o.status === 'pending_approval' || paperRiskDay(o.filledAt ?? o.createdAt, timezone) === today);
  }

  /** Whether the daily-loss circuit breaker is currently tripped. */
  private circuitBreakerHit(dayStart: number, equityNow: number, guardrails: PaperGuardrails): boolean {
    if (dayStart <= 0) return false;
    return (dayStart - equityNow) / dayStart >= guardrails.dailyLossLimitPct / 100;
  }

  /** Parse the guardrails JSON with defaults for missing keys. */
  private parseGuardrails(raw: unknown): PaperGuardrails {
    const g = (raw ?? {}) as Partial<PaperGuardrails>;
    return {
      dailyLossLimitPct: Number(g.dailyLossLimitPct) > 0 ? Number(g.dailyLossLimitPct) : DEFAULT_GUARDRAILS.dailyLossLimitPct,
      maxOrderPct: Number(g.maxOrderPct) > 0 ? Number(g.maxOrderPct) : DEFAULT_GUARDRAILS.maxOrderPct,
      maxOrdersPerDay: Number(g.maxOrdersPerDay) > 0 ? Number(g.maxOrdersPerDay) : DEFAULT_GUARDRAILS.maxOrdersPerDay,
    };
  }

  /** Append an event to the paper activity timeline. */
  private async recordEvent(
    userId: string,
    accountId: string,
    eventType: string,
    detail: Record<string, unknown>,
  ): Promise<void> {
    await this.db.insert(paperEvents).values({
      owner: userId,
      accountId,
      eventType,
      detail,
    });
  }

  private mapAccount(row: typeof paperAccounts.$inferSelect): PaperAccount {
    return {
      id: row.id,
      baseCurrency: row.baseCurrency,
      initialCash: String(row.initialCash),
      cashBalance: String(row.cashBalance),
      botEnabled: row.botEnabled,
      guardrails: this.parseGuardrails(row.guardrails),
      createdAt: row.createdAt.toISOString(),
    };
  }

  private mapPosition(row: typeof paperPositions.$inferSelect) {
    return {
      id: row.id,
      ticker: row.ticker,
      market: row.market as 'US' | 'HK' | 'CN',
      currency: row.currency as 'USD' | 'HKD' | 'CNY',
      company: row.company,
      shares: String(row.shares),
      avgCost: String(row.avgCost),
      openedAt: row.openedAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private mapOrder(row: typeof paperOrders.$inferSelect): PaperOrder {
    return {
      id: row.id,
      ticker: row.ticker,
      market: row.market as 'US' | 'HK' | 'CN',
      currency: row.currency as 'USD' | 'HKD' | 'CNY',
      company: row.company,
      side: row.side as PaperSide,
      orderType: row.orderType as 'market' | 'limit',
      quantity: String(row.quantity),
      limitPrice: row.limitPrice == null ? null : String(row.limitPrice),
      status: row.status as PaperOrder['status'],
      source: row.source as PaperOrderSource,
      reason: row.reason,
      strategyNote: row.strategyNote,
      riskCheck: (row.riskCheck as Record<string, unknown>) ?? null,
      filledPrice: row.filledPrice == null ? null : String(row.filledPrice),
      filledAt: row.filledAt == null ? null : row.filledAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
    };
  }
}
