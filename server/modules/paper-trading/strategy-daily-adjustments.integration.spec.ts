import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { builderProfiles, paperAccounts } from '../../database/schema';
import { strategyMandates } from '../../database/strategy-mandates.schema';
import { strategyDailyAdjustments } from '../../database/strategy-daily-adjustments.schema';
import { ResearchDocumentsService } from '../research-documents/research-documents.service';
import { normalizeBuilderConfig } from './agent-builder.rules';
import { StrategyDailyAdjustments } from './strategy-daily-adjustments';
import { tradingMarketSchedule } from './trading-market.calendar';
import type { BuilderProfile } from '../../../shared/api.interface';
import type { StrategyMandateInput } from '../../../shared/strategy-mandate.interface';

test('bounded daily adjustments are claimed once and cannot outlive their authorization', { skip: !process.env.STRATEGY_TEST_DATABASE_URL }, async t => {
  const namespace = 'daily_adjust_test_' + randomUUID().replaceAll('-', '');
  const admin = postgres(process.env.STRATEGY_TEST_DATABASE_URL!, { max: 1, onnotice: () => undefined });
  const client = postgres(process.env.STRATEGY_TEST_DATABASE_URL!, { max: 8, onnotice: () => undefined, connection: { search_path: namespace } });
  await admin.unsafe('CREATE SCHEMA ' + namespace);
  try {
    await client.unsafe(readFileSync('scripts/db/01_schema.sql', 'utf8'));
    await client.unsafe(readFileSync('scripts/db/30_strategy_daily_adjustments.sql', 'utf8'));
    t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-05T15:30:00Z') });
    const db = drizzle(client); const docs = new ResearchDocumentsService(db);
    const fixture = async () => {
      const owner = randomUUID(); await client`INSERT INTO users(id, username, password_hash) VALUES(${owner}, ${owner.replaceAll('-', '')}, 'test-only')`;
      const config = normalizeBuilderConfig({ name: 'Daily fixture', template: 'balanced', tickers: ['AAPL'], minimumRating: 'Buy', customPrompt: '',
        maxOrderPct: 5, dailyLossLimitPct: 20, maxOrdersPerDay: 10, notifyOnProposal: false, language: 'en',
        council: { enabled: true, members: [{ id: 'r', name: 'Researcher', role: 'researcher', instructions: '', model: 'fast' }, { id: 'm', name: 'Manager', role: 'manager', instructions: '', model: 'slow' }] } });
      const [profileRow] = await db.insert(builderProfiles).values({ owner, config, status: 'active' }).returning();
      const profile: BuilderProfile = { id: profileRow.id, version: profileRow.version, status: 'active', config: profileRow.config,
        createdAt: profileRow.createdAt.toISOString(), updatedAt: profileRow.updatedAt.toISOString() };
      const [account] = await db.insert(paperAccounts).values({ owner, botEnabled: true, initialCash: '10000', cashBalance: '10000' }).returning();
      const report = await docs.submit(owner, { idempotencyKey: 'fixture', title: 'Fixed factual input', kind: 'deep', ticker: 'AAPL',
        content: 'Published bounded thesis', sections: [{ id: 'facts', title: 'Facts', content: 'Published bounded thesis' }],
        availableAt: '2026-11-04T20:00:00Z', dataAsOf: '2026-11-04T20:00:00Z' });
      const input: StrategyMandateInput = { title: 'Period rules', objective: 'Tighten only', period: 'month', timezone: 'America/New_York',
        startsAt: '2026-11-05T00:00:00Z', endsAt: '2026-11-30T23:00:00Z', accountId: account.id, profileId: profile.id, references: [{ versionId: report.id }], dailyPlanMode: 'bounded_ai',
        limits: { maxPositionPct: 20, maxDailyIncreasePct: 10, maxDailyTurnoverPct: 50 },
        routePolicy: { councilPositionCapRatio: 0.8, councilIncrementPct: 10, rollingWindowMinutes: 60, candidateTtlSeconds: 1200 },
        rules: [{ id: 'entry', ticker: 'AAPL', side: 'buy', trigger: { kind: 'price_below', value: 100 }, referencePrice: 100,
          minPrice: 90, maxPrice: 110, maxPositionPct: 20, stopLossPrice: 80, expiresAt: '2026-11-30T22:00:00Z', evidenceIds: [report.id], rationale: 'Published thesis' }] };
      const [mandate] = await db.insert(strategyMandates).values({ owner, accountId: account.id, profileId: profile.id, profileVersion: profile.version,
        status: 'published', config: input, publishedAt: new Date() }).returning();
      const schedule = () => tradingMarketSchedule('US', new Date());
      const market = { getSchedule: async () => schedule(), getSnapshot: async () => ({ ticker: 'AAPL', price: 100,
        quoteTimestamp: new Date().toISOString(), indicators: { sma20: 100, sma50: 100, rsi14: 45, atr14: 2, volumeRatio: 1.2, sampleSize: 60, asOf: '2026-11-04T21:00:00Z', timeframe: '1d' }, schedule: schedule() }) };
      const output = { rules: [{ id: 'entry', enabled: false, minPrice: 95, maxPrice: 105, maxPositionPct: 10, stopLossPrice: 85, reason: 'Await new evidence' }] };
      let calls = 0; let onModel = async (): Promise<unknown> => output;
      const model = { json: async (_owner: string, _member: unknown, taskId: string, purpose: string, prompt: string, shouldContinue: () => Promise<boolean>) => {
        calls++; assert.match(purpose, /daily-adjustment/u); assert.match(prompt, /Published bounded thesis/u);
        const [receipt] = await db.select().from(strategyDailyAdjustments).where(eq(strategyDailyAdjustments.id, taskId));
        assert.equal(receipt.state, 'pending'); assert.ok(receipt.input);
        assert.equal(await shouldContinue(), true);
        return onModel();
      } };
      const create = () => new StrategyDailyAdjustments(db, docs, model as never, market as never);
      return { owner, profile, account, report, mandate, output, schedule, create, calls: () => calls, model: (fn: () => Promise<unknown>) => { onModel = fn; },
        resolve: () => create().resolve(owner, profile, mandate, 'US', schedule()) };
    };

    await t.test('simultaneous workers and process restarts share one durable result, preserving suspended protection', async () => {
      const f = await fixture(); let started!: () => void; let release!: () => void;
      const ready = new Promise<void>(resolve => { started = resolve; }); const barrier = new Promise<void>(resolve => { release = resolve; });
      f.model(async () => { started(); await barrier; return f.output; });
      const first = f.resolve(); await ready;
      await assert.rejects(f.resolve(), /DAILY_AI_PENDING/u); assert.equal(f.calls(), 1);
      release(); const rules = await first;
      assert.equal(rules[0].dailySuspended, true); assert.equal(rules[0].stopLossPrice, 85);
      assert.deepEqual(rules[0].trigger, f.mandate.config.rules[0].trigger);
      assert.deepEqual(await f.resolve(), rules); assert.equal(f.calls(), 1);
      const [receipt] = await db.select().from(strategyDailyAdjustments).where(eq(strategyDailyAdjustments.owner, f.owner));
      assert.equal(receipt.state, 'succeeded'); assert.equal(receipt.rules?.[0].rationale, 'Published thesis');
    });

    await t.test('widened or missing output blocks the day without fallback, but the next trading day is a new request', async () => {
      const f = await fixture(); f.model(async () => ({ rules: [{ ...f.output.rules[0], maxPrice: 120 }] }));
      await assert.rejects(f.resolve(), /DAILY_AI_FAILED/u); await assert.rejects(f.resolve(), /DAILY_AI_FAILED/u); assert.equal(f.calls(), 1);
      let receipt = (await db.select().from(strategyDailyAdjustments).where(eq(strategyDailyAdjustments.owner, f.owner)))[0];
      assert.equal(receipt.state, 'failed'); assert.equal(receipt.rules, null);
      t.mock.timers.setTime(new Date('2026-11-06T15:30:00Z').getTime()); f.model(async () => f.output);
      assert.equal((await f.resolve())[0].maxPrice, 105); assert.equal(f.calls(), 2);
      t.mock.timers.setTime(new Date('2026-11-05T15:30:00Z').getTime());
      const missing = await fixture(); missing.model(async () => undefined);
      await assert.rejects(missing.resolve(), /DAILY_AI_FAILED/u); receipt = (await db.select().from(strategyDailyAdjustments).where(eq(strategyDailyAdjustments.owner, missing.owner)))[0];
      assert.equal(receipt.rules, null);
    });

    await t.test('ambiguous stale requests are never replayed and their late output cannot publish', async () => {
      const f = await fixture(); let started!: () => void; let release!: () => void;
      const ready = new Promise<void>(resolve => { started = resolve; }); const barrier = new Promise<void>(resolve => { release = resolve; });
      f.model(async () => { started(); await barrier; return f.output; });
      const first = assert.rejects(f.resolve(), /DAILY_AI_FAILED/u); await ready;
      t.mock.timers.tick(5 * 60_000 + 1);
      await assert.rejects(f.resolve(), /DAILY_AI_FAILED/u); assert.equal(f.calls(), 1);
      release(); await first;
      const [receipt] = await db.select().from(strategyDailyAdjustments).where(eq(strategyDailyAdjustments.owner, f.owner));
      assert.equal(receipt.state, 'failed'); assert.equal(receipt.rules, null);
    });

    await t.test('pausing, profile replacement, account disabling, and source revocation cancel in-flight output', async () => {
      for (const change of ['mandate', 'profile', 'account', 'source'] as const) {
        const f = await fixture();
        f.model(async () => {
          if (change === 'mandate') await db.update(strategyMandates).set({ status: 'paused' }).where(eq(strategyMandates.id, f.mandate.id));
          if (change === 'profile') await db.update(builderProfiles).set({ version: f.profile.version + 1 }).where(eq(builderProfiles.id, f.profile.id));
          if (change === 'account') await db.update(paperAccounts).set({ botEnabled: false }).where(eq(paperAccounts.id, f.account.id));
          if (change === 'source') await docs.revoke(f.owner, f.report.id, 'Fixture fact invalidated');
          return f.output;
        });
        await assert.rejects(f.resolve(), /DAILY_AI_FAILED/u);
        const [receipt] = await db.select().from(strategyDailyAdjustments).where(eq(strategyDailyAdjustments.owner, f.owner));
        assert.equal(receipt.state, 'failed', change); assert.equal(receipt.rules, null, change);
      }
    });

    await t.test('owner and calendar mismatches do not claim or dispatch a request', async () => {
      const f = await fixture();
      await assert.rejects(f.create().resolve(randomUUID(), f.profile, f.mandate, 'US', f.schedule()), /AUTHORIZATION_CHANGED/u);
      await assert.rejects(f.create().resolve(f.owner, f.profile, f.mandate, 'US', { ...f.schedule(), tradingDate: '2026-11-04' }), /MARKET_DAY_CHANGED/u);
      assert.equal(f.calls(), 0); assert.equal((await db.select().from(strategyDailyAdjustments).where(eq(strategyDailyAdjustments.owner, f.owner))).length, 0);
    });
  } finally {
    t.mock.timers.reset(); await client.end(); await admin.unsafe('DROP SCHEMA ' + namespace + ' CASCADE'); await admin.end();
  }
});
