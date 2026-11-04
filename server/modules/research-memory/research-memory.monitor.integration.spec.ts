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

test('monitor migration is installed by production startup', { skip: !process.env.MEMORY_TEST_DATABASE_URL }, async () => {
  await monitorFixture(async (_db, client) => {
    assert.equal((await client`SELECT to_regclass('research_monitor_events')::text AS name`)[0].name, 'research_monitor_events');
    assert.equal((await client`SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema()
      AND table_name = 'strategy_plans' AND column_name = 'memory_inventory'`).length, 1);
  });
});

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
