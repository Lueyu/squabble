import 'reflect-metadata';
import { NotFoundException } from '@nestjs/common';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { agentSessions, cashAccounts, fxRates, holdings, paperAccounts, paperEvents, paperOrders, paperPositions, paperSnapshots, paperTrades } from '../../database/schema';
import { simulationCash, simulationSeeds } from '../../database/simulation-experiments.schema';
import { strategyReservations } from '../../database/strategy-mandates.schema';
import { SimulationExperimentsService } from './simulation-experiments.service';
import { PaperTradingService } from './paper-trading.service';
import { McpService, type McpSessionContext } from '../mcp/mcp.service';
import { simulationMarketFixture } from './simulation-market.fixture';
import { BotScheduler } from './bot.scheduler';

test('real snapshot creates an immutable independent opening ledger with idempotency, revisions and currency safety', {
  skip: !process.env.STRATEGY_TEST_DATABASE_URL,
}, async (t) => {
  const namespace = `simulation_test_${randomUUID().replaceAll('-', '')}`;
  const admin = postgres(process.env.STRATEGY_TEST_DATABASE_URL!, { max: 1, onnotice: () => undefined });
  const client = postgres(process.env.STRATEGY_TEST_DATABASE_URL!, { max: 8, onnotice: () => undefined, connection: { search_path: namespace } });
  try {
    await admin.unsafe(`CREATE SCHEMA ${namespace}`);
    for (const file of ['01_schema', '03_agent_builder', '08_investment_council', '09_builder_cadence', '12_council_dialogue',
      '16_daily_strategy', '17_research_memory', '18_research_workflow', '19_atomic_research_theses', '20_research_memory_temporal',
      '21_research_archive_jobs', '22_research_monitors', '28_simulation_experiments', '29_strategy_mandates']) {
      await client.unsafe(readFileSync(`scripts/db/${file}.sql`, 'utf8'));
    }
    t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-05T15:30:00Z') });
    const db = drizzle(client);
    const owner = randomUUID();
    const stranger = randomUUID();
    let price = 100;
    let market = 'US';
    let currency = 'USD';
    let quoteUnavailable = false;
    let corporateActionAt: string | null = null;
    const quotes = { getQuote: async () => quoteUnavailable ? null : ({ price: String(price), market, currency, timestamp: Date.now() }) };
    const fx = { convert: async (amount: number, from: string) => from === 'USD' ? amount : amount / 7.8 };
    const marketReader = { getSnapshot: async () => ({ ...simulationMarketFixture(await quotes.getQuote()),
      quoteTimestamp: quoteUnavailable ? null : new Date(Date.now() - 120_000).toISOString(),
      corporateActions: corporateActionAt ? [{ kind: 'split', occurredAt: corporateActionAt }] : [] }) };
    const experiments = new SimulationExperimentsService(db, quotes as never, fx as never, undefined, marketReader as never);
    const paper = new PaperTradingService(db, quotes as never, fx as never, { notifyUser: async () => undefined } as never,
      {} as never, {} as never, {} as never, { getSnapshot: async () => ({ ...simulationMarketFixture(await quotes.getQuote()),
        corporateActions: corporateActionAt ? [{ kind: 'split', occurredAt: corporateActionAt }] : [] }) } as never);
    await db.insert(holdings).values({ owner, ticker: 'AAPL', shares: '10', buyPrice: '20', currentPrice: '100' });
    await db.insert(holdings).values({ owner: stranger, ticker: 'SECRET', shares: '500', currentPrice: '200' });
    await db.insert(cashAccounts).values({ owner, currency: 'USD', balance: '1000' });
    const oldAccount = await paper.ensureAccount(owner);
    const preview = await experiments.preview(owner);
    assert.equal(preview.seed.positions[0].quoteAt, new Date(Date.now() - 120_000).toISOString(), 'seed marks use the provider quote instant, never retrieval time');
    assert.deepEqual(preview.seed.positions.map((p) => p.ticker), ['AAPL']);
    assert.equal(preview.seed.initialEquityUsd, '2000.00');
    const request = { previewId: preview.id, idempotencyKey: randomUUID(), name: 'Independent experiment', acknowledgeGaps: true, feeBps: 0, slippageBps: 0,
      cashAvailable: { USD: '1000' }, sellableShares: { AAPL: '5' } };
    await assert.rejects(experiments.create(stranger, request), /Preview not found/);
    const [first, retry] = await Promise.all([experiments.create(owner, request), experiments.create(owner, request)]);
    // Node's fake Date does not change PostgreSQL CURRENT_TIMESTAMP. Keep this
    // opening inventory in the fixture's November 5 timeline for later splits.
    await db.update(paperPositions).set({ openedAt: new Date(first.seed!.capturedAt) }).where(eq(paperPositions.accountId, first.id));
    assert.equal(first.id, retry.id);
    assert.notEqual(first.id, oldAccount.id);
    assert.equal((await db.select().from(paperOrders)).length, 0, 'opening balance must not fabricate buy orders');
    assert.equal((await db.select().from(paperTrades)).length, 0, 'opening balance must not fabricate trades');
    assert.equal((await db.select().from(paperAccounts)).length, 2, 'old account survives cloning');
    const [position] = await db.select().from(paperPositions).where(eq(paperPositions.accountId, first.id));
    assert.equal(Number(position.shares), 10);
    assert.equal(Number(position.avgCost), 100, 'performance cost is the opening mark');
    assert.equal(Number(position.restrictedShares), 5);
    assert.equal(first.seed?.positions[0].historicalCost, '20');
    assert.equal(Number(first.cash[0].available), 1000, 'no opening cash debit');
    assert.equal(first.sourceChanged, false, 'newly confirmed source matches the immutable opening seed');
    await db.update(holdings).set({ currentPrice: '123', updatedAt: new Date(Date.now() + 1000) }).where(eq(holdings.owner, owner));
    assert.equal((await experiments.get(owner, first.id)).sourceChanged, false, 'price refresh and source timestamps do not constitute a ledger change');
    await db.update(cashAccounts).set({ balance: '1200' }).where(eq(cashAccounts.owner, owner));
    const cashChanged = await experiments.get(owner, first.id);
    assert.equal(cashChanged.sourceChanged, true, 'source cash totals are compared independently of availability confirmations');
    assert.equal(Number(cashChanged.cash[0].available), 1000, 'a source cash change cannot fund the experiment');
    assert.deepEqual(cashChanged.seed, first.seed, 'the historical seed and sourceRevision remain immutable');
    await db.update(cashAccounts).set({ balance: '1000' }).where(eq(cashAccounts.owner, owner));
    assert.equal((await experiments.get(owner, first.id)).sourceChanged, false);
    await assert.rejects(experiments.get(stranger, first.id), /Experiment not found/);
    assert.deepEqual(await experiments.list(stranger), [], 'experiment reads remain owner scoped');
    await assert.rejects(db.update(simulationSeeds).set({ requestHash: 'tampered' }).where(eq(simulationSeeds.accountId, first.id)));
    await assert.rejects(experiments.create(owner, { ...request, name: 'Changed' }), /Idempotency/);
    const stale = await experiments.preview(owner);
    await db.update(holdings).set({ shares: '20' }).where(eq(holdings.owner, owner));
    await assert.rejects(experiments.create(owner, { ...request, previewId: stale.id, idempotencyKey: randomUUID() }), /Real account changed/);
    const changedSource = await experiments.get(owner, first.id);
    assert.equal(changedSource.sourceChanged, true);
    assert.equal(changedSource.seed?.positions[0].shares, '10');
    assert.equal(Number(changedSource.cash[0].available), 1000);
    assert.equal(Number((await db.select().from(paperPositions).where(eq(paperPositions.accountId, first.id)))[0].shares), 10);
    assert.equal((await experiments.get(owner, oldAccount.id)).sourceChanged, null, 'cash-only books have no real-account seed to compare');
    const readSource = Reflect.get(experiments, 'source').bind(experiments);
    let sourceReads = 0;
    Reflect.set(experiments, 'source', async (...args: unknown[]) => { sourceReads++; return readSource(...args); });
    const listed = await experiments.list(owner);
    assert.equal(sourceReads, 1, 'listing experiments computes the current source once');
    assert.equal(listed.find(item => item.id === first.id)?.sourceChanged, true);
    Reflect.set(experiments, 'source', readSource);
    const overview = await paper.getOverview(owner);
    assert.equal(overview.totalPl, '0.00');
    const restrictedSell = await paper.placeOrder(owner, { ticker: 'AAPL', side: 'sell', quantity: 6 }, 'manual', undefined, true);
    assert.equal(restrictedSell.status, 'rejected_risk');
    const sell = await paper.placeOrder(owner, { ticker: 'AAPL', side: 'sell', quantity: 1 }, 'manual', undefined, true);
    assert.equal(sell.status, 'filled');
    const [cash] = await db.select().from(simulationCash).where(eq(simulationCash.accountId, first.id));
    assert.equal(Number(cash.available), 1000);
    assert.equal(Number(cash.unsettled), 100, 'US sale proceeds wait for T+1');
    market = 'HK'; currency = 'HKD'; price = 10;
    t.mock.timers.setTime(new Date('2026-11-06T02:00:00Z').getTime());
    const foreignBuy = await paper.placeOrder(owner, { ticker: '0700.HK', side: 'buy', quantity: 100 }, 'manual', undefined, true);
    assert.equal(foreignBuy.status, 'rejected_risk', 'USD cannot implicitly fund HKD trades');
    t.mock.timers.setTime(new Date('2026-11-05T15:30:00Z').getTime());
    market = 'US'; currency = 'USD'; price = 100;
    await experiments.select(owner, oldAccount.id);
    const accountLedgers = async () => Promise.all([
      db.select().from(paperAccounts).where(eq(paperAccounts.owner, owner)).orderBy(paperAccounts.id),
      db.select().from(simulationCash).where(eq(simulationCash.owner, owner)).orderBy(simulationCash.id),
      db.select().from(paperPositions).where(eq(paperPositions.owner, owner)).orderBy(paperPositions.id),
      db.select().from(paperOrders).where(eq(paperOrders.owner, owner)).orderBy(paperOrders.id),
      db.select().from(paperTrades).where(eq(paperTrades.owner, owner)).orderBy(paperTrades.id),
    ]);
    const beforeStaleOrder = await accountLedgers();
    await assert.rejects(paper.placeOrder(owner, { ticker: 'AAPL', side: 'buy', quantity: 1 }, 'manual', undefined, true,
      false, undefined, undefined, undefined, first.id), (error: unknown) => {
        assert.ok(error instanceof NotFoundException);
        assert.equal(error.getStatus(), 404);
        assert.equal(error.message, 'Active paper account not found');
        return true;
      });
    assert.deepEqual(await accountLedgers(), beforeStaleOrder, 'an inactive account ID cannot mutate either account ledger');
    assert.equal((await paper.getOverview(owner)).positions.length, 0);
    assert.equal((await paper.getOverview(owner)).recentOrders.length, 0);
    await assert.rejects(paper.approveOrder(owner, sell.id), /active paper account/);
    assert.equal((await experiments.get(owner, first.id)).seed?.positions[0].shares, '10', 'real changes never overwrite the seed');
    await assert.rejects(experiments.get(stranger, first.id), /not found/);
    await experiments.select(owner, first.id);
    const review = await experiments.review(owner, first.id);
    assert.equal(review.profitUsd, null, 'same-instant initialization and snapshot do not establish period performance');
    assert.equal(review.valuationCoverage, 'initial_only');
    assert.equal(review.buyAndHoldEquityUsd, '2000.00');

    const raceOwner = randomUUID();
    const raceAccount = await paper.resetAccount(raceOwner, 1000);
    const racing = await Promise.all([1, 2].map(() => paper.placeOrder(raceOwner,
      { ticker: 'AAPL', side: 'buy', quantity: 7 }, 'manual', undefined, true, true, undefined, undefined, undefined, raceAccount.id)));
    assert.equal(racing.filter((o) => o.status === 'filled').length, 1, 'concurrent orders cannot spend the same currency cash');
    const [raceCash] = await db.select().from(simulationCash).where(eq(simulationCash.accountId, raceAccount.id));
    assert.equal(Number(raceCash.available), 300);
    await db.update(paperAccounts).set({ botEnabled: true }).where(eq(paperAccounts.id, raceAccount.id));
    const [pending] = await db.insert(paperOrders).values({ owner: raceOwner, accountId: raceAccount.id,
      ticker: 'MSFT', side: 'buy', quantity: '1', source: 'agent', status: 'pending_approval' }).returning();
    const approved = await paper.approveOrder(raceOwner, pending.id);
    assert.equal(approved.status, 'rejected_risk', 'approval must not route AI orders through manual caps bypass');
    await assert.rejects(paper.approveOrder(raceOwner, pending.id), /pending approval/);
    const [raceAfterApproval] = await db.select().from(simulationCash).where(eq(simulationCash.accountId, raceAccount.id));
    assert.equal(Number(raceAfterApproval.available), 300);

    const priorCash = (await experiments.get(owner, first.id)).cash[0];
    t.mock.timers.setTime(new Date('2026-11-06T21:05:00Z').getTime());
    await paper.getOverview(owner);
    const afterSettlement = (await experiments.get(owner, first.id)).cash[0];
    assert.equal(Number(priorCash.unsettled), 100);
    assert.equal(Number(afterSettlement.available), 1100, 'viewing releases due verified settlements without fabricating an order');
    assert.equal(Number(afterSettlement.unsettled), 0);

    const mcp = new McpService(db, paper, quotes as never, {} as never);
    const context: McpSessionContext = { userId: owner, sessionId: randomUUID(), name: 'Test agent', dailyLimitUsd: 500,
      permission: 'trade', approvalMode: 'require_approval' };
    const mcpPortfolio = await mcp.callTool(context, 'get_portfolio', {}) as { accountId: string };
    assert.equal(mcpPortfolio.accountId, first.id, 'MCP exposes the identity the agent must bind');
    await assert.rejects(mcp.callTool(context, 'place_paper_order', { ticker: 'AAPL', side: 'buy', quantity: 1 }), /accountId/);
    await experiments.select(owner, oldAccount.id);
    const mcpOrders = await mcp.callTool(context, 'list_orders', {}) as unknown[];
    assert.equal(mcpOrders.length, 0, 'MCP never mixes another experiment history');
    await assert.rejects(mcp.callTool(context, 'place_paper_order', { accountId: first.id, ticker: 'AAPL', side: 'buy', quantity: 1 }), /account changed/);
    await db.update(paperAccounts).set({ botEnabled: true }).where(eq(paperAccounts.id, first.id));
    t.mock.timers.setTime(new Date('2026-11-09T15:30:00Z').getTime());
    const scanned: string[] = [];
    const scheduler = new BotScheduler(db, { runBotScan: async (_owner: string, id: string) => { scanned.push(id); } } as never);
    await Reflect.get(scheduler, 'tick').call(scheduler);
    assert.ok(!scanned.includes(first.id), 'scheduler excludes inactive accounts even if a stale bot flag remains');
    assert.ok(scanned.includes(raceAccount.id), 'scheduler binds the active account identity');

    const cnOwner = randomUUID();
    t.mock.timers.setTime(new Date('2026-11-06T02:00:00Z').getTime());
    market = 'CN'; currency = 'CNY'; price = 10;
    await db.insert(holdings).values({ owner: cnOwner, ticker: '600000', market: 'CN', currency: 'CNY', shares: '200', buyPrice: '5', currentPrice: '10' });
    await db.insert(cashAccounts).values({ owner: cnOwner, currency: 'CNY', balance: '1000' });
    await db.insert(fxRates).values({ base: 'USD', quote: 'CNY', rate: '7.8', rateDate: '2026-11-06' });
    const cnPreview = await experiments.preview(cnOwner);
    await experiments.create(cnOwner, { ...request, previewId: cnPreview.id, idempotencyKey: randomUUID(),
      cashAvailable: { CNY: '1000' }, sellableShares: { '600000': '100' } });
    const cnBuy = await paper.placeOrder(cnOwner, { ticker: '600000', side: 'buy', quantity: 100 }, 'manual', undefined, true);
    assert.equal(cnBuy.status, 'filled');
    const cnSell = await paper.placeOrder(cnOwner, { ticker: '600000', side: 'sell', quantity: 200 }, 'manual', undefined, true);
    assert.equal(cnSell.status, 'rejected_risk', 'opening restrictions and same-day CN buys reduce sellability together');

    market = 'US'; currency = 'USD'; price = 100;
    t.mock.timers.setTime(new Date('2026-11-09T15:30:00Z').getTime());
    await experiments.select(owner, first.id);
    quoteUnavailable = true;
    const snapshotsBeforeMissing = await db.select().from(paperSnapshots).where(eq(paperSnapshots.accountId, first.id));
    const incomplete = await paper.getOverview(owner);
    assert.equal(incomplete.equity, null, 'missing position quotes are never treated as zero or historical cost');
    assert.equal(incomplete.totalPl, null);
    assert.ok(incomplete.valuationGaps?.length);
    assert.deepEqual(await db.select().from(paperSnapshots).where(eq(paperSnapshots.accountId, first.id)), snapshotsBeforeMissing,
      'unknown valuation cannot overwrite or create a performance snapshot');
    quoteUnavailable = false;
    await paper.getOverview(owner);
    const incompletePeriod = await experiments.review(owner, first.id, '2026-11-09', '2026-11-09');
    assert.equal(incompletePeriod.profitUsd, null, 'missing exact period opening cannot become since-inception profit');
    assert.equal(incompletePeriod.excessReturnPct, null);
    assert.ok(incompletePeriod.gaps.includes('PERIOD_START_SNAPSHOT_MISSING'));
    corporateActionAt = '2026-11-09T12:00:00Z';
    await db.update(paperAccounts).set({ botEnabled: true }).where(eq(paperAccounts.id, first.id));
    const changedByAction = await paper.getOverview(owner);
    assert.equal(changedByAction.equity, null);
    assert.ok(changedByAction.valuationGaps?.some((gap) => gap.includes('CORPORATE_ACTION')));
    assert.equal((await db.select().from(paperAccounts).where(eq(paperAccounts.id, first.id)))[0].botEnabled, false);
    const actionReview = await experiments.review(owner, first.id, '2026-11-01', '2026-11-09');
    assert.equal(actionReview.profitUsd, null, 'a pre-action snapshot cannot become a complete post-action return');
    assert.equal(actionReview.excessReturnPct, null);
    assert.ok(actionReview.gaps.some(gap => gap.startsWith('CORPORATE_ACTION_RECONCILIATION_REQUIRED')));

    corporateActionAt = null;
    assert.equal((await paper.getOverview(owner)).equity, null, 'an observed action remains unresolved even when a later provider response omits it');
    assert.equal((await paper.placeOrder(owner, { ticker: 'aapl', side: 'sell', quantity: 1 }, 'manual', undefined, true)).status,
      'rejected_risk', 'ticker case cannot bypass a persisted corporate-action restriction');
    const actionEvents = (await db.select().from(paperEvents).where(eq(paperEvents.accountId, first.id))).filter(event => event.eventType === 'corporate_action_gap');
    assert.equal(actionEvents.length, 1, 'repeated scans persist only one gap for the same event');
    assert.equal((await experiments.review(owner, first.id, '2026-11-01', '2026-11-06')).profitUsd, '0.00', 'an earlier unaffected review remains available');
    const feeOwner = randomUUID();
    await db.insert(holdings).values({ owner: feeOwner, ticker: 'AAPL', shares: '10', buyPrice: '20', currentPrice: '100' });
    await db.insert(cashAccounts).values({ owner: feeOwner, currency: 'USD', balance: '1000' });
    const feePreview = await experiments.preview(feeOwner);
    const feeAccount = await experiments.create(feeOwner, { ...request, previewId: feePreview.id, idempotencyKey: randomUUID(),
      feeBps: 5, slippageBps: 10, benchmarkTicker: 'SPY', sellableShares: { AAPL: '10' } });
    const feeSell = await paper.placeOrder(feeOwner, { ticker: 'AAPL', side: 'sell', quantity: 1 }, 'manual', undefined, true);
    assert.equal(Number(feeSell.filledPrice), 99.9, 'sell slippage is adverse');
    const feeBuy = await paper.placeOrder(feeOwner, { ticker: 'AAPL', side: 'buy', quantity: 1 }, 'manual', undefined, true);
    assert.equal(Number(feeBuy.filledPrice), 100.1, 'buy slippage is adverse');
    await db.update(paperTrades).set({ createdAt: new Date() }).where(eq(paperTrades.accountId, feeAccount.id));
    const feeCash = (await experiments.get(feeOwner, feeAccount.id)).cash[0];
    assert.ok(Math.abs(Number(feeCash.available) - 899.84995) < 1e-8, 'buy fee is debited in native currency');
    assert.ok(Math.abs(Number(feeCash.unsettled) - 99.85005) < 1e-8, 'sell fee reduces unsettled proceeds');
    t.mock.timers.setTime(Date.now() + 60_000);
    await paper.getOverview(feeOwner);
    const feeReview = await experiments.review(feeOwner, feeAccount.id, '2026-11-01', '2026-11-09');
    assert.equal(feeReview.profitUsd, '-0.30');
    assert.equal(feeReview.feesUsd, '0.10');
    assert.equal(feeReview.indexBenchmarkTicker, 'SPY');
    assert.equal(feeReview.indexBenchmarkEquityUsd, '2000.00');
    assert.equal(feeReview.indexExcessReturnPct, '-0.0150');
    const reservedOwner = randomUUID();
    const reservedAccount = await paper.resetAccount(reservedOwner, 1000);
    const cashReservation = randomUUID();
    await db.insert(strategyReservations).values({ owner: reservedOwner, accountId: reservedAccount.id, signalId: cashReservation,
      ticker: 'MSFT', side: 'buy', currency: 'USD', cash: '800', shares: '0', expiresAt: new Date(Date.now() + 60_000) });
    assert.equal((await paper.placeOrder(reservedOwner, { ticker: 'AAPL', side: 'buy', quantity: 5 }, 'manual', undefined, true)).status,
      'rejected_risk', 'manual fills cannot consume cash reserved by a live Council candidate');
    await assert.rejects(experiments.exchange(reservedOwner, reservedAccount.id, { from: 'USD', to: 'HKD', amount: 500 }), /available|reserved/i);
    await db.insert(simulationCash).values({ owner: reservedOwner, accountId: reservedAccount.id, currency: 'HKD', frozen: '80', availabilityKnown: false });
    const exchanged = await experiments.exchange(reservedOwner, reservedAccount.id, { from: 'USD', to: 'HKD', amount: 100 });
    const receiving = exchanged.cash.find(cash => cash.currency === 'HKD')!;
    assert.equal(receiving.availabilityKnown, true, 'explicit incoming FX creates known spendable cash even when older funds remain frozen');
    assert.equal(Number(receiving.frozen), 80, 'new FX never unlocks unknown opening funds');
    await db.insert(paperPositions).values({ owner: reservedOwner, accountId: reservedAccount.id, ticker: 'AAPL', shares: '10', avgCost: '100' });
    await db.insert(strategyReservations).values({ owner: reservedOwner, accountId: reservedAccount.id, signalId: randomUUID(),
      ticker: 'AAPL', side: 'sell', currency: 'USD', cash: '0', shares: '8', expiresAt: new Date(Date.now() + 60_000) });
    assert.equal((await paper.placeOrder(reservedOwner, { ticker: 'AAPL', side: 'sell', quantity: 5 }, 'manual', undefined, true)).status,
      'rejected_risk', 'manual fills cannot consume shares reserved by another live candidate');
    const budgetOwner = randomUUID();
    await db.insert(cashAccounts).values({ owner: budgetOwner, currency: 'USD', balance: '10000' });
    const budgetPreview = await experiments.preview(budgetOwner);
    const budgetAccount = await experiments.create(budgetOwner, { ...request, previewId: budgetPreview.id, idempotencyKey: randomUUID(),
      feeBps: 5, slippageBps: 10, cashAvailable: { USD: '10000' } });
    await db.update(paperAccounts).set({ botEnabled: true }).where(eq(paperAccounts.id, budgetAccount.id));
    const [feeSession] = await db.insert(agentSessions).values({ owner: budgetOwner, name: 'Fee budget agent', token: randomUUID(),
      dailyLimitUsd: '100.12', approvalMode: 'auto' }).returning();
    const feeContext: McpSessionContext = { userId: budgetOwner, sessionId: feeSession.id, name: feeSession.name,
      dailyLimitUsd: 100.12, permission: 'trade', approvalMode: 'auto' };
    const feeLimit = await mcp.callTool(feeContext, 'place_paper_order', { accountId: budgetAccount.id, ticker: 'AAPL', side: 'buy', quantity: 1 }) as { status: string; reason: string };
    assert.equal(feeLimit.status, 'rejected_risk', 'session cash spending includes the commission and adverse slippage');
    assert.match(feeLimit.reason, /daily USD spending limit/);
    await db.update(agentSessions).set({ dailyLimitUsd: '500', approvalMode: 'require_approval' }).where(eq(agentSessions.id, feeSession.id));
    const approvalModeChanged = await mcp.callTool(feeContext, 'place_paper_order', { accountId: budgetAccount.id, ticker: 'AAPL', side: 'buy', quantity: 1 }) as { status: string };
    assert.equal(approvalModeChanged.status, 'pending_approval', 'a stale MCP context cannot bypass a newly required approval');
    await db.update(agentSessions).set({ status: 'revoked' }).where(eq(agentSessions.id, feeSession.id));
    await assert.rejects(mcp.callTool(feeContext, 'place_paper_order', { accountId: budgetAccount.id, ticker: 'AAPL', side: 'buy', quantity: 1 }), /no longer authorized/);
    const accountsBeforeMigration = await db.select().from(paperAccounts);
    const seedsBeforeMigration = await db.select().from(simulationSeeds);
    await client.unsafe(readFileSync('scripts/db/28_simulation_experiments.sql', 'utf8'));
    await client.unsafe(readFileSync('scripts/db/28_simulation_experiments.sql', 'utf8'));
    assert.deepEqual(await db.select().from(paperAccounts), accountsBeforeMigration, 'reapplying the migration preserves all books');
    assert.deepEqual(await db.select().from(simulationSeeds), seedsBeforeMigration, 'reapplying the migration preserves immutable opening seeds');
  } finally {
    t.mock.timers.reset();
    await client.end();
    await admin.unsafe(`DROP SCHEMA IF EXISTS ${namespace} CASCADE`);
    await admin.end();
  }
});
