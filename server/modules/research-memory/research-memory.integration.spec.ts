import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { councilReports, councilSessions } from '../../database/council.schema';
import { researchMemories, researchTheses, researchThesisVersions } from '../../database/research-memory.schema';
import { QuoteService } from '../quote/quote.service';
import { ResearchMemoryService } from './research-memory.service';
import type { CouncilReport } from '@shared/council.interface';

test('memory archives idempotently, isolates owners/markets, requires CAS and hides deleted sources across versions', {
  skip: !process.env.MEMORY_TEST_DATABASE_URL,
}, async () => {
  const connection = process.env.MEMORY_TEST_DATABASE_URL!;
  const namespace = `memory_test_${randomUUID().replaceAll('-', '')}`;
  const admin = postgres(connection, { max: 1, onnotice: () => {} });
  const client = postgres(connection, { max: 5, onnotice: () => {}, connection: { search_path: namespace } });
  const owner = randomUUID();
  const other = randomUUID();
  await admin`CREATE SCHEMA ${admin(namespace)}`;
  try {
    for (const file of ['01_schema.sql', '03_agent_builder.sql', '07_llm_budget.sql',
      '08_investment_council.sql', '12_council_dialogue.sql', '14_a2a_agents.sql', '17_research_memory.sql', '18_research_workflow.sql']) {
      await client.unsafe(readFileSync(`scripts/db/${file}`, 'utf8'));
    }
    const db = drizzle(client);
    const quotes = new QuoteService(db, undefined as never);
    const service = new ResearchMemoryService(db, quotes);
    const seed = async (ticker: string, user = owner, summary = 'Durable cash-flow thesis', evidence = true,
      createdAt = new Date(), decision: 'wait' | 'approve' | 'reject' = 'wait') => {
      const [session] = await db.insert(councilSessions).values({ owner: user, profileVersion: 1,
        profileSnapshot: {} as never, ticker, status: 'completed', language: 'en' }).returning();
      const [row] = await db.insert(councilReports).values({ owner: user, sessionId: session.id,
        version: 1, revision: 1, decision, summary, dissent: ['Margins may weaken'], createdAt,
        nextReviewCondition: 'Recheck next quarter', evidence: evidence ? [{ id: 'e1', title: 'Filings',
          content: 'DO NOT COPY RAW EVIDENCE INTO VERSIONS', sourceUrl: 'https://example.test/filing',
          fetchedAt: createdAt.toISOString() }] : [], engine: 'llm' }).returning();
      const report: CouncilReport = { ...row, createdAt: row.createdAt.toISOString() };
      return { session, report, input: { sessionId: session.id, ticker, report, language: 'en' as const } };
    };
    const positive = await seed('META');
    const cautious = await seed('META');
    await db.update(councilReports).set({ researchStance: 'positive' }).where(eq(councilReports.id, positive.report.id));
    await db.update(councilReports).set({ researchStance: 'cautious' }).where(eq(councilReports.id, cautious.report.id));
    await service.archiveReport(owner, positive.input);
    const pinnedStance = await service.recall(owner, { ticker: 'META' });
    await service.archiveReport(owner, cautious.input);
    assert.ok((await service.list(owner, { ticker: 'META' })).memories.every(m => m.flags.includes('contradictory')));
    assert.ok((await service.refreshRecall(owner, pinnedStance)).items.every(m => m.flags.includes('contradictory')));
    for (const m of (await service.list(owner, { ticker: 'META' })).memories) await service.deleteMemory(owner, m.id);

    const native = await seed('ORCL');
    await db.update(councilReports).set({ evidence: [{ ...native.report.evidence[0], title: '[Agent source · unverified] Filing excerpt' }] })
      .where(eq(councilReports.id, native.report.id));
    const nativeMemory = await service.archiveReport(owner, native.input);
    assert.ok(nativeMemory!.flags.includes('unverified'));
    const nativeThesis = (await service.list(owner, { ticker: 'ORCL' })).theses[0];
    await service.updateThesis(owner, nativeThesis.id, { action: 'confirm', expectedVersion: 1 });
    assert.ok(!(await service.recall(owner, { ticker: 'ORCL' })).items.some(i => i.kind === 'thesis'));
    await service.deleteMemory(owner, nativeMemory!.id);

    const long = await seed('IBM');
    await db.update(councilReports).set({ evidence: Array.from({ length: 21 }, (_, i) => ({ ...long.report.evidence[0], id: `e${i + 1}` })) })
      .where(eq(councilReports.id, long.report.id));
    const longMemory = await service.archiveReport(owner, { ...long.input, thesisCandidates: [{ claim: 'Last source',
      supportingEvidence: [{ evidenceId: 'e21' }], opposingEvidence: [], assumptions: [], indicators: [], invalidationConditions: [] }] });
    const longThesis = (await service.list(owner, { ticker: 'IBM' })).theses[0];
    assert.equal(longThesis.citations[0].evidenceId, 'e21');
    await service.deleteMemory(owner, longMemory!.id);

    for (const variant of ['unverified', 'stale'] as const) {
      const ticker = variant === 'unverified' ? 'CRM' : 'ADBE';
      const mixed = await seed(ticker);
      await db.update(councilReports).set({ evidence: [mixed.report.evidence[0], { ...mixed.report.evidence[0], id: 'unrelated',
        title: variant === 'unverified' ? '[Agent source · unverified] Unrelated' : 'Unrelated old filing',
        fetchedAt: variant === 'stale' ? new Date(Date.now() - 60 * 86_400_000).toISOString() : new Date().toISOString() }] })
        .where(eq(councilReports.id, mixed.report.id));
      const archive = await service.archiveReport(owner, { ...mixed.input, thesisCandidates: [{ claim: 'Supported by the fresh source',
        supportingEvidence: [{ evidenceId: 'e1' }], opposingEvidence: [], assumptions: [], indicators: [], invalidationConditions: [] }] });
      assert.ok(archive!.flags.includes(variant));
      const selected = (await service.list(owner, { ticker })).theses[0];
      await service.updateThesis(owner, selected.id, { action: 'confirm', expectedVersion: 1 });
      assert.ok((await service.recall(owner, { ticker })).items.some(i => i.kind === 'thesis'), 'unrelated evidence must not disqualify selected valid sources');
    }

    const source = await seed('0700');
    const [first, duplicate] = await Promise.all([service.archiveReport(owner, source.input), service.archiveReport(owner, source.input)]);
    assert.ok(first);
    assert.equal(first.id, duplicate?.id);
    assert.equal((await service.list(owner, { ticker: '700.HK' })).memories.length, 1);
    let listing = await service.list(owner, { ticker: '700.HK', market: 'HK' });
    assert.equal(listing.memories.length, 1);
    assert.equal(listing.theses.length, 1, 'duplicate archive cannot duplicate candidate');
    assert.equal(listing.theses[0].status, 'candidate');
    assert.deepEqual((await service.list(other, { ticker: '700.HK' })).memories, []);
    await assert.rejects(service.archiveReport(other, source.input));
    await assert.rejects(service.recall(owner, { ticker: '000001', market: 'HK' }));
    await service.archiveReport(owner, (await seed('000001.SZ')).input);
    assert.equal((await service.list(owner, { ticker: '700.HK' })).memories.length, 1);
    assert.equal((await service.recall(owner, { ticker: '700.HK' })).items.filter(item => item.kind === 'thesis').length, 0);
    const thesis = listing.theses[0];
    await assert.rejects(service.updateThesis(other, thesis.id, { action: 'confirm', expectedVersion: 1 }));
    const results = await Promise.allSettled([
      service.updateThesis(owner, thesis.id, { action: 'confirm', expectedVersion: 1 }),
      service.updateThesis(owner, thesis.id, { action: 'dismiss', expectedVersion: 1 }),
    ]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.match(String((results.find(result => result.status === 'rejected') as PromiseRejectedResult).reason), /MEMORY_VERSION_CONFLICT/);
    let current = await service.getThesis(owner, thesis.id);
    if (current.status !== 'confirmed') current = await service.updateThesis(owner, thesis.id, { action: 'confirm', expectedVersion: current.version });
    const frozen = await service.recall(owner, { ticker: '700.HK' });
    assert.ok(frozen.items.some(item => item.kind === 'thesis'));
    assert.ok(frozen.context.length <= 6000);
    await service.archiveReport(owner, { ...source.input, thesisCandidates: [{ claim: 'Attempted overwrite',
      supportingEvidence: [{ evidenceId: 'e1' }], opposingEvidence: [], assumptions: [], indicators: [], invalidationConditions: [] }] });
    assert.equal((await service.getThesis(owner, thesis.id)).claim, current.claim);
    const versions = await service.thesisVersions(owner, thesis.id);
    assert.equal(versions.length, current.version);
    assert.ok(!JSON.stringify(await db.select().from(researchThesisVersions)).includes('DO NOT COPY RAW EVIDENCE'));

    const opposing = await seed('700.HK', owner, 'Opposing view', true, new Date(), 'reject');
    const opposingMemory = await service.archiveReport(owner, opposing.input);
    const refreshed = await service.refreshRecall(owner, frozen);
    assert.ok(refreshed.items.every(item => item.flags.includes('contradictory')), 'pinned recall rechecks current contradictions');
    await service.deleteMemory(owner, opposingMemory!.id);
    const edited = await service.updateThesis(owner, thesis.id, { action: 'edit', expectedVersion: current.version,
      content: { claim: 'User edited claim', supportingEvidence: current.supportingEvidence,
        opposingEvidence: [], assumptions: ['Demand remains stable'], indicators: ['Margin'], invalidationConditions: ['Two margin declines'] } });
    assert.equal(edited.status, 'confirmed');
    assert.ok(!(await service.refreshRecall(owner, frozen)).items.some(item => item.kind === 'thesis'), 'old pinned thesis must not upgrade silently');
    current = edited;

    await service.updateMemory(owner, first.id, { excluded: true });
    assert.equal((await service.refreshRecall(owner, frozen)).items.length, 0);
    await service.updateMemory(owner, first.id, { excluded: false });
    await db.delete(councilReports).where(eq(councilReports.id, source.report.id));
    listing = await service.list(owner, { ticker: '700.HK' });
    assert.equal(listing.memories[0].sourceStatus, 'source-deleted');
    assert.equal(listing.memories[0].summary, '');
    assert.equal(listing.theses[0].claim, '');
    assert.equal((await service.thesisVersions(owner, thesis.id))[0].content, null);
    assert.equal((await service.refreshRecall(owner, frozen)).context, '');
    assert.equal((await service.recall(owner, { ticker: '700.HK' })).items.length, 0);
    await service.deleteThesis(owner, thesis.id, current.version);
    assert.equal((await db.select().from(researchThesisVersions).where(eq(researchThesisVersions.thesisId, thesis.id))).length, 0);
    assert.equal((await db.select().from(researchTheses).where(eq(researchTheses.id, thesis.id)))[0].content.claim, '');

    const stale = await service.archiveReport(owner, (await seed('NVDA', owner, 'Old earnings view', true,
      new Date(Date.now() - 60 * 86_400_000))).input);
    assert.ok(stale!.flags.includes('stale'));
    const staleThesis = (await service.list(owner, { ticker: 'NVDA' })).theses[0];
    await service.updateThesis(owner, staleThesis.id, { action: 'confirm', expectedVersion: 1 });
    assert.ok(!(await service.recall(owner, { ticker: 'NVDA' })).items.some(item => item.kind === 'thesis'));
    const expiring = await service.archiveReport(owner, (await seed('AMD')).input);
    const expiredThesis = (await service.list(owner, { ticker: 'AMD' })).theses[0];
    const confirmed = await service.updateThesis(owner, expiredThesis.id, { action: 'confirm', expectedVersion: 1 });
    await service.updateThesis(owner, confirmed.id, { action: 'expire', expectedVersion: confirmed.version });
    assert.ok(!(await service.recall(owner, { ticker: 'AMD' })).items.some(item => item.kind === 'thesis'));
    await service.deleteMemory(owner, expiring!.id);
    assert.equal((await db.select().from(researchThesisVersions).where(eq(researchThesisVersions.thesisId, confirmed.id))).length, 0);

    const unsourced = await seed('MSFT', owner, 'Unsourced opinion', false);
    await service.archiveReport(owner, unsourced.input);
    const unsourcedThesis = (await service.list(owner, { ticker: 'MSFT' })).theses[0];
    await assert.rejects(service.updateThesis(owner, unsourcedThesis.id, { action: 'confirm', expectedVersion: 1 }), /MEMORY_SOURCE_REQUIRED/);
    await service.updatePreferences(owner, { autoArchive: false, recallEnabled: false });
    assert.equal(await service.archiveReport(owner, (await seed('AAPL')).input), null);
    assert.deepEqual((await service.recall(owner, { ticker: 'MSFT' })).items, []);
    await service.updatePreferences(owner, { autoArchive: true, recallEnabled: true });
    const explicit = await seed('GOOG');
    const memory = await service.archiveReport(owner, { ...explicit.input, thesisCandidates: [] });
    assert.equal((await service.list(owner, { ticker: 'GOOG' })).theses.length, 0);
    await service.deleteMemory(owner, memory!.id);
    assert.equal(await service.archiveReport(owner, explicit.input), null, 'deleted archive cannot resurrect');
    for (let index = 0; index < 4; index++) {
      const raceMemory = await service.archiveReport(owner, (await seed('SPY', owner, `Deletion race ${index}`)).input);
      const raceThesis = (await service.list(owner, { ticker: 'SPY' })).theses.find(item => item.memoryId === raceMemory!.id)!;
      const outcomes = await Promise.allSettled([
        service.updateThesis(owner, raceThesis.id, { expectedVersion: 1, action: 'confirm' }),
        service.deleteMemory(owner, raceMemory!.id),
      ]);
      assert.equal(outcomes[1].status, 'fulfilled');
      assert.equal((await db.select().from(researchThesisVersions).where(eq(researchThesisVersions.thesisId, raceThesis.id))).length, 0,
        'concurrent edits cannot leave an immutable body behind a deletion');
      assert.equal((await service.list(owner, { ticker: 'SPY' })).theses.length, 0);
    }
  } finally {
    await client.end();
    await admin`DROP SCHEMA ${admin(namespace)} CASCADE`;
    await admin.end();
  }
});
