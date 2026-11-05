import { councilReports, councilSessions } from '../../database/council.schema';
import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { builderProfiles, paperAccounts, paperOrders, paperPositions } from '../../database/schema';
import { strategyOutbox, strategyPlans, strategyProtections, strategySignals, strategyTasks } from '../../database/strategy.schema';
import { normalizeBuilderConfig } from './agent-builder.rules';
import { AgentBuilderService } from './agent-builder.service';
import { BuilderCadenceService } from './builder-cadence.service';
import { PaperTradingService } from './paper-trading.service';
import { StrategyStore } from './strategy.store';
import { StrategyService } from './strategy.service';
import { StrategyNotificationsService } from './strategy-notifications.service';
import { tradingMarketSchedule } from './trading-market.calendar';
import type { TradingMarketSnapshot } from '../../../shared/trading-market.interface';
import type { CouncilSession } from '../../../shared/council.interface';

test('daily discussion publishes validated plan, monitor reviews once, atomic fill and delivery retry never reorder', {
  skip: !process.env.STRATEGY_TEST_DATABASE_URL,
}, async (t) => {
  const uri = process.env.STRATEGY_TEST_DATABASE_URL!;
  const namespace = `strategy_test_${randomUUID().replaceAll('-', '')}`;
  const admin = postgres(uri, { max: 1, onnotice: () => undefined });
  const client = postgres(uri, { max: 8, onnotice: () => undefined, connection: { search_path: namespace } });
  const owner = randomUUID();
  let initialized = false;
  try {
    await admin`CREATE SCHEMA ${admin(namespace)}`; initialized = true;
    for (const name of ['01_schema', '03_agent_builder', '08_investment_council', '09_builder_cadence', '12_council_dialogue', '16_daily_strategy', '17_research_memory', '18_research_workflow', '19_atomic_research_theses', '20_research_memory_temporal', '21_research_archive_jobs', '22_research_monitors']) {
      await client.unsafe(readFileSync(`scripts/db/${name}.sql`, 'utf8'));
    }
    await client`INSERT INTO users(id, username, password_hash) VALUES(${owner}, 'strategy-test', 'test-only')`;
    t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-03T13:00:00Z') });
    const db = drizzle(client);
    const config = normalizeBuilderConfig({ name: 'Automatic paper', template: 'balanced', tickers: ['AAPL'], minimumRating: 'Buy',
      customPrompt: '', language: 'en', maxOrderPct: 5, dailyLossLimitPct: 20, maxOrdersPerDay: 20, notifyOnProposal: true,
      council: { enabled: true, members: [
        { id: 'researcher', role: 'researcher', name: 'R', instructions: '', model: 'fast' },
        { id: 'manager', role: 'manager', name: 'M', instructions: '', model: 'slow' },
      ] }, cadence: { reviewEveryTradingDays: 1, cooldownTradingDays: 0, maxOrdersPerWeek: 20, maxWeeklyTurnoverPct: 100 },
      automation: { enabled: true, preOpenMinutes: 60, monitorSeconds: 60, maxEventReplansPerDay: 1,
        eventReplanCooldownMinutes: 120, notifyClosingSummary: false } });
    const [row] = await db.insert(builderProfiles).values({ owner, config, status: 'active' }).returning();
    const [account] = await db.insert(paperAccounts).values({ owner, botEnabled: true, initialCash: '10000', cashBalance: '10000',
      guardrails: { maxOrderPct: 5, dailyLossLimitPct: 20, maxOrdersPerDay: 20 } }).returning();
    let price = 100;
    let refreshedPrice: number | undefined;
    let reviewDecision = 'approve';
    let modelCalls = 0;
    let researchCalls = 0;
    let refreshCalls = 0;
    let historyUsable = true;
    let finalQuoteUsable = true;
    const snapshots = (): TradingMarketSnapshot => ({ ticker: 'AAPL', providerSymbol: 'AAPL', market: 'US', currency: 'USD',
      usable: historyUsable, reason: historyUsable ? null : 'history_insufficient', quoteUsable: true, quoteReason: null,
      source: 'yahoo-chart', sourceUrl: 'https://example.invalid/evidence', fetchedAt: new Date().toISOString(),
      quoteTimestamp: new Date().toISOString(), price, delay: 'possibly-delayed', maxQuoteAgeSeconds: 1200, timeframe: '1d', candles: [],
      indicators: historyUsable ? { sma20: 101, sma50: 102, rsi14: 30, atr14: 2, volumeRatio: 1.3, asOf: '2026-11-02T21:00:00Z', sampleSize: 60, timeframe: '1d' } : null,
      schedule: tradingMarketSchedule('US', new Date()) });
    const market = { getSchedule: async (marketName: 'US' | 'HK' | 'CN', now = new Date()) => tradingMarketSchedule(marketName, now),
      getSnapshot: async (_ticker: string, _now?: Date, force?: boolean) => { if (force) refreshCalls += 1;
        return { ...snapshots(), quoteUsable: force ? finalQuoteUsable : true,
          price: force && refreshedPrice !== undefined ? refreshedPrice : price }; } };
    const quote = { getQuote: async () => ({ symbol: 'AAPL', price: String(price), market: 'US', currency: 'USD', timestamp: Date.now() }) };
    const fx = { convert: async (value: number) => value };
    const sessions = new Map<string, CouncilSession>();
    const council = { createSession: async () => {
      const id = randomUUID(); const reportId = randomUUID();
      const session: CouncilSession = { id, profileId: row.id, profileVersion: 1, ticker: 'AAPL', language: 'en', status: 'idle', revision: 1,
        messages: [], reports: [{ id: reportId, version: 1, revision: 1, decision: 'wait', summary: 'Measured oversold condition requires bounded entry',
          dissent: [], nextReviewCondition: 'price bounds', evidence: [{ id: 'verified-price', title: 'Market price', content: 'Daily data confirms RSI30', sourceUrl: null,
            fetchedAt: new Date().toISOString() }], sourceRunId: null, candidate: null, paperOrderId: null, tokensUsed: 100, engine: 'llm', createdAt: new Date().toISOString() }],
        error: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      await db.insert(councilSessions).values({ id, owner, profileId: row.id, profileVersion: 1, profileSnapshot: config, ticker: 'AAPL', language: 'en', status: 'completed' });
      const report = session.reports[0];
      await db.insert(councilReports).values({ ...report, owner, sessionId: id, createdAt: new Date(report.createdAt) });
      sessions.set(id, session); return session;
    }, addMessage: async () => undefined, runSession: async (_owner: string, id: string) => { researchCalls += 1; sessions.get(id)!.status = 'completed'; },
    getSession: async (_owner: string, id: string) => sessions.get(id)!, pauseSession: async () => undefined };
    const builder = new AgentBuilderService(db, { isConfigured: async () => true, validateConnectionIds: async () => undefined } as never);
    const paper = new PaperTradingService(db, quote as never, fx as never, {} as never, builder,
      new BuilderCadenceService(db), council as never, market as never);
    const store = new StrategyStore(db);
    const rule = { id: 'entry', ticker: 'AAPL', side: 'buy' as const, trigger: { kind: 'rsi14_below' as const, value: 35 },
      referencePrice: 100, minPrice: 95, maxPrice: 105, maxPositionPct: 5, stopLossPrice: 90,
      expiresAt: '2026-11-03T21:00:00.000Z', evidenceIds: ['verified-price'], rationale: 'Measured oversold' };
    const model = { json: async (_owner: string, _member: unknown, _task: string, purpose: string, prompt: string) => {
      modelCalls += 1; assert.ok(Buffer.byteLength(prompt) < 6000);
      return purpose === 'daily-strategy-plan' ? { summary: 'Bounded daily paper plan', rules: [rule] }
        : { decision: reviewDecision, reason: 'Immutable candidate checked' };
    } };
    const strategy = new StrategyService(db, builder, paper, council as never, market as never, model as never, store, fx as never);
    await strategy.tick(owner);
    assert.equal(researchCalls, 0, 'daily work does not run earlier than the configured pre-open window');
    t.mock.timers.tick(31 * 60000); await strategy.tick(owner);
    assert.equal(researchCalls, 1);
    assert.equal(modelCalls, 0);
    t.mock.timers.tick(61000);
    await strategy.tick(owner);
    assert.equal(modelCalls, 1, 'pre-open publishes a plan without reviewing or executing an order');
    assert.equal((await db.select().from(paperOrders)).length, 0);
    t.mock.timers.tick(60 * 60000); await strategy.tick(owner);
    assert.equal(modelCalls, 2);
    assert.equal(refreshCalls, 1);
    assert.equal((await db.select().from(strategyPlans)).length, 1);
    const orders = await db.select().from(paperOrders);
    assert.equal(orders.length, 1); assert.equal(orders[0].status, 'filled');
    assert.equal(Number(orders[0].quantity), 5);
    assert.equal((await db.select().from(strategySignals))[0].state, 'filled');
    assert.equal((await db.select().from(strategyOutbox)).length, 2);
    for (let index = 0; index < 3; index += 1) { t.mock.timers.tick(61000); await strategy.tick(owner); }
    assert.equal(modelCalls, 2); assert.equal((await db.select().from(paperOrders)).length, 1);
    let deliveries = 0;
    const outbox = new StrategyNotificationsService(store, { deliverWithAcknowledgment: async () => {
      deliveries += 1; return { ok: deliveries > 2, deliveredChannelIds: deliveries > 2 ? ['channel'] : [] };
    } } as never);
    await db.update(strategyOutbox).set({ availableAt: new Date(0) });
    await outbox.tick(); t.mock.timers.tick(61000); await outbox.tick();
    assert.equal((await db.select().from(paperOrders)).length, 1);
    assert.ok(deliveries >= 4);
    assert.equal((await store.runtime(owner, await builder.getProfile(owner, row.id))).notification.failed, 0);

    // A new valid plan can review again, but a moved final quote must stop its immutable candidate.
    const oldPlan = (await db.select().from(strategyPlans))[0];
    const task = await store.claimTask(owner, await builder.getProfile(owner, row.id), 'US', '2026-11-03', 1);
    assert.ok(task);
    await store.publish({ ...task, sessionIds: oldPlan.sessionIds }, [{ ...rule, maxPositionPct: 10 }], oldPlan.reportIds, 'Test plan', new Date(rule.expiresAt));
    await db.update(paperPositions).set({ shares: '1' }).where(eq(paperPositions.accountId, account.id));
    refreshedPrice = 102;
    t.mock.timers.tick(61000); await strategy.tick(owner);
    assert.equal((await db.select().from(paperOrders)).length, 1);
    assert.equal((await db.select().from(strategySignals)).filter((signal) => signal.state === 'blocked').length, 1);
    // Restart retains paid-work claims; it cannot replay a review or discussion.
    const restarted = new StrategyService(db, builder, paper, council as never, market as never, model as never, store, fx as never);
    let paidBefore = modelCalls; t.mock.timers.tick(61000); await restarted.tick(owner);
    assert.equal(modelCalls, paidBefore); assert.equal(researchCalls, 1);
    // Account settings cannot loosen the investor profile's daily cap.
    const strictConfig = { ...config, maxOrdersPerDay: 1, dailyLossLimitPct: 1,
      cadence: { ...config.cadence!, cooldownTradingDays: 3 } };
    await db.update(builderProfiles).set({ config: strictConfig }).where(eq(builderProfiles.id, row.id));
    const capTask = await store.claimTask(owner, await builder.getProfile(owner, row.id), 'US', '2026-11-03', 2);
    assert.ok(capTask);
    await store.publish({ ...capTask, sessionIds: oldPlan.sessionIds }, [{ ...rule, id: 'cap-entry', maxPositionPct: 10 }], oldPlan.reportIds,
      'Test stricter profile cap', new Date(rule.expiresAt));
    refreshedPrice = 100;
    t.mock.timers.tick(61000); await restarted.tick(owner);
    assert.equal((await db.select().from(paperOrders)).filter((order) => order.status === 'filled').length, 1);
    assert.equal((await db.select().from(paperOrders)).filter((order) => order.status === 'rejected_risk').length, 1);
    // Persisted position protection survives expired/superseded plans, missing indicators,
    // a breached loss gate and exhausted entry caps; a bad final quote still blocks it.
    await db.update(strategyPlans).set({ expiresAt: new Date(Date.now() - 1) });
    await db.update(paperAccounts).set({ cashBalance: '100' }).where(eq(paperAccounts.id, account.id));
    historyUsable = false;
    price = 89; refreshedPrice = 89; reviewDecision = 'veto';
    paidBefore = modelCalls;
    finalQuoteUsable = false;
    t.mock.timers.tick(61000); await restarted.tick(owner);
    assert.equal(modelCalls, paidBefore);
    assert.equal((await db.select().from(paperOrders)).filter((order) => order.side === 'sell').length, 0);
    finalQuoteUsable = true;
    t.mock.timers.tick(61000); await restarted.tick(owner);
    assert.equal(modelCalls, paidBefore);
    assert.equal((await db.select().from(paperOrders)).find((order) => order.side === 'sell')?.status, 'filled');
    assert.equal((await db.select().from(strategyProtections)).length, 0);
    assert.equal((await db.select().from(strategyTasks)).length, 3);
    // Manual full liquidation also clears protection before a later manual re-entry.
    await paper.placeOrder(owner, { ticker: 'AAPL', side: 'buy', quantity: 1 }, 'manual', undefined, true);
    await db.insert(strategyProtections).values({ owner, accountId: account.id, ticker: 'AAPL', market: 'US',
      stopLossPrice: '90', planId: oldPlan.id, ruleId: rule.id });
    await paper.placeOrder(owner, { ticker: 'AAPL', side: 'sell', quantity: 1 }, 'manual', undefined, true);
    assert.equal((await db.select().from(strategyProtections)).length, 0);
    await paper.placeOrder(owner, { ticker: 'AAPL', side: 'buy', quantity: 1 }, 'manual', undefined, true);
    const orderCount = (await db.select().from(paperOrders)).length;
    t.mock.timers.tick(61000); await restarted.tick(owner);
    assert.equal((await db.select().from(paperOrders)).length, orderCount);
    // A pause invalidates prior work even if the same profile is reactivated later.
    const paused = await builder.pauseProfile(owner, row.id);
    assert.equal(paused.version, 2); assert.equal(paused.status, 'paused');
    const reactivated = await builder.activateProfile(owner, row.id);
    assert.equal(reactivated.version, 2);
    assert.equal((await builder.activateProfile(owner, row.id)).version, 2, 'repeat activation is idempotent');
    // A fresh profile version cannot reuse a still-unfilled old-plan signal.
    // Keep its quote inside the entry band to isolate the expired-plan/version fence.
    price = 100; refreshedPrice = 100;
    const oldCandidate = { signalId: randomUUID(), planId: oldPlan.id, planVersion: oldPlan.version, ruleId: rule.id,
      ticker: 'AAPL', market: 'US' as const, side: 'buy' as const, quantity: 1, price, quoteAt: new Date().toISOString(),
      protectiveStop: false, reviewAttempt: 3, reason: 'old work' };
    assert.equal(await store.claimSignal(owner, reactivated, oldCandidate), true);
    await store.finishSignal(oldCandidate.signalId, 'approved', 'old review');
    historyUsable = true;
    await assert.rejects(paper.placeOrder(owner, { ticker: 'AAPL', side: 'buy', quantity: 1 }, 'agent', undefined, true, true,
      reactivated, undefined, oldCandidate.signalId), /expired|superseded|price moved/u);
    // Independent replicas race for the same immutable signal; only one owns the paid call.
    const probe = { ...oldCandidate, signalId: randomUUID(), planId: randomUUID(), ruleId: 'retry-probe', reviewAttempt: 1 };
    const claims = await Promise.all([store.claimSignal(owner, reactivated, probe),
      store.claimSignal(owner, reactivated, { ...probe, signalId: randomUUID() })]);
    assert.deepEqual(claims.sort(), [false, true]);
    const [claimedProbe] = (await db.select().from(strategySignals)).filter((signal) => signal.planId === probe.planId);
    await store.finishSignal(claimedProbe.id, 'wait', 'Wait for fresh market evidence');
    assert.equal(await store.nextReviewAttempt(owner, probe.planId, probe.ruleId, new Date().toISOString()), null);
    t.mock.timers.tick(31 * 60000);
    assert.equal(await store.nextReviewAttempt(owner, probe.planId, probe.ruleId, probe.quoteAt), null, 'same quote cannot re-trigger paid review');
    assert.equal(await store.nextReviewAttempt(owner, probe.planId, probe.ruleId, new Date().toISOString()), 2);
    const secondProbe = { ...probe, signalId: randomUUID(), quoteAt: new Date().toISOString(), reviewAttempt: 2 };
    assert.equal(await store.claimSignal(owner, reactivated, secondProbe), true);
    await store.finishSignal(secondProbe.signalId, 'veto', 'Veto stays final');
    t.mock.timers.tick(31 * 60000);
    assert.equal(await store.nextReviewAttempt(owner, probe.planId, probe.ruleId, new Date().toISOString()), null);
    await paper.resetAccount(owner);
    assert.equal((await builder.getProfile(owner, row.id)).version, 3);
    assert.equal((await db.select().from(strategyProtections)).length, 0);
  } finally {
    t.mock.timers.reset(); await client.end();
    if (initialized) await admin`DROP SCHEMA ${admin(namespace)} CASCADE`;
    await admin.end();
  }
});
