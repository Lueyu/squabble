/**
 * @file server/modules/paper-trading/paper-trading.service.ts
 * @description AI paper-trading engine.
 *
 * The paper book is fully isolated from real records: dedicated tables,
 * dedicated cash ledger, no code path touches holdings/transactions. The
 * broker adapter is paper-only by construction — there is no real-broker
 * implementation to misconfigure.
 *
 * Legacy manual fills use the server-side public quote service, with a
 * fallback to stored portfolio prices. Builder fills require a recently
 * fetched quote and an available FX rate; free quotes may be delayed.
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
} from '@nestjs/common';
import { and, desc, eq, gte, or } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '../../common/platform';
import {
  holdings,
  agentRatings,
  agentRuns,
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
import { FxService } from '../fx/fx.service';
import { QuoteService } from '../quote/quote.service';
import { NotificationService, type NotificationPayload } from '../notifications/notification.service';
import { isMarketOpen } from '../../common/market-clock';
import { AgentBuilderService } from './agent-builder.service';
import { decideBuilderSignal } from './agent-builder.rules';
import { BuilderCadenceService } from './builder-cadence.service';
import { cadenceRejection, normalizeCadence } from './trading-cadence';
import { CouncilService } from '../council/council.service';
import { councilReports, councilSessions } from '../../database/council.schema';
import type { CouncilCandidate } from '@shared/council.interface';
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
const FX_FALLBACK_PER_USD: Record<string, number> = { USD: 1, HKD: 7.78, CNY: 7.1 };

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
}

type PaperTransaction = Parameters<Parameters<PostgresJsDatabase['transaction']>[0]>[0];

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
  ) {}

  /** Get (or lazily create) the caller's paper account. */
  async ensureAccount(userId: string): Promise<PaperAccount> {
    const rows = await this.db
      .select()
      .from(paperAccounts)
      .where(eq(paperAccounts.owner, userId));
    if (rows[0]) return this.mapAccount(rows[0]);
    const [created] = await this.db
      .insert(paperAccounts)
      .values({ owner: userId, guardrails: DEFAULT_GUARDRAILS })
      .returning();
    return this.mapAccount(created);
  }

  /** Reset the paper account: drop all paper data, start a fresh ledger. */
  async resetAccount(userId: string, initialCash?: number): Promise<PaperAccount> {
    if (initialCash !== undefined && (!Number.isFinite(initialCash) || initialCash <= 0)) {
      throw new BadRequestException('初始资金必须为正数');
    }
    const updated = await this.db.transaction(async (tx) => {
      const [account] = await tx.select().from(paperAccounts)
        .where(eq(paperAccounts.owner, userId)).for('update');
      if (!account) throw new NotFoundException('Paper account not found');

      // A reset stops the configured agent and keeps its real-action history.
      await tx.update(builderProfiles)
        .set({ status: 'paused', updatedAt: new Date() })
        .where(and(eq(builderProfiles.owner, userId), eq(builderProfiles.status, 'active')));
      // Paper orders are cleared below; proposals retain their reference
      // price, reason and self-reported execution without a dangling order ID.
      await tx.update(builderProposals)
        .set({ paperOrderId: null })
        .where(eq(builderProposals.owner, userId));
      await tx.update(councilReports).set({ paperOrderId: null }).where(eq(councilReports.owner, userId));
      await tx.delete(paperTrades).where(eq(paperTrades.accountId, account.id));
      await tx.delete(paperOrders).where(eq(paperOrders.accountId, account.id));
      await tx.delete(paperEvents).where(eq(paperEvents.accountId, account.id));
      await tx.delete(paperSnapshots).where(eq(paperSnapshots.accountId, account.id));
      await tx.delete(paperPositions).where(eq(paperPositions.accountId, account.id));
      const [reset] = await tx.update(paperAccounts)
        .set({
          initialCash: String(initialCash ?? 1_000_000),
          cashBalance: String(initialCash ?? 1_000_000),
          botEnabled: false,
          updatedAt: new Date(),
        })
        .where(eq(paperAccounts.id, account.id))
        .returning();
      await tx.insert(paperEvents).values({
        owner: userId,
        accountId: account.id,
        eventType: 'account_reset',
        detail: { initialCash: Number(reset.initialCash) },
      });
      return reset;
    });
    return this.mapAccount(updated);
  }

  /** Full overview for the paper page: account, positions, curve, feeds. */
  async getOverview(userId: string): Promise<PaperOverview> {
    const account = await this.requireAccount(userId);
    const positions = await this.db
      .select()
      .from(paperPositions)
      .where(eq(paperPositions.accountId, account.id));

    // Resolve prices (live with fallbacks) and market values in USD.
    const enriched = await Promise.all(
      positions.map(async (p) => {
        const price = await this.resolvePrice(userId, p.ticker);
        const shares = Number(p.shares);
        const avgCost = Number(p.avgCost);
        if (!price) {
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

    const positionsValue = enriched.reduce((sum, p) => sum + Number(p.marketValue ?? 0), 0);
    const cash = Number(account.cashBalance);
    const equity = cash + positionsValue;

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

    const dayStart = await this.dayStartEquity(userId, account.id, account.initialCash);
    const todayPl = equity - dayStart;
    const totalPl = equity - Number(account.initialCash);

    return {
      account: this.mapAccount(
        (await this.db.select().from(paperAccounts).where(eq(paperAccounts.id, account.id)))[0],
      ),
      positions: enriched,
      equity: equity.toFixed(2),
      positionsValue: positionsValue.toFixed(2),
      todayPl: todayPl.toFixed(2),
      totalPl: totalPl.toFixed(2),
      totalPlPct: ((totalPl / Number(account.initialCash)) * 100).toFixed(2),
      todayOrderCount: todayOrders.length,
      circuitBreakerActive: this.circuitBreakerHit(dayStart, equity, this.parseGuardrails(account.guardrails)),
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
  ): Promise<PaperOrder> {
    const initialAccount = await this.requireAccount(userId);
    if (dto.orderType && dto.orderType !== 'market') {
      throw new BadRequestException('V1 only supports market orders');
    }
    const quantity = Math.floor(Number(dto.quantity));
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new BadRequestException('Quantity must be a positive integer');
    }
    if (dto.side !== 'buy' && dto.side !== 'sell') {
      throw new BadRequestException('Side must be buy or sell');
    }

    let price: ResolvedPrice | null;
    let quoteTimestamp: number | null = null;
    if (strictQuote) {
      const quote = await this.quoteService.getQuote(dto.ticker);
      const fetchedRecently = quote && Number.isFinite(quote.timestamp)
        && Math.abs(Date.now() - quote.timestamp) <= 5 * 60 * 1000;
      if (!fetchedRecently || !quote || Number(quote.price) <= 0) {
        throw new BadRequestException(`无法获取 ${dto.ticker} 的近期报价，订单未执行`);
      }
      let fxToUsd: number;
      try {
        fxToUsd = await this.fxService.convert(1, quote.currency, 'USD');
      } catch {
        throw new BadRequestException(`无法获取 ${quote.currency} 的汇率，订单未执行`);
      }
      price = {
        price: Number(quote.price),
        market: quote.market,
        currency: quote.currency,
        company: quote.companyName ?? null,
        fxToUsd,
      };
      quoteTimestamp = quote.timestamp;
    } else {
      price = await this.resolvePrice(userId, dto.ticker);
    }
    if (!price) {
      throw new BadRequestException(`无法获取 ${dto.ticker} 的价格，订单未执行`);
    }
    // Fetch expensive portfolio valuations before taking the account row lock.
    // Solvency and order-count checks below use the locked, current ledger.
    const equityBeforeLock = await this.equityOf(userId, initialAccount);
    const dayStart = await this.dayStartEquity(
      userId, initialAccount.id, initialAccount.initialCash,
    );

    const committed = await this.db.transaction(async (tx) => {
      const [lockedAccount] = await tx.select().from(paperAccounts)
        .where(and(eq(paperAccounts.id, initialAccount.id), eq(paperAccounts.owner, userId)))
        .for('update');
      if (!lockedAccount) throw new NotFoundException('Paper account not found');
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
      if (builderProfile?.config.council?.enabled && !councilApproval) {
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
        || Math.abs(Date.now() - quoteTimestamp) > 5 * 60 * 1000)) {
        throw new BadRequestException(`无法获取 ${dto.ticker} 的近期报价，订单未执行`);
      }
      const account = lockedAccount;

      const notionalUsd = quantity * price.price * price.fxToUsd;
      const equity = equityBeforeLock;
      const utcDayStart = new Date();
      utcDayStart.setUTCHours(0, 0, 0, 0);
      const todayOrders = await tx.select().from(paperOrders)
        .where(and(eq(paperOrders.accountId, account.id), gte(paperOrders.createdAt, utcDayStart)));
      const todayBotCount = todayOrders.filter((o) => o.source === 'agent').length;
      const guardrails = this.parseGuardrails(account.guardrails);

      // ---- Risk gate (bot orders; manual orders skip caps but keep solvency) ----
      let rejection: string | undefined;
      let circuitBreaker = false;
      if (source === 'agent') {
        if (!isMarketOpen(price.market)) {
          rejection = `${dto.ticker} 所在市场当前未开盘`;
        } else if (this.circuitBreakerHit(dayStart, equity, guardrails)) {
          circuitBreaker = true;
          rejection = `日亏损熔断：当日权益回撤已超过 ${guardrails.dailyLossLimitPct}%，今日停止交易`;
        } else if (dto.side === 'buy' && notionalUsd > (equity * guardrails.maxOrderPct) / 100) {
          // The per-order cap constrains exposure on the way in; closing a
          // position must never be blocked by it.
          rejection = `单笔金额 ${(notionalUsd / equity * 100).toFixed(1)}% 超过上限 ${guardrails.maxOrderPct}%`;
        } else if (todayBotCount >= guardrails.maxOrdersPerDay) {
          rejection = `今日 bot 订单已达 ${guardrails.maxOrdersPerDay} 笔上限`;
        }
        const recentOrders = await tx.select().from(paperOrders).where(and(
          eq(paperOrders.accountId, account.id), or(gte(paperOrders.createdAt, new Date(Date.now() - 100 * 86400000)), eq(paperOrders.status, 'pending_approval')),
        ));
        const cadenceReason = cadenceRejection(normalizeCadence(builderProfile?.config.cadence), {
          ticker: dto.ticker, market: price.market, notionalUsd, equityUsd: equity,
          orders: recentOrders.map((order) => ({ ticker: order.ticker, market: order.market as Market,
            createdAt: order.createdAt, status: order.status,
            notionalUsd: Number((order.riskCheck as RiskCheck | null)?.notionalUsd ?? 0) })),
        });
        rejection ??= cadenceReason ?? undefined;
        const rule = builderProfile?.config.priceRules?.find((item) => item.ticker === dto.ticker.toUpperCase());
        if (dto.side === 'buy' && rule?.buyAtOrBelow !== undefined && price.price > rule.buyAtOrBelow) {
          rejection ??= 'Price is above the investor buy threshold';
        }
        const originalReason = councilApproval?.candidate.reason ?? dto.reason ?? '';
        if (dto.side === 'sell' && rule?.sellAtOrAbove !== undefined
          && originalReason.includes('Investor price rule:') && price.price < rule.sellAtOrAbove) {
          rejection ??= 'Price is below the investor sell threshold';
        }
      }

      // ---- Solvency checks (both sources) ----
      const cash = Number(account.cashBalance);
      const [existing] = await tx
        .select()
        .from(paperPositions)
        .where(and(eq(paperPositions.accountId, account.id), eq(paperPositions.ticker, price.market === 'US' ? dto.ticker.toUpperCase() : dto.ticker)));
      if (dto.side === 'buy' && notionalUsd > cash) {
        rejection = rejection ?? `现金不足：需 ${notionalUsd.toFixed(2)} USD，可用 ${cash.toFixed(2)} USD`;
      }
      if (dto.side === 'sell') {
        const held = existing ? Number(existing.shares) : 0;
        if (quantity > held) {
          rejection = rejection ?? `持仓不足：仅有 ${held} 股，无法卖出 ${quantity} 股`;
        }
      }

      const riskCheck: RiskCheck = {
        passed: !rejection,
        side: dto.side,
        notionalUsd: Number(notionalUsd.toFixed(2)),
        equityUsd: Number(equity.toFixed(2)),
        orderPct: equity > 0 ? Number(((notionalUsd / equity) * 100).toFixed(2)) : 0,
        todayOrderCount: todayBotCount,
        circuitBreaker,
        reason: rejection,
      };

      const ticker = price.market === 'US' ? dto.ticker.toUpperCase() : dto.ticker;
      // Determine the final status: agent orders in require_approval mode go
      // to pending_approval instead of filling immediately.
      const needsApproval =
        source === 'agent' && agentInfo?.approvalMode === 'require_approval';
      const finalStatus = rejection ? 'rejected_risk' : needsApproval ? 'pending_approval' : 'filled';

      const [order] = await tx
        .insert(paperOrders)
        .values({
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
          filledPrice: rejection || needsApproval ? null : String(price.price),
          filledAt: rejection || needsApproval ? null : new Date(),
          sessionId: agentInfo?.sessionId ?? null,
          agentName: agentInfo?.agentName ?? null,
        })
        .returning();

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
      let cashAfter = cash;
      let realizedPl: number | null = null;
      if (dto.side === 'buy') {
        cashAfter = cash - notionalUsd;
        const totalShares = (existing ? Number(existing.shares) : 0) + quantity;
        const totalCost = (existing ? Number(existing.shares) * Number(existing.avgCost) : 0) + quantity * price.price;
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
      } else {
        cashAfter = cash + notionalUsd;
        realizedPl = (price.price - Number(existing.avgCost)) * quantity;
        const remaining = Number(existing.shares) - quantity;
        if (remaining > 0) {
          await tx
            .update(paperPositions)
            .set({ shares: String(remaining), updatedAt: new Date() })
            .where(eq(paperPositions.id, existing.id));
        } else {
          await tx.delete(paperPositions).where(eq(paperPositions.id, existing.id));
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
        price: String(price.price),
        fee: '0',
        realizedPl: realizedPl === null ? null : realizedPl.toFixed(2),
        cashAfter: cashAfter.toFixed(2),
      });

      await tx.insert(paperEvents).values({
        owner: userId,
        accountId: account.id,
        eventType: 'order_filled',
        detail: {
          orderId: order.id, ticker, side: dto.side, quantity, price: price.price,
          source, notionalUsd: Number(notionalUsd.toFixed(2)),
          realizedPl: realizedPl === null ? undefined : Number(realizedPl.toFixed(2)),
        },
      });

      // The proposal is committed with the fill under the same account lock.
      // A second replica hitting the daily unique key rolls back its entire
      // paper order instead of leaving a duplicate fill without an inbox row.
      if (builderProfile) {
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
          referencePrice: String(price.price),
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
        body: `成交价 ${price.price}（${price.currency}），约 ${notionalUsd.toFixed(2)} USD`
          + (realizedPl !== null ? `，已实现盈亏 ${realizedPl >= 0 ? '+' : ''}${realizedPl.toFixed(2)} USD` : '')
          + (source === 'agent' ? '\n来源：AI 盯盘代理' : '\n来源：手动下单'),
      } as NotificationPayload };
    });
    if (committed.notification) {
      await this.notifications.notifyUser(userId, committed.notification);
    }
    if (builderProfile?.config.notifyOnProposal && committed.order.status === 'filled') {
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
    const [updated] = await this.db
      .update(paperAccounts)
      .set({ botEnabled: enabled, updatedAt: new Date() })
      .where(eq(paperAccounts.id, account.id))
      .returning();
    await this.recordEvent(userId, account.id, enabled ? 'bot_started' : 'bot_stopped', {});
    return this.mapAccount(updated);
  }

  /**
   * Approve a pending agent order: fill it at the current price.
   * Re-runs the solvency checks but skips the bot guardrails (the human
   * has already made the decision — that IS the guardrail).
   */
  async approveOrder(userId: string, orderId: string): Promise<PaperOrder> {
    await this.requireAccount(userId);
    const [order] = await this.db
      .select()
      .from(paperOrders)
      .where(and(eq(paperOrders.id, orderId), eq(paperOrders.owner, userId)));
    if (!order) throw new NotFoundException('订单不存在');
    if (order.status !== 'pending_approval') {
      throw new BadRequestException('Order is not in pending approval state');
    }

    const price = await this.resolvePrice(userId, order.ticker);
    if (!price) throw new BadRequestException(`无法获取 ${order.ticker} 的价格`);

    const quantity = Number(order.quantity);
    const notionalUsd = quantity * price.price * price.fxToUsd;
    const updated = await this.db.transaction(async (tx) => {
      const [account] = await tx.select().from(paperAccounts)
        .where(eq(paperAccounts.owner, userId)).for('update');
      if (!account) throw new NotFoundException('Paper account not found');
      const [pending] = await tx.select().from(paperOrders)
        .where(and(eq(paperOrders.id, orderId), eq(paperOrders.owner, userId)))
        .for('update');
      if (!pending || pending.status !== 'pending_approval') {
        throw new BadRequestException('Order is no longer pending approval');
      }
      // Human approval skips bot percentage caps, but the locked ledger must
      // still have sufficient cash or shares at the actual fill time.
      const cash = Number(account.cashBalance);
      if (pending.side === 'buy' && notionalUsd > cash) {
        throw new BadRequestException(`现金不足：需 ${notionalUsd.toFixed(2)} USD，可用 ${cash.toFixed(2)} USD`);
      }
      if (pending.side === 'sell') {
        const [position] = await tx.select().from(paperPositions)
          .where(and(eq(paperPositions.accountId, account.id), eq(paperPositions.ticker, pending.ticker)));
        if (!position || Number(position.shares) < quantity) {
          throw new BadRequestException('模拟盘持仓不足，无法审批卖单');
        }
      }
      await this.executeFill(
        tx, userId, account.id, pending.id, pending.ticker, price,
        pending.side as 'buy' | 'sell', quantity,
      );
      const [filled] = await tx.update(paperOrders)
        .set({ status: 'filled', filledPrice: String(price.price), filledAt: new Date() })
        .where(eq(paperOrders.id, orderId))
        .returning();
      await tx.insert(paperEvents).values({
        owner: userId,
        accountId: account.id,
        eventType: 'order_filled',
        detail: {
          orderId, ticker: pending.ticker, side: pending.side, quantity,
          price: price.price, approvedBy: 'user', agentName: pending.agentName,
          notionalUsd: Number(notionalUsd.toFixed(2)),
        },
      });
      return filled;
    });
    await this.notifications.notifyUser(userId, {
      event: 'order_filled',
      title: `审批通过：${order.ticker} ${order.side === 'buy' ? '买入' : '卖出'} ${quantity} 股`,
      body: `成交价 ${price.price}（约 ${notionalUsd.toFixed(2)} USD）`,
    });
    return this.mapOrder(updated);
  }

  /** Reject a pending agent order. */
  async rejectOrder(userId: string, orderId: string): Promise<PaperOrder> {
    const account = await this.requireAccount(userId);
    const [order] = await this.db
      .select()
      .from(paperOrders)
      .where(and(eq(paperOrders.id, orderId), eq(paperOrders.owner, userId)));
    if (!order) throw new NotFoundException('订单不存在');
    if (order.status !== 'pending_approval') {
      throw new BadRequestException('Order is not in pending approval state');
    }
    const [updated] = await this.db
      .update(paperOrders)
      .set({ status: 'cancelled', reason: '用户拒绝审批' })
      .where(and(eq(paperOrders.id, orderId), eq(paperOrders.owner, userId), eq(paperOrders.status, 'pending_approval')))
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

  /** Apply a human-approved paper fill inside the caller's transaction. */
  private async executeFill(
    tx: PaperTransaction,
    userId: string,
    accountId: string,
    orderId: string,
    ticker: string,
    price: ResolvedPrice,
    side: 'buy' | 'sell',
    quantity: number,
  ): Promise<void> {
    const [account] = await tx.select().from(paperAccounts).where(eq(paperAccounts.id, accountId));
    const cash = Number(account.cashBalance);
    const notionalUsd = quantity * price.price * price.fxToUsd;

    const [existing] = await tx
      .select()
      .from(paperPositions)
      .where(and(eq(paperPositions.accountId, accountId), eq(paperPositions.ticker, ticker)));

    let cashAfter = cash;
    let realizedPl: number | null = null;

    if (side === 'buy') {
      cashAfter = cash - notionalUsd;
      const totalShares = (existing ? Number(existing.shares) : 0) + quantity;
      const totalCost = (existing ? Number(existing.shares) * Number(existing.avgCost) : 0) + quantity * price.price;
      const avgCost = totalShares > 0 ? totalCost / totalShares : 0;
      if (existing) {
        await tx
          .update(paperPositions)
          .set({ shares: String(totalShares), avgCost: String(avgCost), updatedAt: new Date() })
          .where(eq(paperPositions.id, existing.id));
      } else {
        await tx.insert(paperPositions).values({
          owner: userId,
          accountId,
          ticker,
          market: price.market,
          currency: price.currency,
          company: price.company,
          shares: String(totalShares),
          avgCost: String(avgCost),
        });
      }
    } else {
      cashAfter = cash + notionalUsd;
      realizedPl = (price.price - Number(existing.avgCost)) * quantity;
      const remaining = Number(existing.shares) - quantity;
      if (remaining > 0) {
        await tx
          .update(paperPositions)
          .set({ shares: String(remaining), updatedAt: new Date() })
          .where(eq(paperPositions.id, existing.id));
      } else {
        await tx.delete(paperPositions).where(eq(paperPositions.id, existing.id));
      }
    }

    await tx
      .update(paperAccounts)
      .set({ cashBalance: cashAfter.toFixed(2), updatedAt: new Date() })
      .where(eq(paperAccounts.id, accountId));

    await tx.insert(paperTrades).values({
      owner: userId,
      accountId,
      orderId,
      ticker,
      market: price.market,
      side,
      quantity: String(quantity),
      price: String(price.price),
      fee: '0',
      realizedPl: realizedPl === null ? null : realizedPl.toFixed(2),
      cashAfter: cashAfter.toFixed(2),
    });
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
  async runBotScan(userId: string): Promise<{
    scanned: number;
    signals: Array<{ ticker: string; side: PaperSide; reason: string }>;
    placed: number;
    rejected: number;
  }> {
    const account = await this.requireAccount(userId);
    if (!account.botEnabled) {
      throw new BadRequestException('Bot is not enabled');
    }
    const activeProfile = await this.builder.getActiveProfile(userId);
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
          'agent',
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
        }, 'agent', undefined, true, true, profile, approval);
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
    const today = new Date().toISOString().slice(0, 10);
    const [existing] = await this.db
      .select()
      .from(paperSnapshots)
      .where(and(eq(paperSnapshots.accountId, accountId), eq(paperSnapshots.snapshotDate, today)));
    const equityData = await this.equityOf(userId, { id: accountId } as PaperAccount);
    const [account] = await this.db.select().from(paperAccounts).where(eq(paperAccounts.id, accountId));
    const dayStart = await this.dayStartEquity(
      userId, accountId, account?.initialCash ?? '1000000',
    );

    if (existing) {
      await this.db
        .update(paperSnapshots)
        .set({
          equity: equityData.toString(),
          cash: String(Number(account?.cashBalance ?? 0)),
          positionsValue: (equityData - Number(account?.cashBalance ?? 0)).toFixed(2),
          dailyPl: (equityData - dayStart).toFixed(2),
        })
        .where(eq(paperSnapshots.id, existing.id));
    } else {
      await this.db.insert(paperSnapshots).values({
        owner: userId,
        accountId,
        snapshotDate: today,
        equity: equityData.toFixed(2),
        cash: Number(account?.cashBalance ?? 0).toFixed(2),
        positionsValue: (equityData - Number(account?.cashBalance ?? 0)).toFixed(2),
        dailyPl: (equityData - dayStart).toFixed(2),
      });
    }
  }

  // ------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------

  /** Throw 404 unless the caller has a paper account. */
  private async requireAccount(userId: string) {
    const rows = await this.db.select().from(paperAccounts).where(eq(paperAccounts.owner, userId));
    if (!rows[0]) throw new NotFoundException('Paper account not found');
    return rows[0];
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
      if (quote && Number(quote.price) > 0) {
        return {
          price: Number(quote.price),
          market: quote.market,
          currency: quote.currency,
          company: quote.companyName ?? null,
          fxToUsd: await this.fxToUsd(quote.currency),
        };
      }
    } catch {
      // fall through to stored prices
    }

    const [h] = await this.db.select().from(holdings).where(and(eq(holdings.owner, userId), eq(holdings.ticker, ticker)));
    if (h && h.currentPrice != null && Number(h.currentPrice) > 0) {
      return {
        price: Number(h.currentPrice),
        market: (h.market as 'US' | 'HK' | 'CN') ?? 'US',
        currency: (h.currency as 'USD' | 'HKD' | 'CNY') ?? 'USD',
        company: h.company ?? null,
        fxToUsd: await this.fxToUsd((h.currency as 'USD' | 'HKD' | 'CNY') ?? 'USD'),
      };
    }
    const [w] = await this.db.select().from(watchlist).where(and(eq(watchlist.owner, userId), eq(watchlist.ticker, ticker)));
    if (w && w.currentPrice != null && Number(w.currentPrice) > 0) {
      return {
        price: Number(w.currentPrice),
        market: (w.market as 'US' | 'HK' | 'CN') ?? 'US',
        currency: (w.currency as 'USD' | 'HKD' | 'CNY') ?? 'USD',
        company: w.company ?? null,
        fxToUsd: await this.fxToUsd((w.currency as 'USD' | 'HKD' | 'CNY') ?? 'USD'),
      };
    }
    return null;
  }

  /** Convert one unit of `currency` into USD (FX service with static fallback). */
  private async fxToUsd(currency: 'USD' | 'HKD' | 'CNY'): Promise<number> {
    if (currency === 'USD') return 1;
    try {
      return await this.fxService.convert(1, currency, 'USD');
    } catch {
      return 1 / (FX_FALLBACK_PER_USD[currency] ?? 1);
    }
  }

  /** Current equity: cash + market value of paper positions (USD). */
  private async equityOf(userId: string, account: { id: string; cashBalance?: string }): Promise<number> {
    const positions = await this.db
      .select()
      .from(paperPositions)
      .where(eq(paperPositions.accountId, account.id));
    const [acct] = await this.db.select().from(paperAccounts).where(eq(paperAccounts.id, account.id));
    const cash = Number(acct?.cashBalance ?? account.cashBalance ?? 0);
    let value = 0;
    for (const p of positions) {
      const price = await this.resolvePrice(userId, p.ticker);
      if (price) value += Number(p.shares) * price.price * price.fxToUsd;
      else value += Number(p.shares) * Number(p.avgCost) * (await this.fxToUsd(p.currency as 'USD' | 'HKD' | 'CNY'));
    }
    return cash + value;
  }

  /** Day-start equity: prior closing snapshot, today's opening, or current equity. */
  private async dayStartEquity(userId: string, accountId: string, _initialCash: string): Promise<number> {
    const today = new Date().toISOString().slice(0, 10);
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

  /** Today's orders (UTC day) for an account. */
  private async todayOrders(userId: string, accountId: string) {
    const dayStart = new Date();
    dayStart.setUTCHours(0, 0, 0, 0);
    return this.db
      .select()
      .from(paperOrders)
      .where(and(eq(paperOrders.accountId, accountId), gte(paperOrders.createdAt, dayStart)));
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
