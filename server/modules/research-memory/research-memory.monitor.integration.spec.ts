import { monitorFixture, seedMonitor } from './research-memory.monitor.fixtures';
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { councilReports, councilSessions } from '../../database/council.schema';
import { builderProfiles, paperAccounts } from '../../database/schema';
import { researchMonitorEvents, researchMonitorRules } from '../../database/research-monitor.schema';
import { researchMemoryEvidence } from '../../database/research-memory.schema';
import { normalizeEvidenceMetadata } from './research-memory.temporal';
import { strategyOutbox } from '../../database/strategy.schema';
import { ResearchMonitorService } from './research-memory.monitor.service';
import { captureStrategyMemory, strategyMemoryBlock } from './research-memory.dependencies';
import { lockMemoryOwner } from './research-memory.fence';
import { emptyTradingSnapshot } from '../paper-trading/trading-market.source';
import { resolveTradingTicker } from '@shared/trading-market.interface';
import { createDatabase } from '../../common/platform/database.provider';
import type postgres from 'postgres';

test('monitor migration is installed by production startup', { skip: !process.env.MEMORY_TEST_DATABASE_URL }, async () => {
  await monitorFixture(async (_db, client) => {
    assert.equal((await client`SELECT to_regclass('research_monitor_events')::text AS name`)[0].name, 'research_monitor_events');
    assert.equal((await client`SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema()
      AND table_name = 'strategy_plans' AND column_name = 'memory_inventory'`).length, 1);
    assert.equal((await client`SELECT sequence FROM research_monitor_events`).length, 0);
  });
});

test('production startup upgrades populated migration22 observations without rewriting history and reapplies after recovery', {
  skip: !process.env.MEMORY_TEST_DATABASE_URL,
}, async () => monitorFixture(async (db, client, owner) => {
  const f = await seedMonitor(db, owner), healthy = f.snapshot(100);
  await f.monitor.observe(owner, f.inventory, healthy, f.profile.id);
  await f.monitor.observe(owner, f.inventory, { ...healthy, quoteUsable: false }, f.profile.id);
  await client`ALTER TABLE research_monitor_events DROP COLUMN sequence CASCADE`;
  await client`UPDATE research_monitor_events SET observation_key = observation->>'observationKey'`;
  const before = await client`SELECT * FROM research_monitor_events ORDER BY id`;
  const namespace = (await client`SELECT current_schema() AS name`)[0].name;
  const start = async () => {
    const uri = new URL(process.env.MEMORY_TEST_DATABASE_URL!);
    uri.searchParams.set('search_path', namespace); uri.searchParams.set('client_min_messages', 'error');
    const started = await createDatabase(uri.toString());
    await (started as typeof started & { $client: postgres.Sql }).$client.end();
  };
  await start();
  assert.deepEqual(Array.from(await client`SELECT * FROM research_monitor_events ORDER BY id`), before.map(event => ({ ...event, sequence: 0 })));
  assert.equal((await f.monitor.view(owner, f.thesis.id)).rules[0].lastObservation?.state, 'unknown');
  await f.monitor.observe(owner, f.inventory, healthy, f.profile.id);
  assert.equal((await f.monitor.view(owner, f.thesis.id)).rules[0].lastObservation?.state, 'clear');
  const recovered = await client`SELECT * FROM research_monitor_events ORDER BY id`;
  await start();
  assert.deepEqual(await client`SELECT * FROM research_monitor_events ORDER BY id`, recovered);
  await f.monitor.observe(owner, f.inventory, healthy, f.profile.id);
  assert.equal((await client`SELECT id FROM research_monitor_events`).length, 3);
}));

test('concurrent ticks deduplicate event/outbox and false, unknown, rule edit and restart preserve the version breach', { skip: !process.env.MEMORY_TEST_DATABASE_URL }, async () => {
  await monitorFixture(async (db, _client, owner) => {
    const f = await seedMonitor(db, owner);
    assert.equal((await f.monitor.view(owner, f.thesis.id)).events.length, 0);
    await Promise.all(Array.from({ length: 5 }, () => f.monitor.observe(owner, f.inventory, f.snapshot(80), f.profile.id)));
    assert.equal((await db.select().from(researchMonitorEvents)).length, 1);
    assert.equal((await db.select().from(strategyOutbox)).length, 1);
    assert.equal(await f.gate(), 'MEMORY_CONDITION_BREACHED');
    await f.monitor.observe(owner, f.inventory, f.snapshot(100), f.profile.id);
    await new ResearchMonitorService(db).observe(owner, f.inventory, { ...f.snapshot(100), quoteUsable: false }, f.profile.id);
    const [rule] = await db.select().from(researchMonitorRules);
    await f.monitor.write(owner, f.thesis.id, { expectedVersion: f.thesis.version, ruleId: rule.id, ruleVersion: 1,
      condition: { ...f.condition, threshold: 1 } });
    assert.equal(await f.gate(), 'MEMORY_CONDITION_BREACHED');
    await assert.rejects(f.memory.updateThesis(owner, f.thesis.id, { expectedVersion: f.thesis.version, action: 'confirm' }), /MEMORY_BREACH_REVIEW_REASON_REQUIRED/);
    const excluded = await f.memory.updateThesis(owner, f.thesis.id, { expectedVersion: f.thesis.version, action: 'exclude', excluded: true });
    const restored = await f.memory.updateThesis(owner, f.thesis.id, { expectedVersion: excluded.version, action: 'exclude', excluded: false });
    assert.equal((await f.monitor.view(owner, restored.id)).breached, true, 'exclude toggles do not heal a breach');
    const revised = await f.memory.updateThesis(owner, f.thesis.id, { expectedVersion: restored.version, action: 'confirm', changeReason: 'Reviewed the new price boundary' });
    assert.equal((await f.monitor.view(owner, revised.id)).breached, false);
    assert.equal(await f.gate(), 'MEMORY_DEPENDENCY_REVOKED', 'old plan never follows the new version silently');
    await f.memory.deleteMemory(owner, f.memoryId);
    await assert.rejects(f.monitor.view(owner, f.thesis.id), /MEMORY_THESIS_NOT_FOUND/);
    await assert.rejects(f.monitor.view(randomUUID(), f.thesis.id), /MEMORY_THESIS_NOT_FOUND/);
  });
});

test('recovered identical observations become current, deduplicate consecutive ticks, and preserve historical breaches', {
  skip: !process.env.MEMORY_TEST_DATABASE_URL,
}, async t => {
  for (const breached of [false, true]) await t.test(breached ? 'previously breached' : 'clear', async () => monitorFixture(async (db, _client, owner) => {
    const f = await seedMonitor(db, owner);
    const healthy = f.snapshot(100);
    const gate = () => db.transaction(async tx => { await lockMemoryOwner(tx, owner);
      return strategyMemoryBlock(tx, owner, f.inventory, 'AAPL', new Date(), true); });
    if (breached) await f.monitor.observe(owner, f.inventory, f.snapshot(80), f.profile.id);
    await f.monitor.observe(owner, f.inventory, healthy, f.profile.id);
    const initial = await db.select().from(researchMonitorEvents);
    const outage = emptyTradingSnapshot('AAPL', new Date(), resolveTradingTicker('AAPL'));
    outage.reason = outage.quoteReason = 'source_unavailable';
    await f.monitor.observe(owner, f.inventory, outage, f.profile.id);
    assert.equal((await f.monitor.view(owner, f.thesis.id)).rules[0].lastObservation?.state, 'unknown');
    assert.equal(await gate(), breached ? 'MEMORY_CONDITION_BREACHED' : 'MEMORY_MONITOR_UNKNOWN');
    const restarted = new ResearchMonitorService(db);
    await Promise.all(Array.from({ length: 5 }, () => restarted.observe(owner, f.inventory,
      { ...healthy, fetchedAt: new Date().toISOString() }, f.profile.id)));
    const recovered = await restarted.view(owner, f.thesis.id);
    assert.equal(recovered.rules[0].lastObservation?.state, 'clear');
    assert.equal(recovered.rules[0].lastValidObservation?.state, 'clear');
    assert.equal(recovered.breached, breached);
    assert.equal(await gate(), breached ? 'MEMORY_CONDITION_BREACHED' : null);
    const events = await db.select().from(researchMonitorEvents);
    assert.equal(events.length, initial.length + 2, 'outage and recovery each append once despite concurrent recovery ticks');
    for (const event of initial) assert.deepEqual(events.find(item => item.id === event.id), event, 'historical observations are immutable');
    await restarted.observe(owner, f.inventory, { ...healthy, fetchedAt: new Date().toISOString() }, f.profile.id);
    assert.equal((await db.select().from(researchMonitorEvents)).length, events.length, 'a later fetch of the same current evaluation is not another transition');
    assert.equal((await db.select().from(strategyOutbox)).length, breached ? 1 : 0);
  }));
});

test('structured archive states, recall origin and disabled automation are explicit', { skip: !process.env.MEMORY_TEST_DATABASE_URL }, async () => {
  await monitorFixture(async (db, client, owner) => {
    const f = await seedMonitor(db, owner);
    assert.equal(f.inventory.state, 'ready');
    await f.memory.updatePreferences(owner, { recallEnabled: false, autoArchive: true });
    assert.equal(await f.gate(), null, 'current report dependencies do not imply recalled memory');
    const recalled = { ...f.inventory, dependencies: f.inventory.dependencies.map(ref => ({ ...ref, origin: 'recalled-memory' as const })) };
    assert.equal(await db.transaction(async tx => { await lockMemoryOwner(tx, owner); return strategyMemoryBlock(tx, owner, recalled); }), 'MEMORY_RECALL_DISABLED');
    await db.update(paperAccounts).set({ botEnabled: false }).where(eq(paperAccounts.id, f.account.id));
    await f.monitor.observe(owner, f.inventory, f.snapshot(80), f.profile.id);
    assert.equal((await db.select().from(researchMonitorEvents)).length, 0);
    await client`DELETE FROM research_thesis_evidence`; await client`DELETE FROM research_thesis_versions`;
    await client`DELETE FROM research_theses`; await client`DELETE FROM research_memory_evidence`; await client`DELETE FROM research_memories`;
    const capture = () => db.transaction(async tx => { await lockMemoryOwner(tx, owner); return captureStrategyMemory(tx, owner, [f.report.id]); });
    assert.equal((await capture()).state, 'archive-pending');
    await f.memory.updatePreferences(owner, { recallEnabled: false, autoArchive: false });
    assert.equal((await capture()).state, 'archive-disabled');
    await f.memory.updatePreferences(owner, { recallEnabled: false, autoArchive: true });
    await client`INSERT INTO research_archive_jobs(owner, session_id, report_id, report_version, ticker, topic, intent, state) VALUES(${owner}, ${f.session.id}, ${f.report.id}, 1, 'AAPL', 'general', 'automatic', 'failed')`;
    assert.equal((await capture()).state, 'archive-failed');
    await db.update(councilReports).set({ thesisCandidates: null }).where(eq(councilReports.id, f.report.id));
    assert.equal((await capture()).state, 'legacy-no-structure');
  });
});

test('final dependency checks apply publication, observation, ingestion and comparable-fact conflict gates', { skip: !process.env.MEMORY_TEST_DATABASE_URL }, async () => {
  await monitorFixture(async (db, _client, owner) => {
    const f = await seedMonitor(db, owner);
    const [record] = await db.select().from(researchMemoryEvidence);
    const metadata = normalizeEvidenceMetadata(f.report.evidence[0]);
    const future = new Date(Date.now() + 86400000).toISOString();
    for (const field of ['publishedAt', 'observedAt'] as const) {
      await db.update(researchMemoryEvidence).set({ metadata: { sources: [{ ...metadata.sources[0], [field]: future }] } }).where(eq(researchMemoryEvidence.id, record.id));
      assert.equal(await f.gate(), 'MEMORY_DEPENDENCY_REVOKED', `${field} cannot be read before it is known`);
    }
    await db.update(researchMemoryEvidence).set({ metadata, ingestedAt: new Date(future) }).where(eq(researchMemoryEvidence.id, record.id));
    assert.equal(await f.gate(), 'MEMORY_DEPENDENCY_REVOKED');
    const source = { ...metadata.sources[0], origin: 'provider' as const, verification: 'server-verified' as const,
      provider: 'fixture', kind: 'financial' as const, publishedAt: new Date(Date.now() - 86400000).toISOString(), publicationPrecision: 'instant' as const,
      facts: [{ entity: 'AAPL', metric: 'Revenue', value: 100, unit: 'currency', currency: 'USD', basis: 'consolidated', actuality: 'actual' as const,
        periodStart: '2026-01-01', periodEnd: '2026-03-31', instant: null }] };
    await db.update(researchMemoryEvidence).set({ metadata: { sources: [source] }, ingestedAt: new Date() }).where(eq(researchMemoryEvidence.id, record.id));
    assert.equal(await f.gate(), null);
    const [report] = await db.insert(councilReports).values({ owner, sessionId: f.session.id, version: 2, revision: 1,
      publicationOutcome: 'succeeded', decision: 'wait', summary: 'Comparable conflicting filing', dissent: [], nextReviewCondition: '', engine: 'llm',
      evidence: [{ ...f.report.evidence[0], metadata: { sources: [{ ...source, facts: [{ ...source.facts[0], value: 90 }] }] } }] }).returning();
    await f.memory.archiveReport(owner, { sessionId: f.session.id, ticker: 'AAPL', language: 'en', report: { ...report, createdAt: report.createdAt.toISOString() } });
    assert.equal(await f.gate(), 'MEMORY_DEPENDENCY_EXPIRED', 'aligned unresolved facts require review at final execution');
  });
});
