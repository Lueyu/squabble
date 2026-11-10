import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { investmentFixture } from './investment-test.fixture';
import { InvestmentPolicyService } from './investment-policy.service';
import { SimulationExperimentsService } from './simulation-experiments.service';
import { UserInvestmentStrategyService } from './user-investment-strategy.service';
import { ResearchDocumentsService } from '../research-documents/research-documents.service';
import { StrategyService } from './strategy.service';
import { StrategyStore } from './strategy.store';
import { StrategyMandateService } from './strategy-mandate.service';
import { AgentBuilderService } from './agent-builder.service';
import { PaperTradingService } from './paper-trading.service';
import { BuilderCadenceService } from './builder-cadence.service';
import { tradingMarketSchedule } from './trading-market.calendar';
import { simulationMarketFixture } from './simulation-market.fixture';
import { installInvestorMandate } from './user-strategy-runtime';
import { lockMemoryOwner } from '../research-memory/research-memory.fence';
import { holdings, cashAccounts, builderProfiles, paperOrders } from '../../database/schema';
import { investmentPolicies } from '../../database/investment-policy.schema';
import { strategySignals } from '../../database/strategy.schema';
import { strategyMandates, strategyReservations } from '../../database/strategy-mandates.schema';

test('daily frequency is fenced under claim/fill locks, survives runtime rebuild, and resumes on the next verified trading day', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-06T15:00:00Z') });
  await investmentFixture(async (db, _client, owner) => {
    await db.insert(holdings).values({ owner, ticker: 'AAPL', shares: '1', buyPrice: '80', market: 'US', currency: 'USD' });
    await db.insert(cashAccounts).values({ owner, currency: 'USD', balance: '10000', reconciliationStatus: 'confirmed' });
    let price = '100'; let calls = 0;
    const quote = () => ({ price, market: 'US', currency: 'USD', timestamp: Date.now(), symbol: 'AAPL' });
    const snapshot = () => ({ ...simulationMarketFixture(quote()), ticker: 'AAPL', providerSymbol: 'AAPL', lotSize: 1,
      usable: false, reason: 'Fixture has no indicator history', candles: Array.from({ length: 20 }, () => ({ volume: 1000000 })), indicators: null });
    const market = { getSnapshot: async () => snapshot(), getSchedule: async () => tradingMarketSchedule('US', new Date()) };
    const fx = { convert: async (amount: number) => amount };
    const model = { json: async () => { calls++; throw new Error('No model call allowed'); } };
    const docs = new ResearchDocumentsService(db);
    const drafts = new UserInvestmentStrategyService(db, docs, model as never);
    const policies = new InvestmentPolicyService(db, new SimulationExperimentsService(db, { getQuote: async () => quote() } as never, fx as never), drafts);
    const opening = await policies.preview(owner, { origin: 'holdings', requestKey: randomUUID() });
    await policies.start(owner, { previewId: opening.id, requestKey: randomUUID(), confirmOpeningCash: true });
    const text = 'Buy 1 AAPL strictly below 100, at most once per trading day';
    const draft = await drafts.create(owner, { title: 'Daily explicit fixture', body: text, timezone: 'America/New_York',
      startsAt: new Date().toISOString(), endsAt: '2026-11-12T00:00:00Z',
      limits: { maxPositionPct: 10, maxDailyIncreasePct: 5, maxDailyTurnoverPct: 20, minCashPct: 10, maxGrossExposurePct: 90, maxOrderPct: 5 },
      entries: [{ id: 'daily', text, sourceKeys: [], directive: { ticker: 'AAPL', side: 'buy', quantity: 1,
        trigger: { kind: 'price_lt', price: 100 }, executionFrequency: { kind: 'per_trading_day', maxExecutions: 1 }, reviewedText: text,
        numericEvidence: [{ field: 'quantity', value: 1, quote: '1' }, { field: 'trigger.price', value: 100, quote: '100' }] } }] });
    const prepared = await drafts.preview(owner, draft.id, draft.revision);
    const applied = await policies.applyStrategy(owner, { strategyId: draft.id, expectedRevision: draft.revision,
      previewHash: prepared.preview!.contentHash, expectedCurrentId: null, requestKey: randomUUID() });
    const builder = new AgentBuilderService(db, {} as never);
    const configureCadence = async () => {
      const profile = (await builder.getActiveProfile(owner))!;
      await db.update(builderProfiles).set({ config: { ...profile.config,
        cadence: { reviewEveryTradingDays: 1, cooldownTradingDays: 0, maxOrdersPerWeek: 20, maxWeeklyTurnoverPct: 100 } } }).where(eq(builderProfiles.id, profile.id));
    };
    await configureCadence();
    const paper = new PaperTradingService(db, { getQuote: async () => quote() } as never, fx as never, {} as never,
      builder, new BuilderCadenceService(db), {} as never, market as never);
    const store = new StrategyStore(db);
    const mandates = new StrategyMandateService(db, docs, builder, model as never, market as never);
    const discovery = { verify: async () => ({ ticker: 'AAPL', market: 'US', currency: 'USD', assetType: 'stock',
      identitySourceUrl: 'https://example.invalid/identity', sourceUrl: 'https://example.invalid/quote', observedAt: new Date().toISOString(),
      summary: 'Offline fixture', providerSymbol: 'AAPL', lotSize: 1, leveraged: false, inverse: false }) };
    const engine = new StrategyService(db, builder, paper, {} as never, market as never, model as never, store, fx as never, mandates, undefined, undefined, discovery as never);
    await engine.tick(owner);
    assert.equal((await db.select().from(paperOrders)).length, 0, 'strict equality must not create an order');
    price = '99'; t.mock.timers.tick(30000);
    await engine.tick(owner);
    const [fill] = await db.select().from(strategySignals).where(eq(strategySignals.state, 'filled'));
    assert.ok(fill, JSON.stringify(await db.select().from(strategySignals)));
    const profile = (await builder.getActiveProfile(owner))!;
    const duplicate = { ...fill.candidate, signalId: randomUUID(), reviewAttempt: 2, quoteAt: new Date().toISOString() };
    assert.equal(await store.claimSignal(owner, profile, duplicate), false, 'claim lock rejects another fill for the same trading day');
    // Simulate a previously approved duplicate that bypassed claim. The final order lock must still reject it.
    await db.insert(strategySignals).values({ ...fill, id: duplicate.signalId, orderId: null, state: 'approved', kind: 'entry:2', candidate: duplicate });
    const [reservation] = await db.select().from(strategyReservations).where(eq(strategyReservations.signalId, fill.id));
    await db.insert(strategyReservations).values({ ...reservation, id: randomUUID(), signalId: duplicate.signalId, status: 'active', expiresAt: new Date(Date.now() + 60000) });
    await assert.rejects(paper.placeOrder(owner, { ticker: 'AAPL', side: 'buy', quantity: 1, orderType: 'market' }, 'agent', undefined,
      true, true, profile, undefined, duplicate.signalId, applied.policy.accountId), /DAILY_EXECUTION_LIMIT/);
    await store.finishSignal(duplicate.signalId, 'cancelled', 'Fixture duplicate rejected');
    assert.equal((await db.select().from(paperOrders)).length, 1);
    await db.transaction(async tx => {
      await lockMemoryOwner(tx, owner);
      const [policy] = await tx.select().from(investmentPolicies).where(eq(investmentPolicies.id, applied.policy.id)).for('update');
      await installInvestorMandate(tx, owner, policy, policy.baseConfig.userStrategy!);
    });
    await configureCadence();
    t.mock.timers.tick(30000);
    await engine.tick(owner);
    assert.equal((await db.select().from(paperOrders)).length, 1, 'runtime replacement cannot replay a daily entry');
    t.mock.timers.setTime(Date.parse('2026-11-07T15:00:00Z'));
    await engine.tick(owner);
    assert.equal((await db.select().from(paperOrders)).length, 1, 'weekend is not another trading opportunity');
    t.mock.timers.setTime(Date.parse('2026-11-09T15:00:00Z'));
    const mondayProfile = (await builder.getActiveProfile(owner))!;
    assert.equal(await store.claimSignal(owner, mondayProfile, { ...duplicate, signalId: randomUUID() }), false, 'a prior trading-day plan cannot authorize a new day');
    const [mondayMandate] = await db.select().from(strategyMandates).where(eq(strategyMandates.status, 'published'));
    mondayMandate.config.rules = mondayMandate.config.rules.map(rule => ({ ...rule, security: { ...rule.security!, observedAt: new Date().toISOString() } }));
    await db.update(strategyMandates).set({ config: mondayMandate.config }).where(eq(strategyMandates.id, mondayMandate.id));
    const mondayPlan = await mandates.dailyPlan(owner, mondayProfile, mondayMandate, 'US', tradingMarketSchedule('US', new Date()));
    const mondayCandidate = { ...fill.candidate, signalId: randomUUID(), planId: mondayPlan.id, planVersion: mondayPlan.version,
      mandateId: mondayMandate.id, mandateVersion: mondayMandate.version, quoteAt: new Date().toISOString(), reviewAttempt: 1 };
    const concurrent = [mondayCandidate, { ...mondayCandidate, signalId: randomUUID(), reviewAttempt: 3 }];
    const claims = await Promise.all(concurrent.map(candidate => store.claimSignal(owner, mondayProfile, candidate)));
    assert.equal(claims.filter(Boolean).length, 1, 'the account lock permits only one live reservation for an entry');
    await store.finishSignal(concurrent[claims.indexOf(true)].signalId, 'wait', 'Fixture releases pending candidate');
    t.mock.timers.tick(31 * 60000);
    await engine.tick(owner);
    assert.equal((await db.select().from(paperOrders)).length, 2, JSON.stringify(await db.select().from(strategySignals)));
    const onceText = 'Buy 1 AAPL strictly below 100, once for this version';
    const once = await drafts.create(owner, { ...draft.content, body: onceText, entries: [{ ...draft.content.entries[0], text: onceText,
      directive: { ...draft.content.entries[0].directive!, executionFrequency: undefined, reviewedText: onceText } }] }, draft.id);
    const oncePreview = await drafts.preview(owner, once.id, once.revision);
    await policies.applyStrategy(owner, { strategyId: once.id, expectedRevision: once.revision, previewHash: oncePreview.preview!.contentHash,
      expectedCurrentId: draft.id, requestKey: randomUUID() });
    await configureCadence();
    await engine.tick(owner);
    assert.equal((await db.select().from(paperOrders)).length, 3);
    t.mock.timers.setTime(Date.parse('2026-11-10T15:00:00Z'));
    await engine.tick(owner);
    assert.equal((await db.select().from(paperOrders)).length, 3, 'missing legacy frequency continues to mean once across all trading days');
    assert.equal(calls, 0);
  });
});
