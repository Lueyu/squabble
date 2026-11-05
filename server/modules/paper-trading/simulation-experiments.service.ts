import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { and, desc, eq, gt, gte, inArray, isNotNull, lt, lte, sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '../../common/platform';
import { builderProfiles, cashAccounts, fxRates, holdings, paperAccounts, paperEvents, paperOrders, paperPositions,
  paperSnapshots, paperTrades } from '../../database/schema';
import { simulationCash, simulationPreviews, simulationSeeds } from '../../database/simulation-experiments.schema';
import { strategySignals } from '../../database/strategy.schema';
import { strategyMandates, strategyReservations } from '../../database/strategy-mandates.schema';
import { QuoteService } from '../quote/quote.service';
import { FxService } from '../fx/fx.service';
import { ResearchDocumentsService } from '../research-documents/research-documents.service';
import { lockMemoryOwner } from '../research-memory/research-memory.fence';
import { assertLegacyInvestmentWrite } from './investment-policy.fence';
import { readCorporateActionGaps } from './simulation-corporate-actions';
import { paperRiskDay } from './paper-risk-day';
import { adjacentSimulationDate, observedDrawdown, simulationDayStart } from './simulation-review.rules';
import { TradingMarketService } from './trading-market.service';
import { usableValuationQuote } from './strategy-portfolio-risk';
import { buildOpeningSeed, executionEconomics, seedRevision, sourceLedgerRevision, validateCashTransfer } from './simulation-experiments.rules';
import type { CreateSimulationExperiment, SimulationCash, SimulationExperiment, SimulationPreview,
  SimulationReview, SimulationSeed } from '../../../shared/simulation-experiment.interface';

type Tx = Parameters<Parameters<PostgresJsDatabase['transaction']>[0]>[0];
@Injectable()
export class SimulationExperimentsService {
  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    _quotes: QuoteService, private readonly fx: FxService,
    @Optional() private readonly documents?: ResearchDocumentsService,
    @Optional() private readonly tradingMarket?: TradingMarketService) {}

  private async source(owner: string, db: PostgresJsDatabase | Tx = this.db) {
    const [positions, cash] = await Promise.all([
      db.select().from(holdings).where(eq(holdings.owner, owner)),
      db.select().from(cashAccounts).where(eq(cashAccounts.owner, owner)),
    ]);
    return { holdings: positions.map((h) => ({ id: h.id, ticker: h.ticker, market: h.market, currency: h.currency,
      company: h.company, shares: String(h.shares), buyPrice: h.buyPrice, currentPrice: h.currentPrice, updatedAt: h.updatedAt })),
    cash: cash.map((c) => ({ currency: c.currency, balance: String(c.balance), updatedAt: c.updatedAt })) };
  }

  async preview(owner: string): Promise<SimulationPreview> {
    const source = await this.source(owner);
    const quotes: Array<{ ticker: string; price: string; at: string }> = [];
    for (const holding of source.holdings) {
      try {
        const quote = await this.tradingMarket?.getSnapshot(holding.ticker);
        if (usableValuationQuote(quote, new Date())
          && quote.currency === holding.currency && quote.market === holding.market) {
          quotes.push({ ticker: holding.ticker, price: String(quote.price), at: quote.quoteTimestamp! });
        }
      } catch { /* Missing data remains a blocking preview gap. */ }
    }
    const currencies = new Set([...source.holdings.map((h) => h.currency ?? ''), ...source.cash.map((c) => c.currency)]);
    const fx: SimulationSeed['fx'] = [];
    for (const currency of currencies) {
      if (currency === 'USD') { fx.push({ currency, rate: '1', at: new Date().toISOString() }); continue; }
      try {
        const rate = await this.fx.convert(1, currency, 'USD');
        const [dated] = await this.db.select().from(fxRates).where(sql`(${fxRates.base} = ${currency} AND ${fxRates.quote} = 'USD') OR (${fxRates.base} = 'USD' AND ${fxRates.quote} = ${currency})`)
          .orderBy(desc(fxRates.rateDate)).limit(1);
        if (dated && Number.isFinite(rate) && rate > 0) fx.push({ currency, rate: String(rate), at: String(dated.rateDate) });
      } catch { /* No static FX substitutions. */ }
    }
    const seed = buildOpeningSeed(source, quotes, fx, new Date().toISOString());
    seed.benchmarkOptions = [];
    for (const ticker of ['SPY', 'QQQ'] as const) {
      let initialPrice: string | null = null;
      let quoteAt: string | null = null;
      try {
        const quote = await this.tradingMarket?.getSnapshot(ticker);
        if (usableValuationQuote(quote, new Date()) && quote.currency === 'USD') {
          initialPrice = String(quote.price); quoteAt = quote.quoteTimestamp;
        }
      } catch { /* An unavailable selected benchmark remains explicitly unknown. */ }
      seed.benchmarkOptions.push({ ticker, currency: 'USD', initialPrice, quoteAt });
    }
    const expiresAt = new Date(Date.now() + 5 * 60_000);
    const [preview] = await this.db.insert(simulationPreviews).values({ owner, seed, expiresAt }).returning();
    return { id: preview.id, expiresAt: expiresAt.toISOString(), seed };
  }

  /** Explicit simulated cash does not depend on the real account owning this currency. */
  async previewCash(_owner: string, currency: 'USD' | 'HKD' | 'CNY', amount: number): Promise<SimulationSeed> {
    const capturedAt = new Date().toISOString();
    const fx: SimulationSeed['fx'] = currency === 'USD' ? [{ currency, rate: '1', at: capturedAt }] : [];
    if (currency !== 'USD') {
      try {
        const rate = await this.fx.convert(1, currency, 'USD');
        const [dated] = await this.db.select().from(fxRates).where(sql`(${fxRates.base} = ${currency} AND ${fxRates.quote} = 'USD') OR (${fxRates.base} = 'USD' AND ${fxRates.quote} = ${currency})`).orderBy(desc(fxRates.rateDate)).limit(1);
        if (dated && Number.isFinite(rate) && rate > 0) fx.push({ currency, rate: String(rate), at: String(dated.rateDate) });
      } catch { /* A missing dated FX observation remains a visible blocker. */ }
    }
    return { sourceRevision: createHash('sha256').update(JSON.stringify({ currency, amount })).digest('hex'), capturedAt, positions: [],
      cash: [{ currency, total: String(amount), available: String(amount), frozen: '0', unsettled: '0', availabilityKnown: true }],
      fx, initialEquityUsd: fx.length ? String(amount * Number(fx[0].rate)) : null, gaps: fx.length ? [] : [`FX_MISSING:${currency}`],
      model: { version: 'paper-v1', feeBps: 5, slippageBps: 10, corporateActions: 'unsupported' } };
  }

  async create(owner: string, request: CreateSimulationExperiment): Promise<SimulationExperiment> {
    if (!request || !request.name?.trim() || request.name.length > 120 || !/^[\w-]{8,128}$/.test(request.idempotencyKey ?? '')
      || !/^[0-9a-f-]{36}$/i.test(request.previewId ?? '')) throw new BadRequestException('Valid preview, name and idempotency key required');
    const requestHash = createHash('sha256').update(JSON.stringify(request)).digest('hex');
    const accountId = await this.db.transaction(async (tx) => {
      await lockMemoryOwner(tx, owner);
      await assertLegacyInvestmentWrite(tx, owner);
      const [prior] = await tx.select().from(simulationSeeds).where(and(eq(simulationSeeds.owner, owner), eq(simulationSeeds.idempotencyKey, request.idempotencyKey)));
      if (prior) {
        if (prior.requestHash !== requestHash) throw new ConflictException('Idempotency key already used for a different request');
        return prior.accountId;
      }
      const [preview] = await tx.select().from(simulationPreviews).where(and(eq(simulationPreviews.id, request.previewId), eq(simulationPreviews.owner, owner))).for('update');
      if (!preview) throw new NotFoundException('Preview not found');
      if (preview.expiresAt.getTime() < Date.now()) throw new ConflictException('Preview expired; refresh the real-account snapshot');
      const [used] = await tx.select().from(simulationSeeds).where(eq(simulationSeeds.previewId, preview.id));
      if (used) throw new ConflictException('Preview already created an experiment');
      if (seedRevision(await this.source(owner, tx)) !== preview.seed.sourceRevision) throw new ConflictException('Real account changed; refresh the preview');
      const seed = structuredClone(preview.seed);
      const feeBps = request.feeBps ?? seed.model.feeBps;
      const slippageBps = request.slippageBps ?? seed.model.slippageBps;
      try { executionEconomics(100, 1, 'buy', feeBps, slippageBps); }
      catch { throw new BadRequestException('Execution model requires finite basis points from 0 to 100'); }
      seed.model = { ...seed.model, feeBps, slippageBps };
      if (request.benchmarkTicker != null && !['SPY', 'QQQ'].includes(request.benchmarkTicker)) throw new BadRequestException('Unsupported index benchmark');
      seed.benchmark = seed.benchmarkOptions?.find((b) => b.ticker === request.benchmarkTicker) ?? null;
      if (seed.benchmark && !seed.benchmark.initialPrice) seed.gaps.push(`INDEX_BENCHMARK_QUOTE_MISSING:${seed.benchmark.ticker}`);
      if (seed.gaps.includes('CASH_UNKNOWN')) {
        if (request.confirmNoCash !== true) throw new BadRequestException('Cash is unknown; explicitly confirm zero opening cash or update the real account');
        seed.gaps = seed.gaps.filter((g) => g !== 'CASH_UNKNOWN');
        seed.gaps.push('OPENING_ZERO_CASH_CONFIRMED_BY_USER');
      }
      if (seed.initialEquityUsd === null || Number(seed.initialEquityUsd) <= 0) throw new BadRequestException('Starting valuation requires valid quotes, FX and positive equity');
      if (seed.gaps.length && request.acknowledgeGaps !== true) throw new BadRequestException('Acknowledge the visible data gaps before creating');
      for (const cash of seed.cash) {
        const confirmed = request.cashAvailable?.[cash.currency];
        if (confirmed !== undefined) {
          const amount = Number(confirmed);
          if (!Number.isFinite(amount) || amount < 0 || amount > Number(cash.total)) throw new BadRequestException('Invalid available cash confirmation');
          cash.available = String(amount); cash.frozen = String(Number(cash.total) - amount); cash.availabilityKnown = true;
          seed.gaps = seed.gaps.filter((g) => g !== `CASH_AVAILABILITY_UNKNOWN:${cash.currency}`);
        }
      }
      for (const position of seed.positions) {
        const confirmed = request.sellableShares?.[position.ticker];
        if (confirmed !== undefined) {
          const amount = Number(confirmed);
          if (!Number.isFinite(amount) || amount < 0 || amount > Number(position.shares)) throw new BadRequestException('Invalid sellability confirmation');
          position.sellableShares = String(amount); position.restriction = 'User-confirmed opening sellability; market settlement still applies';
          seed.gaps = seed.gaps.filter((g) => g !== `SELLABILITY_UNKNOWN:${position.ticker}`);
        }
      }
      await this.stopAndDeselect(tx, owner);
      const cashValue = seed.cash.reduce((sum, c) => sum + Number(c.total) * Number(seed.fx.find((f) => f.currency === c.currency)?.rate ?? 0), 0);
      const [account] = await tx.insert(paperAccounts).values({ owner, name: request.name.trim(), isActive: true,
        ledgerMode: 'native_currency', executionModel: seed.model, initialCash: seed.initialEquityUsd, cashBalance: cashValue.toFixed(2), botEnabled: false }).returning();
      await tx.insert(simulationSeeds).values({ accountId: account.id, owner, previewId: preview.id,
        idempotencyKey: request.idempotencyKey, requestHash, seed });
      if (seed.cash.length) await tx.insert(simulationCash).values(seed.cash.map((c) => ({ accountId: account.id, owner,
        currency: c.currency, available: c.available, frozen: c.frozen, unsettled: c.unsettled, availabilityKnown: c.availabilityKnown })));
      if (seed.positions.length) await tx.insert(paperPositions).values(seed.positions.map((p) => ({ accountId: account.id, owner,
        ticker: p.ticker, company: p.company, market: p.market, currency: p.currency, shares: p.shares,
        avgCost: p.initialPrice!, restrictedShares: String(Number(p.shares) - Number(p.sellableShares ?? 0)) })));
      await tx.insert(paperSnapshots).values({ owner, accountId: account.id, snapshotDate: seed.capturedAt.slice(0, 10),
        valuedAt: new Date(seed.capturedAt),
        equity: seed.initialEquityUsd, benchmarkEquity: seed.initialEquityUsd,
        indexBenchmarkEquity: seed.benchmark?.initialPrice ? seed.initialEquityUsd : null,
        cash: cashValue.toFixed(2), positionsValue: (Number(seed.initialEquityUsd) - cashValue).toFixed(2), dailyPl: '0' });
      await tx.insert(paperEvents).values({ owner, accountId: account.id, eventType: 'opening_balance', detail: {
        previewId: preview.id, sourceRevision: seed.sourceRevision, initialEquityUsd: seed.initialEquityUsd, model: seed.model, gaps: seed.gaps } });
      return account.id;
    });
    return this.get(owner, accountId);
  }

  private async stopAndDeselect(tx: Tx, owner: string) {
    await tx.update(strategyReservations).set({ status: 'released', reason: 'Paper account switched', updatedAt: new Date() })
      .where(and(eq(strategyReservations.owner, owner), eq(strategyReservations.status, 'active')));
    await tx.update(paperAccounts).set({ isActive: false, botEnabled: false, updatedAt: new Date() }).where(eq(paperAccounts.owner, owner));
    await tx.update(builderProfiles).set({ status: 'paused', version: sql`${builderProfiles.version} + 1`, updatedAt: new Date() })
      .where(and(eq(builderProfiles.owner, owner), eq(builderProfiles.status, 'active')));
    await tx.update(strategySignals).set({ state: 'blocked', reason: 'Paper account switched; candidate invalidated', updatedAt: new Date() })
      .where(and(eq(strategySignals.owner, owner), sql`${strategySignals.state} IN ('claimed', 'pending', 'reviewing', 'approved')`));
    await tx.update(paperOrders).set({ status: 'cancelled', reason: 'Paper account switched' })
      .where(and(eq(paperOrders.owner, owner), eq(paperOrders.status, 'pending_approval')));
  }
  async select(owner: string, accountId: string): Promise<SimulationExperiment> {
    await this.db.transaction(async (tx) => {
      await lockMemoryOwner(tx, owner);
      await assertLegacyInvestmentWrite(tx, owner);
      const [account] = await tx.select().from(paperAccounts).where(and(eq(paperAccounts.owner, owner), eq(paperAccounts.id, accountId))).for('update');
      if (!account) throw new NotFoundException('Experiment not found');
      if (account.isActive) return;
      await this.stopAndDeselect(tx, owner);
      await tx.update(paperAccounts).set({ isActive: true }).where(eq(paperAccounts.id, account.id));
    });
    return this.get(owner, accountId);
  }
  async list(owner: string): Promise<SimulationExperiment[]> {
    const rows = await this.db.select().from(paperAccounts).where(eq(paperAccounts.owner, owner)).orderBy(desc(paperAccounts.createdAt));
    if (!rows.length) return [];
    const currentSourceRevision = sourceLedgerRevision(await this.source(owner));
    return Promise.all(rows.map((r) => this.get(owner, r.id, currentSourceRevision)));
  }
  async get(owner: string, accountId: string, currentSourceRevision?: string | null): Promise<SimulationExperiment> {
    const [account] = await this.db.select().from(paperAccounts).where(and(eq(paperAccounts.owner, owner), eq(paperAccounts.id, accountId)));
    if (!account) throw new NotFoundException('Experiment not found');
    const [seed] = await this.db.select().from(simulationSeeds).where(and(eq(simulationSeeds.owner, owner), eq(simulationSeeds.accountId, accountId)));
    const cash = await this.db.select().from(simulationCash).where(and(eq(simulationCash.owner, owner), eq(simulationCash.accountId, accountId)));
    const openingRevision = seed ? sourceLedgerRevision(seed.seed) : null;
    const currentRevision = openingRevision && currentSourceRevision === undefined
      ? sourceLedgerRevision(await this.source(owner)) : currentSourceRevision;
    return { id: account.id, name: account.name, active: account.isActive, initialEquityUsd: account.initialCash,
      createdAt: account.createdAt.toISOString(), seed: seed?.seed ?? null,
      sourceChanged: openingRevision && currentRevision ? openingRevision !== currentRevision : null,
      executionModel: account.executionModel,
      cash: cash.map((c): SimulationCash => ({ currency: c.currency, available: c.available, frozen: c.frozen,
        unsettled: c.unsettled, total: String(Number(c.available) + Number(c.frozen) + Number(c.unsettled)), availabilityKnown: c.availabilityKnown })) };
  }
  async exchange(owner: string, accountId: string, request: { from: string; to: string; amount: number }) {
    if (!['USD', 'HKD', 'CNY'].includes(request.from) || !['USD', 'HKD', 'CNY'].includes(request.to)) throw new BadRequestException('Unsupported currency');
    const rate = await this.fx.convert(1, request.from, request.to);
    await this.db.transaction(async (tx) => {
      await lockMemoryOwner(tx, owner);
      const [account] = await tx.select().from(paperAccounts).where(and(eq(paperAccounts.owner, owner), eq(paperAccounts.id, accountId), eq(paperAccounts.isActive, true))).for('update');
      if (!account || account.ledgerMode !== 'native_currency') throw new BadRequestException('Select a seeded experiment first');
      const [cash] = await tx.select().from(simulationCash).where(and(eq(simulationCash.accountId, accountId), eq(simulationCash.currency, request.from))).for('update');
      const reservations = await tx.select().from(strategyReservations).where(and(eq(strategyReservations.owner, owner),
        eq(strategyReservations.accountId, accountId), eq(strategyReservations.currency, request.from), eq(strategyReservations.side, 'buy'),
        eq(strategyReservations.status, 'active'), gt(strategyReservations.expiresAt, new Date())));
      const reserved = reservations.reduce((sum, reservation) => sum + Number(reservation.cash), 0);
      let received: string;
      try { received = validateCashTransfer(request.from, request.to, Number(request.amount), Math.max(0, Number(cash?.available ?? 0) - reserved), rate); }
      catch (error) { throw new BadRequestException(error instanceof Error ? error.message : 'Invalid FX transfer'); }
      await tx.update(simulationCash).set({ available: String(Number(cash.available) - Number(request.amount)) }).where(eq(simulationCash.id, cash.id));
      await tx.insert(simulationCash).values({ owner, accountId, currency: request.to, available: received, availabilityKnown: true })
        .onConflictDoUpdate({ target: [simulationCash.accountId, simulationCash.currency], set: { available: sql`${simulationCash.available} + ${received}`, availabilityKnown: true } });
      await tx.insert(paperEvents).values({ owner, accountId, eventType: 'fx_exchange', detail: { ...request, rate, received,
        quotedAt: new Date().toISOString(), modelVersion: 'paper-v1' } });
    });
    return this.get(owner, accountId);
  }

  async review(owner: string, accountId: string, from?: string, to?: string): Promise<SimulationReview> {
    const experiment = await this.get(owner, accountId);
    const now = new Date();
    const mandates = await this.db.select().from(strategyMandates).where(and(eq(strategyMandates.owner, owner),
      eq(strategyMandates.accountId, accountId), isNotNull(strategyMandates.publishedAt))).orderBy(desc(strategyMandates.publishedAt));
    const timezone = mandates.find(mandate => mandate.status === 'published')?.config.timezone ?? mandates[0]?.config.timezone ?? 'UTC';
    const openingAt = new Date(experiment.seed?.capturedAt ?? experiment.createdAt);
    const openingDay = paperRiskDay(openingAt, timezone);
    const start = from ?? openingDay;
    const end = to ?? paperRiskDay(now, timezone);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || start > end) throw new BadRequestException('Invalid review date range');
    let periodStart: Date; let periodEnd: Date;
    try { periodStart = simulationDayStart(start, timezone); periodEnd = simulationDayStart(adjacentSimulationDate(end, 1), timezone); }
    catch { throw new BadRequestException('Invalid review calendar date'); }
    const amount = (value: unknown): number | null => value !== null && value !== undefined
      && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;
    // Include a possible exact midnight valuation on the next date for version attribution only.
    const allSnapshots = (await this.db.select().from(paperSnapshots).where(and(eq(paperSnapshots.owner, owner),
      eq(paperSnapshots.accountId, accountId), lte(paperSnapshots.snapshotDate, adjacentSimulationDate(end, 1))))
      .orderBy(desc(paperSnapshots.snapshotDate)))
      .filter(snapshot => (!snapshot.valuedAt || snapshot.valuedAt <= now) && snapshot.snapshotDate <= paperRiskDay(now, timezone));
    const snapshots = allSnapshots.filter(snapshot => snapshot.snapshotDate <= end);
    const prior = snapshots.find(snapshot => snapshot.snapshotDate === adjacentSimulationDate(start, -1));
    const fromOpening = start <= openingDay;
    const baseline = fromOpening ? amount(experiment.initialEquityUsd) : amount(prior?.equity);
    const ending = snapshots.find(snapshot => snapshot.snapshotDate === end);
    const latestObserved = snapshots.find(snapshot => snapshot.snapshotDate >= start);
    const trades = await this.db.select().from(paperTrades).where(and(eq(paperTrades.owner, owner), eq(paperTrades.accountId, accountId),
      gte(paperTrades.createdAt, periodStart), lt(paperTrades.createdAt, periodEnd), lte(paperTrades.createdAt, now)));
    const gaps = [...(experiment.seed?.gaps ?? ['LEGACY_SEED_UNKNOWN'])];
    const actionGaps = (await readCorporateActionGaps(this.db, owner, accountId))
      .filter(gap => Date.parse(gap.occurredAt) <= now.getTime() && paperRiskDay(new Date(gap.occurredAt), timezone) <= end);
    gaps.push(...actionGaps.map(gap => `CORPORATE_ACTION_RECONCILIATION_REQUIRED:${gap.ticker}:${gap.kind}:${gap.occurredAt}`));
    if (baseline === null) gaps.push('PERIOD_START_SNAPSHOT_MISSING');
    const buyAndHold = actionGaps.length ? null : amount(ending?.benchmarkEquity);
    const benchmarkStart = fromOpening ? amount(experiment.seed?.initialEquityUsd) : amount(prior?.benchmarkEquity);
    const indexBenchmark = amount(ending?.indexBenchmarkEquity);
    const indexStart = fromOpening ? amount(experiment.seed?.initialEquityUsd) : amount(prior?.indexBenchmarkEquity);
    if (experiment.seed?.benchmark && (indexBenchmark === null || !indexStart)) gaps.push('INDEX_BENCHMARK_VALUATION_UNAVAILABLE');
    if (buyAndHold === null || !benchmarkStart) gaps.push('BENCHMARK_VALUATION_UNAVAILABLE');
    const equity = actionGaps.length ? null : amount(ending?.equity);
    if (!ending || amount(ending.equity) === null) gaps.push('PERIOD_END_SNAPSHOT_MISSING');
    const profit = equity === null || baseline === null ? null : equity - baseline;
    const samples = [...(baseline === null ? [] : [baseline]), ...snapshots.filter(snapshot => snapshot.snapshotDate >= start)
      .slice().reverse().map(snapshot => amount(snapshot.equity)).filter((value): value is number => value !== null)];
    const drawdown = actionGaps.length ? null : observedDrawdown(samples);
    const signals = trades.length ? await this.db.select({ orderId: strategySignals.orderId, candidate: strategySignals.candidate })
      .from(strategySignals).where(and(eq(strategySignals.owner, owner), inArray(strategySignals.orderId, trades.map(trade => trade.orderId)))) : [];
    const authorizedVersionByOrder = new Map(signals.filter(signal => !signal.candidate.accountId || signal.candidate.accountId === accountId)
      .map(signal => [signal.orderId, signal.candidate.mandateId]));
    const exactNav = (instant: number): number | null => {
      if (instant > now.getTime()) return null;
      if (instant === openingAt.getTime()) return amount(experiment.initialEquityUsd);
      return amount(allSnapshots.find(snapshot => snapshot.valuedAt?.getTime() === instant)?.equity);
    };
    const chronological = mandates.slice().reverse();
    const strategyContributions: SimulationReview['strategyContributions'] = [];
    for (const [index, mandate] of chronological.entries()) {
      const effective = Math.max(mandate.publishedAt!.getTime(), Date.parse(mandate.config.startsAt));
      const nextPublication = chronological[index + 1]?.publishedAt?.getTime() ?? Infinity;
      const stopped = mandate.status === 'published' ? Infinity : mandate.updatedAt.getTime();
      const until = Math.min(Date.parse(mandate.config.endsAt), stopped, nextPublication);
      const intervalStart = Math.max(periodStart.getTime(), effective);
      const intervalEnd = Math.min(periodEnd.getTime(), until);
      const attributed = trades.filter(trade => authorizedVersionByOrder.get(trade.orderId) === mandate.id);
      if (intervalEnd <= intervalStart && !attributed.length) continue;
      const versionGaps: string[] = [];
      let beginning = intervalEnd > intervalStart ? exactNav(intervalStart) : null;
      let closing = intervalEnd > intervalStart ? exactNav(intervalEnd) : null;
      if (beginning === null || closing === null) versionGaps.push('STRATEGY_BOUNDARY_VALUATION_MISSING');
      if (actionGaps.some(gap => Date.parse(gap.occurredAt) <= intervalEnd)) {
        versionGaps.push('CORPORATE_ACTION_RECONCILIATION_REQUIRED'); beginning = closing = null;
      }
      const movement = beginning !== null && closing !== null ? closing - beginning : null;
      strategyContributions.push({ mandateId: mandate.id, title: mandate.config.title, version: mandate.version,
        from: new Date(intervalStart).toISOString(), to: new Date(Math.max(intervalStart, intervalEnd)).toISOString(),
        profitUsd: movement?.toFixed(2) ?? null,
        returnPct: movement !== null && beginning !== null && beginning > 0 ? (movement / beginning * 100).toFixed(4) : null,
        orders: attributed.length, feesUsd: attributed.reduce((sum, trade) => sum + Number(trade.fee), 0).toFixed(2), gaps: versionGaps });
    }
    return { accountId, timezone, from: start, to: end, initialEquityUsd: baseline?.toFixed(2) ?? null, endingEquityUsd: equity?.toFixed(2) ?? null,
      profitUsd: profit?.toFixed(2) ?? null, returnPct: profit !== null && baseline !== null && baseline > 0 ? (profit / baseline * 100).toFixed(4) : null,
      buyAndHoldEquityUsd: buyAndHold?.toFixed(2) ?? null,
      excessReturnPct: equity !== null && buyAndHold !== null && benchmarkStart !== null && benchmarkStart > 0 && baseline !== null && baseline > 0 ? ((equity / baseline - buyAndHold / benchmarkStart) * 100).toFixed(4) : null,
      orders: trades.length, feesUsd: trades.reduce((sum, t) => sum + Number(t.fee), 0).toFixed(2), gaps,
      valuationAsOf: latestObserved?.snapshotDate ?? null,
      indexBenchmarkTicker: experiment.seed?.benchmark?.ticker ?? null,
      indexBenchmarkEquityUsd: indexBenchmark?.toFixed(2) ?? null,
      indexBenchmarkReturnPct: baseline !== null && indexBenchmark !== null && indexStart !== null && indexStart > 0 ? ((indexBenchmark / indexStart - 1) * 100).toFixed(4) : null,
      indexExcessReturnPct: baseline !== null && baseline > 0 && equity !== null && indexBenchmark !== null && indexStart !== null && indexStart > 0
        ? ((equity / baseline - indexBenchmark / indexStart) * 100).toFixed(4) : null,
      observedMaxDrawdownPct: drawdown, drawdownSampleCount: samples.length,
      drawdownCoverage: actionGaps.length ? 'corporate_action_gap' : drawdown === null ? 'insufficient_samples' : 'observed_snapshots_only',
      strategyContributions };
  }

  async archiveReview(owner: string, accountId: string, from: string, to: string) {
    if (!this.documents) throw new BadRequestException('Research document service unavailable');
    const review = await this.review(owner, accountId, from, to);
    const content = JSON.stringify(review, null, 2);
    const digest = createHash('sha256').update(content).digest('hex');
    return this.documents.submit(owner, { idempotencyKey: `simulation-review:${accountId}:${digest}`,
      kind: 'council', title: `Simulation review / 模拟复盘 ${from} — ${to}`, ticker: null, source: null,
      content, sections: [{ id: 'review', title: 'Period review / 期间复盘', content }],
      dataAsOf: null, availableAt: null, snapshot: { experimentId: accountId, from, to, review, gaps: review.gaps } });
  }
}
