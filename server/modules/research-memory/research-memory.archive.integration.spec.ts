import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { councilReports, councilSessions } from '../../database/council.schema';
import { ResearchMemoryService } from './research-memory.service';
import { QuoteService } from '../quote/quote.service';
import { ResearchArchiveService, enqueueResearchArchive } from './research-memory.archive';
import { researchArchiveJobs, researchMemories } from '../../database/research-memory.schema';
import { CouncilService } from '../council/council.service';
import { createDatabase } from '../../common/platform/database.provider';

async function fixture(run: (value: { db: ReturnType<typeof drizzle>; client: postgres.Sql; owner: string;
  memory: ResearchMemoryService; jobs: ResearchArchiveService; queryCount: () => number }) => Promise<void>, max = 10) {
  const namespace = `archive_${randomUUID().replaceAll('-', '')}`, owner = randomUUID();
  const admin = postgres(process.env.MEMORY_TEST_DATABASE_URL!, { max: 1, onnotice: () => {} });
  let queries = 0;
  const client = postgres(process.env.MEMORY_TEST_DATABASE_URL!, { max, onnotice: () => {},
    connection: { search_path: namespace }, debug: () => { queries++; } });
  await admin`CREATE SCHEMA ${admin(namespace)}`;
  try {
    await client.unsafe(readFileSync('scripts/db/01_schema.sql', 'utf8'));
    const url = new URL(process.env.MEMORY_TEST_DATABASE_URL!); url.searchParams.set('search_path', namespace);
    url.searchParams.set('client_min_messages', 'error');
    const started = await createDatabase(url.toString());
    await (started as typeof started & { $client: postgres.Sql }).$client.end();
    const db = drizzle(client), memory = new ResearchMemoryService(db, new QuoteService(db, undefined as never));
    await run({ db, client, owner, memory, jobs: new ResearchArchiveService(db, memory), queryCount: () => queries });
  } finally { await client.end(); await admin`DROP SCHEMA ${admin(namespace)} CASCADE`; await admin.end(); }
}

async function seed(db: ReturnType<typeof drizzle>, owner: string, options: { completed?: boolean; version?: number } = {}) {
  const [session] = await db.insert(councilSessions).values({ owner, ticker: 'AAPL', profileVersion: 1,
    profileSnapshot: {} as never, status: options.completed === false ? 'running' : 'completed', language: 'en' }).returning();
  const [report] = await db.insert(councilReports).values({ owner, sessionId: session.id, revision: 1, version: options.version ?? 1,
    publicationOutcome: 'succeeded', decision: 'wait', summary: 'Durable published history', dissent: [], nextReviewCondition: '',
    evidence: [{ id: 'e1', title: 'Filing', sourceUrl: 'https://example.test/filing', content: 'Fixture', fetchedAt: new Date().toISOString() }],
    engine: 'llm' }).returning();
  return { session, report, input: { sessionId: session.id, ticker: 'AAPL', language: 'en' as const,
    report: { ...report, createdAt: report.createdAt.toISOString() } } };
}

async function makeJobsDue(client: postgres.Sql) {
  // PostgreSQL schedules with microsecond precision; workers compare a separate JavaScript millisecond clock.
  // Explicitly advance queued fixtures past their due time without waiting for either clock.
  await client`UPDATE research_archive_jobs SET next_attempt_at = '2000-01-01T00:00:00Z' WHERE state = 'queued'`;
}

test('publication queues the exact report atomically and records successful versus failed outcomes', { skip: !process.env.MEMORY_TEST_DATABASE_URL },
  async () => fixture(async ({ db, client, owner }) => {
    const council = new CouncilService(db, {} as never, {} as never, {} as never, {} as never);
    const { session } = await seed(db, owner, { completed: false });
    const opinion = { decision: 'wait' as const, summary: 'New report', dissent: [], nextReviewCondition: '' };
    await client`ALTER TABLE research_archive_jobs ADD CONSTRAINT reject_fixture CHECK (false)`;
    await assert.rejects(council['publish'](owner, session, opinion, 'llm', null));
    assert.equal((await db.select().from(councilReports)).length, 1, 'job insertion failure rolls report back');
    assert.equal((await db.select().from(councilSessions))[0].status, 'running');
    await client`ALTER TABLE research_archive_jobs DROP CONSTRAINT reject_fixture`;
    assert.equal(await council['publish'](owner, session, opinion, 'llm', null), true);
    const [job] = await db.select().from(researchArchiveJobs);
    const reports = await db.select().from(councilReports);
    assert.equal(job.reportId, reports.find(row => row.version === 2)?.id);
    assert.equal(reports.find(row => row.id === job.reportId)?.publicationOutcome, 'succeeded');
    const failed = await seed(db, owner, { completed: false });
    await council['publish'](owner, failed.session, opinion, 'llm', 'fixture failure');
    assert.equal((await db.select().from(researchArchiveJobs)).length, 1);
    assert.equal((await db.select().from(councilReports)).filter(row => row.publicationOutcome === 'failed').length, 1);
  }));

test('workers recover leases, fence stale completions and keep source deletion and tombstones authoritative', { skip: !process.env.MEMORY_TEST_DATABASE_URL },
  async () => fixture(async ({ db, client, owner, jobs, memory }) => {
    const source = await seed(db, owner);
    await enqueueResearchArchive(db, source.report, 'AAPL');
    await makeJobsDue(client);
    const first = (await jobs.claim())!;
    await client`UPDATE research_archive_jobs SET lease_until = '2000-01-01T00:00:00Z' WHERE id = ${first.id}`;
    const restarted = new ResearchArchiveService(db, memory), second = (await restarted.claim())!;
    assert.notEqual(first.leaseToken, second.leaseToken);
    await jobs.runClaim(first.id, first.leaseToken!);
    assert.equal((await db.select().from(researchMemories)).length, 0);
    await db.update(councilSessions).set({ status: 'running', revision: 5 }).where(eq(councilSessions.id, source.session.id));
    await restarted.runClaim(second.id, second.leaseToken!);
    assert.equal((await jobs.list(owner)).counts.succeeded, 1, 'old report authority survives a new session cycle');
    const archived = (await memory.list(owner, { ticker: 'AAPL' })).memories[0];
    await memory.deleteMemory(owner, archived.id);
    await client`UPDATE research_archive_jobs SET state = 'failed' WHERE id = ${first.id}`;
    await jobs.retry(owner, first.id); await makeJobsDue(client); await jobs.tick();
    assert.equal((await jobs.list(owner)).jobs[0].error, 'MEMORY_DELETED');
    assert.equal((await memory.list(owner, { ticker: 'AAPL' })).memories.length, 0);
    const gone = await seed(db, owner); await enqueueResearchArchive(db, gone.report, 'AAPL');
    await db.delete(councilSessions).where(eq(councilSessions.id, gone.session.id));
    await makeJobsDue(client);
    await jobs.tick();
    assert.equal((await jobs.list(owner)).jobs.find(row => row.reportId === gone.report.id)?.error, 'MEMORY_SOURCE_NOT_FOUND');
  }));

test('final archival transaction rolls back on completion failure and cannot revive a concurrent deletion', { skip: !process.env.MEMORY_TEST_DATABASE_URL },
  async () => fixture(async ({ db, client, owner, jobs, memory }) => {
    const source = await seed(db, owner); await enqueueResearchArchive(db, source.report, 'AAPL');
    await client`ALTER TABLE research_archive_jobs ADD CONSTRAINT completion_failure_fixture CHECK (state <> 'succeeded')`;
    await makeJobsDue(client);
    await jobs.tick();
    assert.equal((await db.select().from(researchMemories)).length, 0, 'failure after archive writes must roll the entire archive back');
    await client`ALTER TABLE research_archive_jobs DROP CONSTRAINT completion_failure_fixture`;
    await makeJobsDue(client);
    await jobs.tick();
    const archived = (await memory.list(owner, { ticker: 'AAPL' })).memories[0];
    const job = (await jobs.list(owner)).jobs[0];
    await client`UPDATE research_archive_jobs SET state = 'failed' WHERE id = ${job.id}`;
    await jobs.retry(owner, job.id);
    await makeJobsDue(client);
    await Promise.all([jobs.tick(), memory.deleteMemory(owner, archived.id)]);
    assert.equal((await memory.list(owner, { ticker: 'AAPL' })).memories.length, 0);
    assert.equal((await db.select().from(researchMemories))[0].summary, '');
    const gone = await seed(db, owner); await enqueueResearchArchive(db, gone.report, 'AAPL');
    await makeJobsDue(client);
    const claim = (await jobs.claim())!;
    let running: Promise<void> | undefined;
    await client.begin(async tx => {
      await tx`SELECT id FROM council_sessions WHERE id = ${gone.session.id} FOR UPDATE`;
      running = jobs.runClaim(claim.id, claim.leaseToken!);
      await tx`DELETE FROM council_sessions WHERE id = ${gone.session.id}`;
    });
    await running;
    assert.equal((await jobs.list(owner)).jobs.find(row => row.id === claim.id)?.error, 'MEMORY_SOURCE_NOT_FOUND');
    assert.equal((await db.select().from(researchMemories)).length, 1);
  }));

test('active theses survive 101 newer reports and list/recall query counts stay bounded', { skip: !process.env.MEMORY_TEST_DATABASE_URL },
  async () => fixture(async ({ db, owner, memory, queryCount }) => {
    const old = await seed(db, owner);
    await memory.archiveReport(owner, { ...old.input, thesisCandidates: [{ claim: 'Long lived independently active thesis',
      supportingEvidence: [{ evidenceId: 'e1' }], opposingEvidence: [], assumptions: [], indicators: [], invalidationConditions: [] }] });
    const thesis = (await memory.list(owner, { ticker: 'AAPL' })).theses[0];
    await memory.updateThesis(owner, thesis.id, { action: 'confirm', expectedVersion: 1 });
    const beforeSmall = queryCount(); await memory.list(owner, { ticker: 'AAPL' }); const small = queryCount() - beforeSmall;
    for (let index = 0; index < 101; index++) {
      const source = await seed(db, owner); await memory.archiveReport(owner, source.input);
    }
    const beforeLarge = queryCount(), listing = await memory.list(owner, { ticker: 'AAPL' });
    assert.ok(queryCount() - beforeLarge <= small + 3, 'query count must not grow per report');
    assert.equal(listing.memories.length, 100);
    assert.ok(!listing.memories.some(row => row.id === thesis.memoryId));
    assert.ok(listing.theses.some(row => row.id === thesis.id && row.citations.length));
    assert.ok((await memory.recall(owner, { ticker: 'AAPL' })).items.some(row => row.id === thesis.id));
  }));

test('manual import continues beyond 100 records while automatic jobs respect live preferences', { skip: !process.env.MEMORY_TEST_DATABASE_URL },
  async () => fixture(async ({ db, client, owner, jobs, memory }) => {
    const source = await seed(db, owner);
    await enqueueResearchArchive(db, source.report, 'AAPL');
    await memory.updatePreferences(owner, { autoArchive: false, recallEnabled: true });
    await makeJobsDue(client);
    await jobs.tick();
    const failed = (await jobs.list(owner, { state: 'failed' })).jobs[0];
    assert.equal(failed.error, 'MEMORY_AUTO_ARCHIVE_DISABLED');
    await assert.rejects(jobs.retry(randomUUID(), failed.id), /MEMORY_ARCHIVE_NOT_FOUND/);
    await jobs.retry(owner, failed.id); await makeJobsDue(client); await jobs.tick();
    assert.equal((await memory.list(owner, { ticker: 'AAPL' })).memories.length, 1);
    assert.equal((await memory.list(owner, { ticker: 'AAPL' })).theses.length, 0, 'manual import never invents extracted claims');
    await db.insert(councilReports).values(Array.from({ length: 105 }, (_, index) => ({ ...source.report, id: randomUUID(), version: index + 2 })));
    let queued = 0, pages = 0, cursor: string | undefined;
    do {
      const imported = await jobs.importReports(owner, { limit: 40, cursor });
      queued += imported.queued; pages++; cursor = imported.nextCursor ?? undefined;
    } while (cursor);
    assert.equal(queued, 105); assert.equal(pages, 3);
    assert.equal((await jobs.importReports(owner)).queued, 0, 'processed first page cannot starve later imports');
    assert.equal((await jobs.list(owner)).counts.queued, 105);
    let seen = 0; cursor = undefined;
    do { const page = await jobs.list(owner, { limit: 17, cursor }); seen += page.jobs.length; cursor = page.nextCursor ?? undefined; } while (cursor);
    assert.equal(seen, 106);
    await makeJobsDue(client);
    for (let index = 0; index < 21; index++) await jobs.tick();
    assert.equal((await jobs.list(owner)).counts.succeeded, 106);
    const archived = (await memory.list(owner, { ticker: 'AAPL' })).memories[0];
    await memory.deleteMemory(owner, archived.id);
    assert.equal((await jobs.importReports(owner)).queued, 0);
  }));

test('archive import and status counts share canonical ticker scope for lowercase and Hong Kong aliases', { skip: !process.env.MEMORY_TEST_DATABASE_URL },
  async () => fixture(async ({ db, owner, jobs }) => {
    const us = await seed(db, owner), hk = await seed(db, owner);
    await db.update(councilSessions).set({ ticker: '0700.HK' }).where(eq(councilSessions.id, hk.session.id));
    assert.equal((await jobs.importReports(owner, { ticker: 'aapl', market: 'US' })).queued, 1);
    assert.equal((await jobs.importReports(owner, { ticker: '00700.hk', market: 'HK' })).queued, 1);
    const scoped = await jobs.list(owner, { ticker: '700.HK', market: 'HK' });
    assert.equal(scoped.counts.queued, 1); assert.equal(scoped.jobs[0].reportId, hk.report.id);
    assert.equal((await jobs.list(owner, { ticker: 'aapl' })).jobs[0].reportId, us.report.id);
    assert.equal((await jobs.list(randomUUID(), { ticker: '700.HK' })).counts.queued, 0);
    await assert.rejects(jobs.importReports(owner, { ticker: '700.HK', market: 'US' }), /MEMORY_MARKET_MISMATCH/);
  }));

test('every valid Hong Kong padding form shares import, automatic job counts and pagination without widening owner or market', {
  skip: !process.env.MEMORY_TEST_DATABASE_URL,
}, async () => fixture(async ({ db, owner, jobs, memory }) => {
  const groups = [
    ['0.HK', '00.HK', '000.HK', '0000.HK', '00000.HK', '0000', '00000'],
    ['7.HK', '07.HK', '007.HK', '0007.HK', '00007.HK', '0007', '00007'],
    ['70.HK', '070.HK', '0070.HK', '00070.HK', '0070', '00070'],
    ['700.HK', '0700.HK', '00700.HK', '0700', '00700'],
    ['7000.HK', '07000.HK', '7000', '07000'],
    ['70000.HK', '70000'],
  ];
  for (const aliases of groups) {
    const canonical = memory.symbol({ ticker: aliases[0], market: 'HK' });
    const expected = new Set<string>();
    for (const ticker of aliases) {
      assert.deepEqual(memory.symbol({ ticker, market: 'HK' }), canonical);
      const source = await seed(db, owner);
      await db.update(councilSessions).set({ ticker }).where(eq(councilSessions.id, source.session.id));
      expected.add(source.report.id);
      const [automatic] = await db.insert(councilReports).values({ ...source.report, id: randomUUID(), version: 2 }).returning();
      expected.add(automatic.id);
      await enqueueResearchArchive(db, automatic, ticker);
    }
    let imported = 0, cursor: string | undefined;
    do {
      const page = await jobs.importReports(owner, { ticker: canonical.ticker, market: 'HK', limit: 2, cursor });
      imported += page.queued; cursor = page.nextCursor ?? undefined;
    } while (cursor);
    assert.equal(imported, aliases.length, `canonical import finds every stored alias for ${canonical.ticker}`);
    for (const ticker of aliases) {
      const page = await jobs.list(owner, { ticker: ` ${ticker.toLowerCase()} `, market: 'HK' });
      assert.equal(page.counts.queued, expected.size, `counts cover every alias when querying ${ticker}`);
      assert.deepEqual(new Set(page.jobs.map(row => row.reportId)), expected);
    }
    const paged = new Set<string>(); cursor = undefined;
    do {
      const page = await jobs.list(owner, { ticker: aliases[0], market: 'HK', limit: 2, cursor });
      assert.equal(page.counts.queued, expected.size);
      for (const row of page.jobs) { assert.ok(!paged.has(row.reportId)); paged.add(row.reportId); }
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    assert.deepEqual(paged, expected);
  }
  for (const ticker of ['70', '070', '000070.HK']) {
    await assert.rejects(jobs.list(owner, { ticker, market: 'HK' }), /MEMORY_INVALID_SYMBOL/);
    await assert.rejects(jobs.importReports(owner, { ticker, market: 'HK' }), /MEMORY_INVALID_SYMBOL/);
  }
  await assert.rejects(jobs.list(owner, { ticker: '000070', market: 'HK' }), /MEMORY_MARKET_MISMATCH/);
  const cn = await seed(db, owner), foreign = await seed(db, randomUUID());
  await db.update(councilSessions).set({ ticker: '000070' }).where(eq(councilSessions.id, cn.session.id));
  await db.update(councilSessions).set({ ticker: '070.HK' }).where(eq(councilSessions.id, foreign.session.id));
  await enqueueResearchArchive(db, cn.report, '000070');
  await enqueueResearchArchive(db, foreign.report, '070.HK');
  const scoped = await jobs.list(owner, { ticker: '00070.HK', market: 'HK' });
  assert.equal(scoped.counts.queued, 12);
  assert.ok(scoped.jobs.every(row => row.reportId !== cn.report.id && row.reportId !== foreign.report.id));
  assert.equal((await jobs.importReports(owner, { ticker: '070.HK', market: 'HK' })).queued, 0);
}));

test('transient archive failures back off, stop after bounded attempts and support an owner retry', { skip: !process.env.MEMORY_TEST_DATABASE_URL },
  async () => fixture(async ({ db, client, owner, jobs }) => {
    const source = await seed(db, owner); await enqueueResearchArchive(db, source.report, 'AAPL');
    await client`ALTER TABLE research_memories ADD CONSTRAINT fail_archive_fixture CHECK (false)`;
    for (let index = 0; index < 5; index++) {
      await makeJobsDue(client);
      await jobs.tick();
      const job = (await jobs.list(owner)).jobs[0];
      assert.equal(job.attempts, index + 1); assert.equal(job.error, 'MEMORY_ARCHIVE_FAILED');
      if (index < 4) {
        assert.equal(job.state, 'queued'); assert.ok(Date.parse(job.nextAttemptAt) > Date.now());
        await jobs.tick(); assert.equal((await jobs.list(owner)).jobs[0].attempts, index + 1);
      } else assert.equal(job.state, 'failed');
    }
    await client`ALTER TABLE research_memories DROP CONSTRAINT fail_archive_fixture`;
    const id = (await jobs.list(owner)).jobs[0].id;
    await Promise.all([jobs.retry(owner, id), jobs.retry(owner, id)]);
    await makeJobsDue(client);
    const claims = await Promise.all([jobs.claim(), new ResearchArchiveService(db, jobs['memory']).claim()]);
    assert.equal(claims.filter(Boolean).length, 1);
    const claim = claims.find(Boolean)!;
    await jobs.runClaim(claim.id, claim.leaseToken!);
    assert.equal((await jobs.list(owner)).counts.succeeded, 1);
    assert.equal((await db.select().from(researchMemories)).length, 1);
  }));

test('genuine cycles reselect memory while pause and task retry retain version pins', { skip: !process.env.MEMORY_TEST_DATABASE_URL },
  async () => fixture(async ({ db, owner, memory }) => {
    const source = await seed(db, owner); await memory.archiveReport(owner, source.input);
    const council = new CouncilService(db, { validateConnectionIds: async () => {}, isConfigured: async () => true } as never,
      {} as never, {} as never, {} as never, undefined, undefined, memory);
    council['launch'] = () => {};
    const created = await council.createSession(owner, { ticker: 'AAPL', language: 'en', goal: 'comprehensive', recallEnabled: true });
    const original = (await db.select().from(councilSessions).where(eq(councilSessions.id, created.id)))[0].checkpoint!;
    const newer = await seed(db, owner); await memory.archiveReport(owner, newer.input);
    await council.pauseSession(owner, created.id); await council.runSession(owner, created.id);
    const resumed = (await db.select().from(councilSessions).where(eq(councilSessions.id, created.id)))[0].checkpoint!;
    assert.equal(resumed.cycleId, original.cycleId); assert.deepEqual(resumed.workflow?.memory, original.workflow?.memory);
    await council.pauseSession(owner, created.id); await council.runSession(owner, created.id, ['financials']);
    const retry = (await db.select().from(councilSessions).where(eq(councilSessions.id, created.id)))[0].checkpoint!;
    assert.equal(retry.cycleId, original.cycleId); assert.deepEqual(retry.workflow?.memory, original.workflow?.memory);
    await council.addMessage(owner, created.id, 'Start a follow-up with the new source');
    const next = (await db.select().from(councilSessions).where(eq(councilSessions.id, created.id)))[0].checkpoint!;
    assert.notEqual(next.cycleId, original.cycleId);
    assert.ok(next.workflow?.memory?.items.some(item => item.source.reportId === newer.report.id));
    const latest = await seed(db, owner); await memory.archiveReport(owner, latest.input);
    await db.update(councilSessions).set({ status: 'completed', checkpoint: { ...next, nextTurn: next.turns.length } })
      .where(eq(councilSessions.id, created.id));
    await council.runSession(owner, created.id);
    const rerun = (await db.select().from(councilSessions).where(eq(councilSessions.id, created.id)))[0].checkpoint!;
    assert.notEqual(rerun.cycleId, next.cycleId);
    assert.ok(rerun.workflow?.memory?.items.some(item => item.source.reportId === latest.report.id));
  }, 1));

test('archival rejects unknown historical failures and basic reports', { skip: !process.env.MEMORY_TEST_DATABASE_URL }, async () => {
  const namespace = `archive_${randomUUID().replaceAll('-', '')}`;
  const admin = postgres(process.env.MEMORY_TEST_DATABASE_URL!, { max: 1, onnotice: () => {} });
  const client = postgres(process.env.MEMORY_TEST_DATABASE_URL!, { max: 5, onnotice: () => {}, connection: { search_path: namespace } });
  await admin`CREATE SCHEMA ${admin(namespace)}`;
  try {
    for (const name of ['01_schema.sql', '03_agent_builder.sql', '07_llm_budget.sql', '08_investment_council.sql',
      '12_council_dialogue.sql', '14_a2a_agents.sql', '17_research_memory.sql', '18_research_workflow.sql',
      '19_atomic_research_theses.sql', '20_research_memory_temporal.sql', '21_research_archive_jobs.sql']) await client.unsafe(readFileSync(`scripts/db/${name}`, 'utf8'));
    const db = drizzle(client), owner = randomUUID();
    const memory = new ResearchMemoryService(db, new QuoteService(db, undefined as never));
    const [session] = await db.insert(councilSessions).values({ owner, ticker: 'AAPL', profileVersion: 1,
      profileSnapshot: {} as never, status: 'completed', revision: 2, language: 'en' }).returning();
    const [report] = await db.insert(councilReports).values({ owner, sessionId: session.id, revision: 1, version: 1,
      decision: 'wait', summary: 'Unknown outcome from an older cycle', dissent: [], nextReviewCondition: '', evidence: [], engine: 'llm' }).returning();
    const input = { sessionId: session.id, ticker: 'AAPL', language: 'en' as const,
      report: { ...report, createdAt: report.createdAt.toISOString() } };
    await assert.rejects(memory.archiveReport(owner, input), /MEMORY_SOURCE_NOT_COMPLETED/);
    await db.update(councilReports).set({ revision: 2, engine: 'basic' }).where(eq(councilReports.id, report.id));
    await assert.rejects(memory.archiveReport(owner, input), /MEMORY_SOURCE_NOT_COMPLETED/);
  } finally { await client.end(); await admin`DROP SCHEMA ${admin(namespace)} CASCADE`; await admin.end(); }
});
