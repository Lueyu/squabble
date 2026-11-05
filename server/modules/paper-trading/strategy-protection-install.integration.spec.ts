import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { builderProfiles, paperAccounts, paperPositions } from '../../database/schema';
import { strategyPlans, strategyProtections } from '../../database/strategy.schema';
import { strategyMandates } from '../../database/strategy-mandates.schema';
import { ResearchDocumentsService } from '../research-documents/research-documents.service';
import { StrategyService } from './strategy.service';
import { StrategyStore } from './strategy.store';
import { StrategyMandateService } from './strategy-mandate.service';
import { AgentBuilderService } from './agent-builder.service';
import { normalizeBuilderConfig } from './agent-builder.rules';
import { tradingMarketSchedule } from './trading-market.calendar';
import type { BuilderProfile } from '../../../shared/api.interface';
import type { StrategyMandateInput } from '../../../shared/strategy-mandate.interface';

test('published protective stops are independent of daily AI success and survive period entry changes', { skip: !process.env.STRATEGY_TEST_DATABASE_URL }, async t => {
  const namespace = 'protection_install_' + randomUUID().replaceAll('-', '');
  const admin = postgres(process.env.STRATEGY_TEST_DATABASE_URL!, { max: 1, onnotice: () => undefined });
  const client = postgres(process.env.STRATEGY_TEST_DATABASE_URL!, { max: 6, onnotice: () => undefined, connection: { search_path: namespace } });
  await admin.unsafe('CREATE SCHEMA ' + namespace);
  try {
    await client.unsafe(readFileSync('scripts/db/01_schema.sql', 'utf8'));
    await client.unsafe(readFileSync('scripts/db/30_strategy_daily_adjustments.sql', 'utf8'));
    t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-05T15:30:00Z') });
    const db = drizzle(client); const owner = randomUUID();
    await client`INSERT INTO users(id, username, password_hash) VALUES(${owner}, 'protection-fixture', 'test-only')`;
    const config = normalizeBuilderConfig({ name: 'Protection fixture', template: 'balanced', tickers: ['AAPL'], minimumRating: 'Buy', customPrompt: '',
      maxOrderPct: 5, dailyLossLimitPct: 20, maxOrdersPerDay: 10, notifyOnProposal: false, language: 'en',
      automation: { enabled: true, preOpenMinutes: 60, monitorSeconds: 30, eventReplanCooldownMinutes: 120, maxEventReplansPerDay: 1, notifyClosingSummary: false },
      council: { enabled: true, members: [{ id: 'r', name: 'Researcher', role: 'researcher', instructions: '', model: 'fast' }, { id: 'm', name: 'Manager', role: 'manager', instructions: '', model: 'slow' }] } });
    const [row] = await db.insert(builderProfiles).values({ owner, config, status: 'active' }).returning();
    const profile: BuilderProfile = { id: row.id, version: row.version, status: 'active', config: row.config, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
    const [account] = await db.insert(paperAccounts).values({ owner, botEnabled: true, initialCash: '10000', cashBalance: '10000' }).returning();
    const docs = new ResearchDocumentsService(db); const builder = new AgentBuilderService(db, { isConfigured: async () => true, validateConnectionIds: async () => undefined } as never);
    const report = await docs.submit(owner, { idempotencyKey: 'facts', title: 'Fixed report', kind: 'deep', ticker: 'AAPL', content: 'Fixed facts',
      sections: [{ id: 'facts', title: 'Facts', content: 'Fixed facts' }], availableAt: '2026-11-04T00:00:00Z' });
    let calls = 0;
    const model = { json: async () => { calls++; throw new Error('No model available'); } };
    const market = { getSchedule: async () => tradingMarketSchedule('US', new Date()), getSnapshot: async () => ({ ticker: 'AAPL', price: 100,
      quoteTimestamp: new Date().toISOString(), indicators: { sma20: 100, sampleSize: 60 } }) };
    const mandates = new StrategyMandateService(db, docs, builder, model as never, market as never);
    const base: StrategyMandateInput = { title: 'Protection', objective: 'Keep authorized stops independent', period: 'month', timezone: 'America/New_York',
      startsAt: '2026-11-05T00:00:00Z', endsAt: '2026-11-30T23:00:00Z', accountId: account.id, profileId: profile.id, references: [{ versionId: report.id }], dailyPlanMode: 'bounded_ai',
      limits: { maxPositionPct: 20, maxDailyIncreasePct: 10, maxDailyTurnoverPct: 50 },
      routePolicy: { councilPositionCapRatio: 0.8, councilIncrementPct: 10, rollingWindowMinutes: 60, candidateTtlSeconds: 1200 },
      rules: [{ id: 'entry', ticker: 'AAPL', side: 'buy', trigger: { kind: 'price_below', value: 100 }, referencePrice: 100, minPrice: 95, maxPrice: 105,
        maxPositionPct: 20, stopLossPrice: 90, expiresAt: '2026-11-30T22:00:00Z', evidenceIds: [report.id], rationale: 'Authorized stop' }] };

    const first = await mandates.create(owner, base); await mandates.publish(owner, first.id, first.revision, null);
    assert.equal((await db.select().from(strategyProtections)).length, 0, 'no holding creates no protection plan');
    assert.equal((await db.select().from(strategyPlans)).length, 0);
    await db.insert(paperPositions).values({ owner, accountId: account.id, ticker: 'AAPL', shares: '10', avgCost: '100' });
    const second = await mandates.create(owner, base, first.id); await mandates.publish(owner, second.id, second.revision, first.id);
    let [protection] = await db.select().from(strategyProtections);
    assert.ok(protection, 'publication installs the base stop before a model request'); assert.equal(calls, 0);
    const original = { id: protection.id, planId: protection.planId, version: protection.version };
    const [plan] = await db.select().from(strategyPlans).where(eq(strategyPlans.id, protection.planId));
    assert.equal(plan.status, 'protection'); assert.equal(plan.rules[0].stopLossPrice, 90);
    await assert.rejects(mandates.dailyPlan(owner, profile, await mandates.get(owner, second.id), 'US', tradingMarketSchedule('US', new Date())), /DAILY_AI_FAILED/u);
    assert.equal(calls, 1); assert.equal((await db.select().from(strategyProtections))[0].planId, original.planId);
    const strategy = new StrategyService(db, builder, {} as never, {} as never, market as never, model as never, new StrategyStore(db), {} as never, mandates);
    const runtime = await strategy.tick(owner);
    assert.match(runtime!.markets[0].reason, /AI adjustment failed/u);
    assert.equal(calls, 1, 'a failed daily request is not replayed by tick');
    await mandates.installCurrentProtections(owner, profile); await mandates.installCurrentProtections(owner, profile);
    [protection] = await db.select().from(strategyProtections); assert.equal(protection.version, original.version); assert.equal(protection.planId, original.planId);
    await mandates.pause(owner, second.id);
    assert.equal((await db.select().from(strategyPlans).where(eq(strategyPlans.id, original.planId)))[0].status, 'protection');

    const looser = await mandates.create(owner, { ...base, dailyPlanMode: 'fixed_rules', rules: [{ ...base.rules[0], stopLossPrice: 85 }] }, second.id);
    await mandates.publish(owner, looser.id, looser.revision, null);
    await mandates.dailyPlan(owner, profile, await mandates.get(owner, looser.id), 'US', tradingMarketSchedule('US', new Date()));
    [protection] = await db.select().from(strategyProtections);
    assert.equal(Number(protection.stopLossPrice), 90); assert.equal(protection.version, original.version); assert.equal(protection.planId, original.planId);

    const future = await mandates.create(owner, { ...base, startsAt: '2026-11-06T00:00:00Z', rules: [{ ...base.rules[0], stopLossPrice: 92 }] }, looser.id);
    await mandates.publish(owner, future.id, future.revision, looser.id);
    assert.equal(Number((await db.select().from(strategyProtections))[0].stopLossPrice), 90);
    t.mock.timers.setTime(new Date('2026-11-06T15:30:00Z').getTime());
    await mandates.installCurrentProtections(owner, profile);
    [protection] = await db.select().from(strategyProtections);
    assert.equal(Number(protection.stopLossPrice), 92); assert.equal(protection.version, original.version + 1); assert.notEqual(protection.planId, original.planId);
    const latestPlan = protection.planId;
    await mandates.installCurrentProtections(owner, profile);
    assert.equal((await db.select().from(strategyProtections))[0].version, original.version + 1);
    await db.update(strategyMandates).set({ status: 'expired' }).where(eq(strategyMandates.id, future.id));
    await mandates.installCurrentProtections(owner, profile);
    assert.equal((await db.select().from(strategyProtections))[0].planId, latestPlan);
    assert.equal(calls, 1, 'installing protection never calls a model');
  } finally {
    t.mock.timers.reset(); await client.end(); await admin.unsafe('DROP SCHEMA ' + namespace + ' CASCADE'); await admin.end();
  }
});
