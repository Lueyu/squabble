import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { councilReports, councilSessions } from '../../database/council.schema';
import { researchMemories, researchTheses } from '../../database/research-memory.schema';
import { monitorFixture } from './research-memory.monitor.fixtures';
import { ResearchMemoryService } from './research-memory.service';
import { QuoteService } from '../quote/quote.service';
import { retrievalCorpus } from './research-memory.retrieval.fixtures';

test('one frozen pool supports different tasks beyond three seats without importing new versions or foreign memories', {
  skip: !process.env.MEMORY_TEST_DATABASE_URL,
}, async () => monitorFixture(async (db, _client, owner) => {
  const memory = new ResearchMemoryService(db, new QuoteService(db, undefined as never));
  const [session] = await db.insert(councilSessions).values({ owner, ticker: 'AAPL', profileVersion: 1,
    profileSnapshot: {} as never, status: 'completed', language: 'en' }).returning();
  const [report] = await db.insert(councilReports).values({ owner, sessionId: session.id, revision: 1, version: 1,
    publicationOutcome: 'succeeded', decision: 'wait', summary: 'Fictional multiple independent claims', dissent: [],
    nextReviewCondition: '', engine: 'llm', evidence: [{ id: 'filing', title: 'Fixture filing', content: 'Fictional report',
      sourceUrl: 'https://example.test/report', fetchedAt: new Date().toISOString() }] }).returning();
  await memory.archiveReport(owner, { sessionId: session.id, ticker: 'AAPL', language: 'en',
    report: { ...report, createdAt: report.createdAt.toISOString() },
    thesisCandidates: retrievalCorpus().filter(item => item.kind === 'thesis').slice(0, 5).map(item => item.content!) });
  for (const item of (await memory.list(owner, { ticker: 'AAPL' })).theses) {
    await memory.updateThesis(owner, item.id, { expectedVersion: 1, action: 'confirm' });
  }
  const frozen = await memory.recall(owner, { ticker: 'AAPL' });
  const cutoff = new Date().toISOString();
  assert.equal(frozen.items.filter(item => item.kind === 'thesis').length, 5);
  const cash = await memory.refreshRecall(owner, frozen, { ticker: 'AAPL', query: 'free cash flow' });
  assert.match(cash.items[0].content!.claim, /现金流/u);
  assert.match(cash.items[1].content!.claim, /Collections/u, 'the real archived scoped refute relation stays beside its cash-flow anchor');
  assert.equal(cash.items[0].source.reportId, cash.items[1].source.reportId);
  assert.equal(cash.items[0].citations[0].recordId, cash.items[1].citations[0].recordId);
  const pricing = await memory.refreshRecall(owner, frozen, { ticker: 'AAPL', query: 'premium pricing' });
  assert.match(pricing.items[0].content!.claim, /Premium pricing/u);
  const pin = cash.items[0];
  const { provenance: _provenance, ...editable } = pin.content!;
  await memory.updateThesis(owner, pin.id, { expectedVersion: pin.version, action: 'edit',
    content: { ...editable, claim: 'Later cash restatement' } });
  const refreshed = await memory.refreshRecall(owner, frozen, { ticker: 'AAPL', query: 'cash' });
  assert.ok(!refreshed.items.some(item => item.id === pin.id));
  assert.ok(refreshed.omissions?.some(item => item.id === pin.id && item.reason === 'version-changed'));
  assert.equal((await memory.refreshRecall(randomUUID(), frozen, { ticker: 'AAPL' })).items.length, 0);
  assert.equal((await memory.refreshRecall(owner, frozen, { ticker: 'MSFT' })).items.length, 0);
  const future = new Date(Date.parse(cutoff) + 86400000);
  const reports = await db.insert(councilReports).values(Array.from({ length: 501 }, (_, i) => ({
    ...report, id: randomUUID(), version: i + 2, createdAt: future }))).returning();
  const parents = await db.insert(researchMemories).values(reports.map(source => ({ owner, ticker: 'AAPL', market: 'US' as const,
    topic: 'general', language: 'en' as const, sessionId: session.id, reportId: source.id, reportVersion: source.version,
    reportRevision: source.revision, reportCreatedAt: future, summary: 'Fictional later import', decision: 'wait' as const, createdAt: future }))).returning();
  await db.insert(researchTheses).values(parents.map(parent => ({ owner, memoryId: parent.id, content: retrievalCorpus()[0].content!,
    status: 'confirmed' as const, createdAt: future, updatedAt: future })));
  const historical = await memory.recall(owner, { ticker: 'AAPL', asOf: cutoff, query: 'cash flows' });
  assert.ok(historical.items.some(item => item.id === pin.id && item.version === pin.version),
    'future imports must be filtered before the finite thesis window, not crowd out what was known at the cutoff');
}));
