import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { investmentFixture } from './investment-test.fixture';
import { InvestmentPolicyService } from './investment-policy.service';
import { SimulationExperimentsService } from './simulation-experiments.service';
import { UserInvestmentStrategyService } from './user-investment-strategy.service';
import { ResearchDocumentsService } from '../research-documents/research-documents.service';
import { PaperTradingService } from './paper-trading.service';
import { simulationMarketFixture } from './simulation-market.fixture';
import { paperAccounts, paperOrders, paperPositions } from '../../database/schema';
import { investmentExecutionFence } from './investment-policy.fence';
import type { StrategyCandidate } from '../../../shared/strategy.interface';
import { AgentBuilderService } from './agent-builder.service';
import { StrategyMandateService } from './strategy-mandate.service';
import { StrategyStore } from './strategy.store';
import { StrategyMonitorService } from './strategy-monitor.service';
import { strategyMandates, strategyReservations } from '../../database/strategy-mandates.schema';
import { strategySignals } from '../../database/strategy.schema';
import { tradingMarketSchedule } from './trading-market.calendar';

test('raw manual orders cannot bypass confirmed strategy scope, while unmanaged manual trading remains available', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-06T15:00:00Z') });
  await investmentFixture(async (db, client, owner) => {
    await client.unsafe(readFileSync('scripts/db/39_user_investment_strategies.sql', 'utf8'));
    const fx = { convert: async (value: number) => value };
    const market = { getSnapshot: async (ticker: string) => ({ ...simulationMarketFixture({ price: '100', market: 'US', currency: 'USD', timestamp: Date.now() }), ticker }) };
    const quotes = { getQuote: async (ticker: string) => ({ symbol: ticker, price: '100', market: 'US', currency: 'USD', timestamp: Date.now() }) };
    const paper = new PaperTradingService(db, quotes as never, fx as never, {} as never, undefined, undefined, undefined, market as never);
    await db.insert(paperAccounts).values({ owner, name: 'Unmanaged manual fixture', cashBalance: '10000', initialCash: '10000', isActive: true });
    const manual = await paper.placeOrder(owner, { ticker: 'MSFT', side: 'buy', quantity: 1, orderType: 'market' }, 'manual', undefined, true);
    assert.equal(manual.status, 'filled', 'the managed-account boundary must preserve legacy manual trading');
    const drafts = new UserInvestmentStrategyService(db, new ResearchDocumentsService(db), {} as never);
    const policies = new InvestmentPolicyService(db, new SimulationExperimentsService(db, quotes as never, fx as never), drafts);
    const preview = await policies.preview(owner, { origin: 'cash', cash: { amount: 10000, currency: 'USD' }, requestKey: 'manual-scope-preview' });
    await policies.start(owner, { previewId: preview.id, requestKey: 'manual-scope-create' });
    await assert.rejects(paper.placeOrder(owner, { ticker: 'MSFT', side: 'buy', quantity: 1, orderType: 'market' }, 'manual', undefined, true), /USER_STRATEGY_CONFIRMED_SCOPE_REQUIRED/, 'a newly copied observing ledger cannot trade before strategy confirmation');
    const now = new Date();
    const draft = await drafts.create(owner, { title: 'Observe only', body: 'Observe AAPL, do not trade', timezone: 'Asia/Shanghai', startsAt: now.toISOString(), endsAt: new Date(now.getTime() + 86400000).toISOString(),
      limits: { maxPositionPct: 10, maxDailyIncreasePct: 5, maxDailyTurnoverPct: 20, minCashPct: 10, maxGrossExposurePct: 90, maxOrderPct: 5 }, entries: [] });
    const ready = await drafts.preview(owner, draft.id, draft.revision);
    const applied = await policies.applyStrategy(owner, { strategyId: draft.id, expectedRevision: draft.revision, previewHash: ready.preview!.contentHash, expectedCurrentId: null, requestKey: 'manual-scope-apply' });
    await assert.rejects(paper.placeOrder(owner, { ticker: 'MSFT', side: 'buy', quantity: 1, orderType: 'market' }, 'manual', undefined, true), /USER_STRATEGY_CONFIRMED_SCOPE_REQUIRED/);
    assert.equal((await db.select().from(paperOrders)).length, 1, 'a rejected raw manual request cannot create an order');
    assert.equal((await db.select().from(paperPositions)).filter(position => position.accountId === applied.policy.accountId).length, 0);
  });
});

test('a single entry expiry releases its pending cash without stopping other valid entries', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-06T15:00:00Z') });
  await investmentFixture(async (db, client, owner) => {
    await client.unsafe(readFileSync('scripts/db/39_user_investment_strategies.sql', 'utf8'));
    const docs = new ResearchDocumentsService(db); const drafts = new UserInvestmentStrategyService(db, docs, {} as never);
    const simulations = new SimulationExperimentsService(db, {} as never, {} as never);
    const policies = new InvestmentPolicyService(db, simulations, drafts);
    const preview = await policies.preview(owner, { origin: 'cash', cash: { amount: 10000, currency: 'USD' }, requestKey: 'pending-entry-preview' });
    const account = await policies.start(owner, { previewId: preview.id, requestKey: 'pending-entry-create' });
    const now = new Date(); const text = 'Buy 1 AAPL below 100';
    const entries = ['early', 'later'].map((id, index) => ({ id, text, endsAt: new Date(now.getTime() + (index ? 3600000 : 60000)).toISOString(), sourceKeys: [], directive: { ticker: 'AAPL', side: 'buy', quantity: 1, trigger: { kind: 'price_lte', price: 100 }, reviewedText: text, numericEvidence: [{ field: 'quantity', value: 1, quote: text }, { field: 'trigger.price', value: 100, quote: text }] } }));
    const draft = await drafts.create(owner, { title: 'Independent entry periods', body: text, timezone: 'Asia/Shanghai', startsAt: now.toISOString(), endsAt: new Date(now.getTime() + 86400000).toISOString(),
      limits: { maxPositionPct: 10, maxDailyIncreasePct: 5, maxDailyTurnoverPct: 20, minCashPct: 10, maxGrossExposurePct: 90, maxOrderPct: 5 }, entries });
    const ready = await drafts.preview(owner, draft.id, draft.revision);
    const applied = await policies.applyStrategy(owner, { strategyId: draft.id, expectedRevision: draft.revision, previewHash: ready.preview!.contentHash, expectedCurrentId: null, requestKey: 'pending-entry-apply' });
    const [mandate] = await db.select().from(strategyMandates);
    const security = { ticker: 'AAPL', market: 'US', currency: 'USD', assetType: 'stock', identitySourceUrl: 'https://example.invalid/identity', sourceUrl: 'https://example.invalid/price', observedAt: now.toISOString(), summary: 'Offline fixture identity', providerSymbol: 'AAPL', lotSize: 1, leveraged: false, inverse: false };
    await db.update(strategyMandates).set({ config: { ...mandate.config, rules: mandate.config.rules.map(rule => ({ ...rule, security })) } as never }).where(eq(strategyMandates.id, mandate.id));
    const builder = new AgentBuilderService(db, {} as never); const profile = (await builder.getActiveProfile(owner))!;
    const mandates = new StrategyMandateService(db, docs, builder, {} as never, {} as never);
    const plan = await mandates.dailyPlan(owner, profile, (await db.select().from(strategyMandates))[0], 'US', tradingMarketSchedule('US', now));
    const store = new StrategyStore(db);
    for (const entryId of ['early', 'later']) {
      const ruleId = mandate.config.rules.find(rule => rule.userEntryId === entryId)!.id;
      const candidate = { signalId: randomUUID(), planId: plan.id, planVersion: plan.version, ruleId, userEntryId: entryId, ticker: 'AAPL', market: 'US', side: 'buy', quantity: 1, price: 99, quoteAt: now.toISOString(), protectiveStop: false, reason: text, accountId: account.accountId,
        mandateId: mandate.id, mandateVersion: mandate.version, parentPolicyId: applied.policy.id, parentPolicyRevision: applied.policy.revision, userStrategyId: draft.id, userStrategyRevision: draft.revision } as StrategyCandidate;
      assert.equal(await store.claimSignal(owner, profile, candidate), true);
    }
    t.mock.timers.tick(60000);
    await new StrategyMonitorService(db, docs, simulations).heartbeat(owner, account.accountId);
    const signals = await db.select().from(strategySignals); const reservations = await db.select().from(strategyReservations);
    assert.equal(signals.find(signal => signal.candidate.userEntryId === 'early')!.state, 'expired');
    assert.equal(reservations.find(reservation => reservation.signalId === signals.find(signal => signal.candidate.userEntryId === 'early')!.id)!.status, 'released');
    assert.equal(signals.find(signal => signal.candidate.userEntryId === 'later')!.state, 'reviewing');
    assert.equal(reservations.find(reservation => reservation.signalId === signals.find(signal => signal.candidate.userEntryId === 'later')!.id)!.status, 'active');
    assert.equal((await db.select().from(strategyMandates))[0].status, 'published');
  });
});

test('protective exits remain bound to the exact confirmed entry and its explicit period', async () => {
  await investmentFixture(async (db, client, owner) => {
    await client.unsafe(readFileSync('scripts/db/39_user_investment_strategies.sql', 'utf8'));
    const drafts = new UserInvestmentStrategyService(db, new ResearchDocumentsService(db), {} as never);
    const policies = new InvestmentPolicyService(db, new SimulationExperimentsService(db, {} as never, {} as never), drafts);
    const preview = await policies.preview(owner, { origin: 'cash', cash: { amount: 10000, currency: 'USD' }, requestKey: 'entry-stop-preview' });
    const account = await policies.start(owner, { previewId: preview.id, requestKey: 'entry-stop-create' });
    const now = new Date(); const startsAt = new Date(now.getTime() + 60000); const endsAt = new Date(now.getTime() + 120000);
    const text = 'Buy 1 AAPL below 100 with stop 80';
    const draft = await drafts.create(owner, { title: 'Entry with its own expiry', body: text, timezone: 'Asia/Shanghai', startsAt: now.toISOString(), endsAt: new Date(now.getTime() + 86400000).toISOString(),
      limits: { maxPositionPct: 10, maxDailyIncreasePct: 5, maxDailyTurnoverPct: 20, minCashPct: 10, maxGrossExposurePct: 90, maxOrderPct: 5 },
      entries: [{ id: 'protected-entry', text, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(), sourceKeys: [], directive: { ticker: 'AAPL', side: 'buy', quantity: 1, trigger: { kind: 'price_lte', price: 100 }, stopLossPrice: 80, reviewedText: text,
        numericEvidence: [{ field: 'quantity', value: 1, quote: text }, { field: 'trigger.price', value: 100, quote: text }, { field: 'stopLossPrice', value: 80, quote: text }] } }] });
    const ready = await drafts.preview(owner, draft.id, draft.revision);
    const applied = await policies.applyStrategy(owner, { strategyId: draft.id, expectedRevision: draft.revision, previewHash: ready.preview!.contentHash, expectedCurrentId: null, requestKey: 'entry-stop-apply' });
    const [mandate] = await db.select().from(strategyMandates);
    const candidate = { protectiveStop: true, accountId: account.accountId, mandateId: mandate.id, mandateVersion: mandate.version,
      userStrategyId: draft.id, userStrategyRevision: draft.revision, userEntryId: 'protected-entry',
      ruleId: mandate.config.rules[0].id, parentPolicyId: applied.policy.id, parentPolicyRevision: applied.policy.revision } as StrategyCandidate;
    const check = (at: Date, signal = candidate) => db.transaction(tx => investmentExecutionFence(tx, owner, account.accountId, { ticker: 'AAPL', market: 'US', side: 'sell' }, 'agent', signal, at));
    assert.equal((await check(now)).block, 'USER_STRATEGY_PROTECTION_NOT_AUTHORIZED', 'a future entry cannot authorize a stop yet');
    assert.equal((await check(startsAt)).block, null);
    assert.equal((await check(endsAt)).block, 'USER_STRATEGY_PROTECTION_NOT_AUTHORIZED', 'an entry stop expires with that entry');
    assert.equal((await check(startsAt, { ...candidate, ruleId: 'different-entry' })).block, 'USER_STRATEGY_PROTECTION_NOT_AUTHORIZED', 'another entry cannot borrow this stop authorization');
  });
});
