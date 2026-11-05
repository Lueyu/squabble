import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { builderProfiles, paperAccounts, paperOrders } from '../../database/schema';
import { councilReports, councilSessions } from '../../database/council.schema';
import { strategyPlans, strategyProtections, strategySignals } from '../../database/strategy.schema';
import { strategyRouteReviews, strategyResearchAlerts } from '../../database/strategy-mandates.schema';
import { normalizeBuilderConfig } from './agent-builder.rules';
import { AgentBuilderService } from './agent-builder.service';
import { BuilderCadenceService } from './builder-cadence.service';
import { PaperTradingService } from './paper-trading.service';
import { StrategyStore } from './strategy.store';
import { StrategyService } from './strategy.service';
import { StrategyMandateService } from './strategy-mandate.service';
import { ResearchDocumentsService } from '../research-documents/research-documents.service';
import { tradingMarketSchedule } from './trading-market.calendar';
import type { TradingMarketSnapshot } from '../../../shared/trading-market.interface';
import type { StrategyMandateInput } from '../../../shared/strategy-mandate.interface';
import type { CouncilCandidate } from '../../../shared/council.interface';
import { paperRiskTimezone } from './paper-risk-day';

test('published reports drive account-bound direct/AI/council routes; replacement and revocation fence old work', {
  skip: !process.env.STRATEGY_TEST_DATABASE_URL,
}, async t => {
  const namespace = 'mandate_test_' + randomUUID().replaceAll('-', '');
  const admin = postgres(process.env.STRATEGY_TEST_DATABASE_URL!, { max: 1, onnotice: () => undefined });
  const client = postgres(process.env.STRATEGY_TEST_DATABASE_URL!, { max: 8, onnotice: () => undefined, connection: { search_path: namespace } });
  await admin.unsafe('CREATE SCHEMA ' + namespace);
  try {
    await client.unsafe(readFileSync('scripts/db/01_schema.sql', 'utf8'));
    t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-05T15:30:00Z') });
    const db = drizzle(client); const owner = randomUUID();
    await client`INSERT INTO users(id, username, password_hash) VALUES(${owner}, 'mandate-fixture', 'test-only')`;
    const config = normalizeBuilderConfig({ name: 'Fixture strategy', template: 'balanced', tickers: ['AAPL'],
      language: 'en', minimumRating: 'Buy', customPrompt: '', maxOrderPct: 2, dailyLossLimitPct: 20,
      maxOrdersPerDay: 20, notifyOnProposal: false, cadence: { reviewEveryTradingDays: 1, cooldownTradingDays: 0, maxOrdersPerWeek: 20, maxWeeklyTurnoverPct: 100 },
      council: { enabled: true, members: [{ id: 'researcher', role: 'researcher', name: 'Researcher', model: 'fast', instructions: '' },
        { id: 'manager', role: 'manager', name: 'Manager', model: 'slow', instructions: '' }] },
      automation: { enabled: true, preOpenMinutes: 60, monitorSeconds: 30, eventReplanCooldownMinutes: 120, maxEventReplansPerDay: 1, notifyClosingSummary: false } });
    const [profileRow] = await db.insert(builderProfiles).values({ owner, config, status: 'active' }).returning();
    const [account] = await db.insert(paperAccounts).values({ owner, botEnabled: true, initialCash: '10000', cashBalance: '10000',
      guardrails: { maxOrderPct: 2, dailyLossLimitPct: 20, maxOrdersPerDay: 20 } }).returning();
    let quotePrice = 100; let modelCalls = 0; let councilCalls = 0; let extractionCalls = 0;
    let started!: () => void; let release!: () => void;
    const startedExtraction = new Promise<void>(resolve => { started = resolve; });
    const pendingExtraction = new Promise<void>(resolve => { release = resolve; });
    let onModelReview: (() => Promise<void>) | undefined;
    const snapshot = (): TradingMarketSnapshot => ({ ticker: 'AAPL', providerSymbol: 'AAPL', market: 'US', currency: 'USD',
      usable: true, reason: null, quoteUsable: true, quoteReason: null, source: 'yahoo-chart', sourceUrl: 'https://example.invalid/fixture',
      fetchedAt: new Date().toISOString(), quoteTimestamp: new Date().toISOString(), price: quotePrice, delay: 'possibly-delayed',
      maxQuoteAgeSeconds: 1200, timeframe: '1d', candles: Array.from({ length: 20 }, () => ({
        timestamp: '2026-11-04T21:00:00Z', open: 100, high: 102, low: 98, close: 100, volume: 1000000,
      })), indicators: { sma20: 101, sma50: 102, rsi14: 30, atr14: 2,
        volumeRatio: 1.3, asOf: '2026-11-04T21:00:00Z', sampleSize: 60, timeframe: '1d' }, schedule: tradingMarketSchedule('US', new Date()) });
    const market = { getSnapshot: async () => snapshot(), getSchedule: async (m: 'US' | 'CN' | 'HK', now = new Date()) => tradingMarketSchedule(m, now) };
    const fx = { convert: async (v: number) => v };
    const quote = { getQuote: async () => ({ symbol: 'AAPL', price: String(quotePrice), market: 'US', currency: 'USD', timestamp: Date.now() }) };
    const model = { json: async (_o: string, _member: unknown, _id: string, _purpose: string, prompt: string) => {
      if (_purpose === 'period-strategy-draft') { extractionCalls++; started(); await pendingExtraction; return { rules: [] }; }
      modelCalls++; assert.match(prompt, /Pinned report evidence/); await onModelReview?.(); return { decision: 'approve', reason: 'Fixture review' };
    } };
    const council = { reviewCandidate: async (_o: string, _p: unknown, candidate: CouncilCandidate, context: { references: unknown[]; requireDeliberation: boolean }) => {
      councilCalls++; assert.equal(context.requireDeliberation, true); assert.equal(context.references.length, 1);
      const [session] = await db.insert(councilSessions).values({ owner, ticker: 'AAPL', status: 'completed', revision: 1,
        profileId: profileRow.id, profileVersion: 1, profileSnapshot: config, candidate }).returning();
      const [report] = await db.insert(councilReports).values({ owner, sessionId: session.id, version: 1, revision: 1, engine: 'llm',
        decision: 'approve', summary: 'Fixture council', candidate, dissent: [], nextReviewCondition: 'next quote', createdAt: new Date(),
        evidence: [{ id: 'fixture', title: 'Fictional evidence', content: 'Measured input', sourceUrl: null, fetchedAt: new Date().toISOString() }] }).returning();
      return { approved: true, reason: 'Fixture council', sessionId: session.id, reportId: report.id };
    } };
    const builder = new AgentBuilderService(db, { isConfigured: async () => true, validateConnectionIds: async () => undefined } as never);
    const paper = new PaperTradingService(db, quote as never, fx as never, { notifyUser: async () => undefined } as never,
      builder, new BuilderCadenceService(db), council as never, market as never);
    const docs = new ResearchDocumentsService(db);
    const report = await docs.submit(owner, { idempotencyKey: 'fixture-report', title: 'Fictional bounded research', kind: 'deep',
      ticker: 'AAPL', content: 'Buy only within a measured price band. Qualitative thesis requires review.',
      sections: [{ id: 'thesis', title: 'Thesis', content: 'Fictional bounded evidence' }],
      dataAsOf: new Date().toISOString(), availableAt: new Date().toISOString() });
    const mandates = new StrategyMandateService(db, docs, builder, model as never, market as never);
    const strategy = new StrategyService(db, builder, paper, council as never, market as never, model as never, new StrategyStore(db), fx as never, mandates);
    const base: StrategyMandateInput = { title: 'Fixture period', objective: 'Test bounded simulation', period: 'custom', timezone: 'America/New_York',
      startsAt: new Date().toISOString(), endsAt: '2026-11-06T20:00:00Z', accountId: account.id, profileId: profileRow.id,
      references: [{ versionId: report.id }], dailyPlanMode: 'fixed_rules',
      limits: { maxPositionPct: 50, maxDailyIncreasePct: 20, maxDailyTurnoverPct: 100 },
      routePolicy: { councilPositionCapRatio: 0.8, councilIncrementPct: 50, rollingWindowMinutes: 60, candidateTtlSeconds: 1200 },
      rules: [{ id: 'entry', ticker: 'AAPL', side: 'buy', trigger: { kind: 'price_below', value: 100 },
        referencePrice: 100, minPrice: 95, maxPrice: 105, maxPositionPct: 50, stopLossPrice: 90,
        expiresAt: '2026-11-06T20:00:00Z', evidenceIds: [report.id], rationale: 'Fictional threshold', reviewMode: 'deterministic' }] };
    const extracting = await mandates.create(owner, base);
    const extraction = mandates.extract(owner, extracting.id, extracting.revision);
    await startedExtraction;
    await assert.rejects(mandates.extract(owner, extracting.id, extracting.revision), /Draft changed|already owns/);
    const cancelled = await mandates.cancelExtraction(owner, extracting.id, extracting.revision + 1);
    release(); await assert.rejects(extraction, /cancelled|changed/);
    assert.equal(extractionCalls, 1, 'repeated clicks must not repeat paid extraction');
    assert.equal((await mandates.get(owner, extracting.id)).revision, cancelled.revision);
    const first = await mandates.create(owner, base);
    await assert.rejects(mandates.publish(owner, first.id, 99, null), /Draft changed/);
    await assert.rejects(mandates.get(randomUUID(), first.id), /not found/);
    await mandates.publish(owner, first.id, first.revision, null);
    await strategy.tick(owner);
    assert.equal(modelCalls, 0, 'deterministic low-risk rule must not call an AI');
    assert.equal(councilCalls, 0);
    assert.equal((await db.select().from(paperOrders)).filter(o => o.status === 'filled').length, 1);
    const oldPlan = (await db.select().from(strategyPlans))[0];
    const band = await mandates.create(owner, { ...base, rules: [{ ...base.rules[0], maxPrice: 100 }] }, first.id);
    await mandates.publish(owner, band.id, band.revision, first.id);
    await db.update(paperAccounts).set({ executionModel: { version: 'paper-v1', feeBps: 5, slippageBps: 10, corporateActions: 'unsupported' } }).where(eq(paperAccounts.id, account.id));
    t.mock.timers.tick(31000); await strategy.tick(owner);
    assert.equal((await db.select().from(paperOrders)).filter(o => o.status === 'filled').length, 1,
      'actual adverse fill price must remain inside the published entry band');
    await db.update(paperAccounts).set({ executionModel: { version: 'paper-v1', feeBps: 0, slippageBps: 0, corporateActions: 'unsupported' } }).where(eq(paperAccounts.id, account.id));
    const second = await mandates.create(owner, { ...base, rules: [{ ...base.rules[0], reviewMode: 'ai', semanticCondition: 'Verify earnings thesis' }] }, first.id);
    await assert.rejects(mandates.publish(owner, second.id, second.revision, null), /Published strategy changed/);
    await mandates.publish(owner, second.id, second.revision, band.id);
    assert.equal((await db.select().from(strategyPlans).where(eq(strategyPlans.id, oldPlan.id)))[0].status, 'superseded');
    t.mock.timers.tick(31000); await strategy.tick(owner);
    assert.equal(modelCalls, 1); assert.equal(councilCalls, 0);
    const third = await mandates.create(owner, { ...base, routePolicy: { ...base.routePolicy, councilIncrementPct: 1 } }, second.id);
    await mandates.publish(owner, third.id, third.revision, second.id);
    t.mock.timers.tick(31000); await strategy.tick(owner);
    assert.equal(councilCalls, 1, 'large accumulated exposure must go to Council even for a deterministic rule');
    assert.equal((await db.select().from(paperOrders)).filter(o => o.status === 'filled').length, 3,
      JSON.stringify({ orders: await db.select().from(paperOrders), signals: await db.select().from(strategySignals) }));
    assert.deepEqual((await db.select().from(strategyRouteReviews)).map(r => r.decision.route), ['direct', 'direct', 'ai', 'council']);
    assert.equal((await docs.view(owner, report.id)).document.strategyVersionIds[0], report.id);
    const fourth = await mandates.create(owner, { ...base, rules: [{ ...base.rules[0], reviewMode: 'ai', semanticCondition: 'Check latest evidence' }] }, third.id);
    await mandates.publish(owner, fourth.id, fourth.revision, third.id);
    onModelReview = async () => { quotePrice = 110; };
    t.mock.timers.tick(31000); await strategy.tick(owner);
    assert.equal((await db.select().from(paperOrders)).filter(o => o.status === 'filled').length, 3, 'slow approval cannot fill after the quote leaves its authorized range');
    quotePrice = 100;
    const replacement = await mandates.create(owner, { ...base, rules: [{ ...base.rules[0], reviewMode: 'ai', semanticCondition: 'Current evidence' }] }, fourth.id);
    await mandates.publish(owner, replacement.id, replacement.revision, fourth.id);
    const latest = await mandates.create(owner, replacement, replacement.id);
    onModelReview = async () => { await mandates.publish(owner, latest.id, latest.revision, replacement.id); };
    t.mock.timers.tick(91000); await strategy.tick(owner);
    assert.equal((await db.select().from(paperOrders)).filter(o => o.status === 'filled').length, 3, 'replacement during model review cancels the old candidate');
    onModelReview = () => docs.revoke(owner, report.id, 'Fixture fact retracted during review');
    t.mock.timers.tick(31000); await strategy.tick(owner);
    assert.equal((await db.select().from(paperOrders)).filter(o => o.status === 'filled').length, 3, 'revoked research cannot create new exposure');
    assert.ok((await db.select().from(strategySignals)).some(s => s.state === 'blocked'));
    await Promise.all([mandates.reviewInvalidSources(owner, await mandates.get(owner, latest.id), await builder.getProfile(owner, profileRow.id)),
      mandates.reviewInvalidSources(owner, await mandates.get(owner, latest.id), await builder.getProfile(owner, profileRow.id))]);
    const alerts = await db.select().from(strategyResearchAlerts);
    assert.equal(alerts.length, 1, 'one persistent re-research thread per invalid strategy rule');
    const [alertSession] = await db.select().from(councilSessions).where(eq(councilSessions.id, alerts[0].sessionId));
    assert.equal(alertSession.status, 'idle'); assert.equal(alertSession.candidate, null);
    assert.equal(alertSession.references[0].versionId, report.id);
    assert.equal((await mandates.workspace(owner, account.id)).items.find(item => item.id === latest.id)?.researchAlerts?.[0].sessionId, alertSession.id);
    assert.ok((await db.select().from(strategyProtections)).length > 0);
    await mandates.pause(owner, latest.id);
    assert.equal(await paperRiskTimezone(db, owner, account.id), 'America/New_York', 'pause must retain the experiment business day instead of resetting risk counters to UTC');
    assert.ok((await db.select().from(strategyProtections)).length > 0, 'pausing retains protective exits');
    quotePrice = 80;
    t.mock.timers.tick(31000); await strategy.tick(owner);
    assert.equal((await db.select().from(paperOrders)).filter(o => o.status === 'filled' && o.side === 'sell').length, 1, 'protection survives paused mandate and source revocation');
  } finally {
    t.mock.timers.reset(); await client.end(); await admin.unsafe('DROP SCHEMA ' + namespace + ' CASCADE'); await admin.end();
  }
});
