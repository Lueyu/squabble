import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { and, eq } from 'drizzle-orm';
import { paperAccounts, paperOrders, paperTrades } from '../../database/schema';
import { strategyMonitorState, strategyReviewJobs, strategyReservations, strategyMandates } from '../../database/strategy-mandates.schema';
import { strategySignals } from '../../database/strategy.schema';
import { researchDocumentVersions } from '../../database/research-documents.schema';
import { ResearchDocumentsService } from '../research-documents/research-documents.service';
import { StrategyMonitorService } from './strategy-monitor.service';

test('monitor recovers review jobs, records offline coverage, and releases expired risk without replaying fills', {
  skip: !process.env.STRATEGY_TEST_DATABASE_URL,
}, async t => {
  const namespace = 'monitor_test_' + randomUUID().replaceAll('-', '');
  const admin = postgres(process.env.STRATEGY_TEST_DATABASE_URL!, { max: 1, onnotice: () => undefined });
  const client = postgres(process.env.STRATEGY_TEST_DATABASE_URL!, { max: 6, onnotice: () => undefined, connection: { search_path: namespace } });
  await admin.unsafe('CREATE SCHEMA ' + namespace);
  try {
    await client.unsafe(readFileSync('scripts/db/01_schema.sql', 'utf8'));
    await client.unsafe(readFileSync('scripts/db/26_research_documents.sql', 'utf8'));
    t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-02-01T00:10:00Z') });
    const db = drizzle(client); const owner = randomUUID();
    await client`INSERT INTO users(id, username, password_hash) VALUES(${owner}, 'monitor-fixture', 'test-only')`;
    const account = async () => (await db.insert(paperAccounts).values({ owner, isActive: false, initialCash: '10000', cashBalance: '10000' }).returning())[0];
    const docs = new ResearchDocumentsService(db);
    let fail = false; let reviewCalls = 0;
    const experiments = { review: async (_owner: string, accountId: string, from: string, to: string) => {
      reviewCalls++; if (fail) throw new Error('Fixture transient review failure');
      return { accountId, from, to, orders: 0, gaps: ['PERIOD_END_SNAPSHOT_MISSING'], profitUsd: null, valuationAsOf: null };
    } };
    const monitor = new StrategyMonitorService(db, docs, experiments as never);

    await t.test('failed requests can retry and a completed period remains idempotent', async () => {
      const a = await account(); fail = true;
      await assert.rejects(monitor.archivePeriod(owner, a.id, '2026-01-30', '2026-01-30', 'daily'), /transient/iu);
      fail = false;
      const id = await monitor.archivePeriod(owner, a.id, '2026-01-30', '2026-01-30', 'daily');
      assert.ok(id);
      assert.equal(await monitor.archivePeriod(owner, a.id, '2026-01-30', '2026-01-30', 'daily'), id);
      assert.equal((await db.select().from(researchDocumentVersions).where(eq(researchDocumentVersions.idempotencyKey, `automatic-review:${a.id}:daily:2026-01-30:2026-01-30`))).length, 1);
    });

    await t.test('heartbeat retries stale leases and failed jobs even without a new date boundary', async () => {
      const a = await account();
      await db.insert(strategyMonitorState).values({ owner, accountId: a.id, lastHeartbeat: new Date() });
      await db.insert(strategyReviewJobs).values([
        { owner, accountId: a.id, key: `${a.id}:daily:2026-01-28:2026-01-28`, from: '2026-01-28', to: '2026-01-28', state: 'running', updatedAt: new Date('2026-01-31T12:00:00Z') },
        { owner, accountId: a.id, key: `${a.id}:daily:2026-01-29:2026-01-29`, from: '2026-01-29', to: '2026-01-29', state: 'failed' },
      ]);
      await monitor.heartbeat(owner, a.id);
      const jobs = await db.select().from(strategyReviewJobs).where(eq(strategyReviewJobs.accountId, a.id));
      assert.equal(jobs.length, 2);
      assert.ok(jobs.every(job => job.state === 'completed' && job.reportVersionId));
    });

    await t.test('a persisted document from an interrupted final write is recovered without recomputing its payload', async () => {
      const a = await account(); const key = `${a.id}:daily:2026-01-25:2026-01-25`;
      const saved = await docs.submit(owner, { idempotencyKey: 'automatic-review:' + key, title: 'Saved review', kind: 'council', content: 'Immutable result', sections: [{ id: 'result', title: 'Result', content: 'Immutable result' }] });
      await db.insert(strategyReviewJobs).values({ owner, accountId: a.id, key, from: '2026-01-25', to: '2026-01-25', state: 'failed' });
      const before = reviewCalls; fail = true;
      assert.equal(await monitor.archivePeriod(owner, a.id, '2026-01-25', '2026-01-25', 'daily'), saved.id);
      fail = false; assert.equal(reviewCalls, before);
    });

    await t.test('crossing day and month durably archives each closed date with offline gaps and no fictional fills', async () => {
      const a = await account();
      await db.insert(strategyMonitorState).values({ owner, accountId: a.id, lastHeartbeat: new Date('2026-01-30T23:50:00Z') });
      await monitor.heartbeat(owner, a.id);
      const jobs = await db.select().from(strategyReviewJobs).where(eq(strategyReviewJobs.accountId, a.id));
      assert.equal(jobs.length, 3, 'Jan 30, Jan 31 and January month are separate durable jobs');
      assert.ok(jobs.every(job => job.state === 'completed'));
      const state = await monitor.state(owner, a.id);
      assert.equal(state.gaps.length, 1);
      const version = await docs.getVersion(owner, jobs[0].reportVersionId!);
      assert.ok((version.snapshot?.monitorGaps as unknown[])?.length);
      assert.equal((await db.select().from(paperTrades).where(eq(paperTrades.accountId, a.id))).length, 0);
      await monitor.heartbeat(owner, a.id);
      assert.equal((await db.select().from(strategyReviewJobs).where(eq(strategyReviewJobs.accountId, a.id))).length, 3);
    });

    await t.test('fresh claims exclude concurrent workers and a stale worker cannot overwrite its replacement', async () => {
      const a = await account(); const original = experiments.review;
      let started!: () => void; let release!: () => void; let calls = 0;
      const ready = new Promise<void>(resolve => { started = resolve; });
      const barrier = new Promise<void>(resolve => { release = resolve; });
      experiments.review = async (...args) => {
        calls++;
        if (calls === 1) { started(); await barrier; throw new Error('Old worker failed after losing lease'); }
        return original(...args);
      };
      try {
        const first = assert.rejects(monitor.archivePeriod(owner, a.id, '2026-01-27', '2026-01-27', 'daily'), /Old worker/iu);
        await ready;
        const replacement = new StrategyMonitorService(db, docs, experiments as never);
        assert.equal(await replacement.archivePeriod(owner, a.id, '2026-01-27', '2026-01-27', 'daily'), null);
        assert.equal(calls, 1);
        t.mock.timers.tick(5 * 60_000 + 2);
        const report = await replacement.archivePeriod(owner, a.id, '2026-01-27', '2026-01-27', 'daily');
        assert.ok(report);
        release(); await first;
        const [job] = await db.select().from(strategyReviewJobs).where(eq(strategyReviewJobs.accountId, a.id));
        assert.equal(job.state, 'completed'); assert.equal(job.reportVersionId, report);
        assert.equal((await db.select().from(researchDocumentVersions).where(eq(researchDocumentVersions.idempotencyKey, `automatic-review:${a.id}:daily:2026-01-27:2026-01-27`))).length, 1);
      } finally { experiments.review = original; release?.(); }
    });

    await t.test('day and month boundaries follow the account mandate timezone and failures retain all queued periods', async () => {
      t.mock.timers.setTime(new Date('2026-02-01T00:10:00Z').getTime());
      const a = await account();
      await db.insert(strategyMandates).values({ owner, accountId: a.id, profileId: randomUUID(), profileVersion: 1, status: 'published', publishedAt: new Date(), config: { timezone: 'America/New_York' } as never });
      await db.insert(strategyMonitorState).values({ owner, accountId: a.id, lastHeartbeat: new Date('2026-01-31T23:50:00Z') });
      await monitor.heartbeat(owner, a.id);
      assert.equal((await db.select().from(strategyReviewJobs).where(eq(strategyReviewJobs.accountId, a.id))).length, 0);
      t.mock.timers.tick(5 * 60 * 60_000); fail = true;
      await monitor.heartbeat(owner, a.id);
      let jobs = await db.select().from(strategyReviewJobs).where(eq(strategyReviewJobs.accountId, a.id));
      assert.equal(jobs.length, 2); assert.ok(jobs.every(job => job.state === 'failed'));
      fail = false;
      await monitor.heartbeat(owner, a.id);
      jobs = await db.select().from(strategyReviewJobs).where(eq(strategyReviewJobs.accountId, a.id));
      assert.ok(jobs.every(job => job.state === 'completed'));
      assert.equal(jobs.find(job => job.key.includes(':daily:'))?.from, '2026-01-31');
    });

    await t.test('expired signals release reservations and cancel only their pending approval order', async () => {
      const a = await account(); const signalId = randomUUID();
      const [order] = await db.insert(paperOrders).values({ owner, accountId: a.id, ticker: 'AAPL', side: 'buy', quantity: '1', orderType: 'market', status: 'pending_approval' }).returning();
      await db.insert(strategySignals).values({ id: signalId, owner, profileId: randomUUID(), planId: randomUUID(), ruleId: 'expired', kind: 'entry', state: 'reviewing', reason: 'pending', orderId: order.id,
        candidate: { signalId, accountId: a.id, ticker: 'AAPL', quoteAt: '2026-01-31T20:00:00Z' } as never });
      await db.insert(strategyReservations).values({ signalId, owner, accountId: a.id, ticker: 'AAPL', side: 'buy', currency: 'USD', cash: '100', shares: '0', expiresAt: new Date('2026-01-31T20:20:00Z') });
      await monitor.heartbeat(owner, a.id);
      assert.equal((await db.select().from(strategySignals).where(eq(strategySignals.id, signalId)))[0].state, 'expired');
      assert.equal((await db.select().from(strategyReservations).where(eq(strategyReservations.signalId, signalId)))[0].status, 'released');
      assert.equal((await db.select().from(paperOrders).where(eq(paperOrders.id, order.id)))[0].status, 'cancelled');
      await assert.rejects(monitor.heartbeat(randomUUID(), a.id), /not found/iu);
      assert.equal((await db.select().from(strategyMonitorState).where(and(eq(strategyMonitorState.accountId, a.id), eq(strategyMonitorState.owner, owner)))).length, 1);
    });
  } finally {
    t.mock.timers.reset(); await client.end(); await admin.unsafe('DROP SCHEMA ' + namespace + ' CASCADE'); await admin.end();
  }
});
