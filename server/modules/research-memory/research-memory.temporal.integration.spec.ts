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
import type { EvidenceMetadata } from '@shared/research-evidence.interface';
import type { ThesisContent } from '@shared/research-memory.interface';
import { parseFinnhubFinancials } from '../multi-agent/finnhub-financials';
import { ResearchToolsService } from '../research-tools/research-tools.service';
import { CouncilService } from '../council/council.service';
import { evidenceExcerpts, type CouncilEvidence } from '../council/council.rules';
import { nativeWorkflowSources } from '../council/council.workflow-executor';
import { FinnhubEvidenceService } from '../multi-agent/finnhub-evidence.service';

const enabled = { skip: !process.env.MEMORY_TEST_DATABASE_URL };
const metadata = (value = 100): EvidenceMetadata => ({ sources: [{ origin: 'provider', verification: 'server-verified',
  provider: 'SEC EDGAR', kind: 'financial', sourceUrl: 'https://example.test/filing', sourceRevision: `filing-${value}`,
  supersedesSourceRevision: null, revisionReason: null, publishedAt: '2026-04-30', publicationPrecision: 'day',
  observedAt: '2026-05-01T00:00:00.000Z', observationBasis: 'server', facts: [{ entity: 'AAPL', metric: 'us-gaap:Revenues',
    value, unit: 'currency', currency: 'USD', basis: 'us-gaap', actuality: 'actual',
    periodStart: '2026-01-01', periodEnd: '2026-03-31', instant: null }] }] });
const content: ThesisContent = { claim: 'Quarterly cash generation supports patient investment',
  supportingEvidence: [{ evidenceId: 'filing' }], opposingEvidence: [], assumptions: [], indicators: [], invalidationConditions: [],
  evidenceRelations: [{ evidenceId: 'filing', role: 'qualify' }] };

async function fixture(run: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const namespace = `temporal_${randomUUID().replaceAll('-', '')}`;
  const admin = postgres(process.env.MEMORY_TEST_DATABASE_URL!, { max: 1, onnotice: () => {} });
  const client = postgres(process.env.MEMORY_TEST_DATABASE_URL!, { max: 5, onnotice: () => {}, connection: { search_path: namespace } });
  await admin`CREATE SCHEMA ${admin(namespace)}`;
  try {
    for (const file of ['01_schema.sql', '03_agent_builder.sql', '07_llm_budget.sql', '08_investment_council.sql',
      '12_council_dialogue.sql', '14_a2a_agents.sql', '17_research_memory.sql', '18_research_workflow.sql', '19_atomic_research_theses.sql', '20_research_memory_temporal.sql']) {
      await client.unsafe(readFileSync(`scripts/db/${file}`, 'utf8'));
    }
    await run(await setup(client));
  } finally { await client.end(); await admin`DROP SCHEMA ${admin(namespace)} CASCADE`; await admin.end(); }
}
async function setup(client: postgres.Sql) {
  const db = drizzle(client), owner = randomUUID();
  const service = new ResearchMemoryService(db, new QuoteService(db, undefined as never));
  const seed = async (data: EvidenceMetadata | null = metadata(), claim = content, decision: 'wait' | 'reject' = 'wait', fetchedAt = '2026-05-01T00:00:00Z') => {
    const [session] = await db.insert(councilSessions).values({ owner, profileVersion: 1, profileSnapshot: {} as never,
      ticker: 'AAPL', status: 'completed', language: 'en' }).returning();
    const [report] = await db.insert(councilReports).values({ owner, sessionId: session.id, version: 1, revision: 1,
      decision, summary: 'Historical quarterly evidence', dissent: [], nextReviewCondition: '', engine: 'llm',
      createdAt: new Date('2026-05-01T00:00:00Z'), evidence: [{ id: 'filing', title: 'Quarterly filing', content: 'Published source body',
        sourceUrl: 'https://example.test/filing', fetchedAt, ...(data ? { metadata: data } : {}) }] }).returning();
    const memory = await service.archiveReport(owner, { sessionId: session.id, ticker: 'AAPL', language: 'en',
      report: { ...report, createdAt: report.createdAt.toISOString() }, thesisCandidates: [claim] });
    const thesis = (await service.list(owner, { ticker: 'AAPL' })).theses.find(item => item.memoryId === memory!.id)!;
    return { session, report, memory: memory!, thesis };
  };
  return { db, client, owner, service, seed };
}

test('old quarterly and legacy opinions remain recallable; a review deadline changes freshness, never endorsement', enabled, async () => fixture(async ({ service, owner, seed }) => {
  const saved = await seed(metadata(), { ...content, horizon: { reviewAt: '2026-06-01T00:00:00Z' } });
  const thesis = await service.updateThesis(owner, saved.thesis.id, { action: 'confirm', expectedVersion: 1 });
  assert.equal(thesis.flags.includes('stale'), false);
  assert.equal(thesis.status, 'confirmed');
  assert.equal((thesis as unknown as { freshness: string }).freshness, 'needs_review');
  assert.ok((await service.recall(owner, { ticker: 'AAPL' })).items.some(item => item.id === thesis.id));
  const legacy = await seed(null, { ...content, claim: 'An owner-confirmed legacy opinion' });
  await service.updateThesis(owner, legacy.thesis.id, { action: 'confirm', expectedVersion: 1 });
  assert.ok((await service.recall(owner, { ticker: 'AAPL' })).items.some(item => item.id === legacy.thesis.id));
  assert.ok((await service.getThesis(owner, legacy.thesis.id)).flags.includes('provenance_unknown'));
}));

test('historical reads exclude later imports and edits, retain immutable revisions and respect live exclusion and source deletion', enabled, async () => fixture(async ({ service, owner, seed, db }) => {
  const beforeImport = new Date(Date.now() - 1000).toISOString();
  const saved = await seed();
  const confirmed = await service.updateThesis(owner, saved.thesis.id, { action: 'confirm', expectedVersion: 1 });
  assert.equal((await service.list(owner, { ticker: 'AAPL', asOf: beforeImport } as never)).memories.length, 0);
  const cutoff = new Date().toISOString();
  await new Promise(resolve => setTimeout(resolve, 10));
  const edited = await service.updateThesis(owner, confirmed.id, { action: 'edit', expectedVersion: confirmed.version,
    content: { ...content, claim: 'Later claim must never leak backwards' }, changeReason: 'New disclosure' } as never);
  const historical = await service.recall(owner, { ticker: 'AAPL', asOf: cutoff } as never);
  assert.equal(historical.items.find(item => item.kind === 'thesis')?.content?.claim, content.claim);
  assert.equal(historical.items.find(item => item.kind === 'thesis')?.version, confirmed.version);
  assert.ok(!JSON.stringify(historical).includes(edited.claim));
  assert.equal((await service.thesisVersions(owner, confirmed.id))[0].content?.claim, edited.claim);
  assert.equal((await service.thesisVersions(owner, confirmed.id))[0].changeReason, 'New disclosure');
  const graph = await service.evidenceGraph(owner, saved.memory.id);
  assert.equal(graph.evidence[0].metadata.sources[0].facts[0].value, 100);
  assert.ok(graph.relations.some(relation => relation.version === confirmed.version && relation.role === 'qualify'));
  assert.ok(graph.relations.some(relation => relation.version === edited.version && relation.role === 'support'));
  await assert.rejects(service.evidenceGraph(randomUUID(), saved.memory.id));
  assert.equal((await service.refreshRecall(owner, historical, { ticker: 'AAPL', asOf: cutoff } as never)).items.find(item => item.kind === 'thesis')?.version, confirmed.version);
  await service.updateMemory(owner, saved.memory.id, { excluded: true });
  assert.equal((await service.recall(owner, { ticker: 'AAPL', asOf: cutoff } as never)).items.length, 0);
  assert.deepEqual(await service.evidenceGraph(owner, saved.memory.id), { evidence: [], relations: [], comparisons: [] });
  await service.updateMemory(owner, saved.memory.id, { excluded: false });
  await db.delete(councilReports).where(eq(councilReports.id, saved.report.id));
  assert.equal((await service.recall(owner, { ticker: 'AAPL', asOf: cutoff } as never)).items.length, 0);
}));

test('real provider typed metadata survives tool archive, checkpoint, publication and durable graph; native assertions stay unverified', enabled, async () => fixture(async ({ service, owner, db }) => {
  const reported = parseFinnhubFinancials({ symbol: 'AAPL', cik: '123', data: [{ symbol: 'AAPL', cik: '123',
    startDate: '2026-04-01', endDate: '2026-06-30', filedDate: '2026-08-01', accessNumber: '0000000123-26-000001', form: '10-Q',
    report: { ic: [{ concept: 'us-gaap_Revenues', value: 100, unit: 'USD' }, { concept: 'us-gaap_NetIncomeLoss', value: 10, unit: 'USD' }],
      cf: [{ concept: 'us-gaap_NetCashProvidedByUsedInOperatingActivities', value: 20, unit: 'USD' }],
      bs: [{ concept: 'us-gaap_Liabilities', value: 50, unit: 'USD' }] } }] }, 'AAPL', 'quarterly', new Date('2026-11-03T12:00:00Z'));
  assert.equal(reported.hasStatements, true);
  const publishedAt = new Date(Math.floor(Date.now() / 1000) * 1000 - 60000).toISOString();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json([{ headline: 'Company update', summary: 'Annual results published',
    source: 'Publisher', url: 'https://example.test/news', datetime: Date.parse(publishedAt) / 1000 }]);
  let news;
  try { news = await new FinnhubEvidenceService({ getFinnhubKey: async () => 'fixture' } as never).getNews(owner, 'AAPL'); }
  finally { globalThis.fetch = originalFetch; }
  assert.equal(news?.[0].metadata?.sources[0].publishedAt, publishedAt);
  const [session] = await db.insert(councilSessions).values({ owner, profileVersion: 1,
    profileSnapshot: { council: { members: [{ id: 'researcher', role: 'researcher', name: 'Fixture', model: 'fast' }] } } as never,
    ticker: 'AAPL', status: 'running', language: 'en', checkpoint: { cycleId: randomUUID(), nextTurn: 0,
      turns: [{ memberId: 'researcher', phase: 'opening' }], pendingResearch: [], toolKindsUsed: [] } as never }).returning();
  const quotes = new QuoteService(db, undefined as never);
  const tools = new ResearchToolsService(db, quotes, { collectResearch: async (_ticker: string, _owner: string, kind: string) =>
    kind === 'news' ? news : reported.items } as never, service);
  const result = await tools.call(owner, { sessionId: session.id, revision: 1, memberId: 'researcher', memberName: 'Fixture',
    turn: 0, ticker: 'AAPL', language: 'en', webResearch: false, expiresAt: Date.now() + 60000 },
  { callId: 'financials', name: 'get_financials', arguments: {} });
  assert.equal(result.status, 'succeeded');
  await tools.call(owner, { sessionId: session.id, revision: 1, memberId: 'researcher', memberName: 'Fixture',
    turn: 0, ticker: 'AAPL', language: 'en', webResearch: false, expiresAt: Date.now() + 60000 },
  { callId: 'news', name: 'get_news', arguments: {} });
  const [current] = await db.select().from(councilSessions).where(eq(councilSessions.id, session.id));
  const evidence = current.evidenceSnapshot[0];
  assert.equal(evidence.metadata?.sources[0].facts[0].value, 100);
  assert.equal(evidence.metadata.sources[0].publishedAt, '2026-08-01');
  assert.equal(evidence.metadata.sources[0].publicationPrecision, 'day');
  assert.ok(evidence.metadata.sources[0].observedAt);
  const excerpt = evidenceExcerpts([evidence], 5000)[0] as unknown as { metadata?: unknown };
  assert.ok(excerpt.metadata, 'prompt excerpt retains source/date semantics');
  const archived: CouncilEvidence = { ...evidence, id: 'earlier-filing' };
  await db.update(councilSessions).set({ checkpoint: { ...current.checkpoint!, evidenceArchive: [archived] } }).where(eq(councilSessions.id, session.id));
  const council = new CouncilService(db, {} as never, {} as never, {} as never, {} as never, undefined, undefined, service);
  const publish = council as unknown as { publish(owner: string, row: typeof current, opinion: unknown, engine: string,
    error: null, stance: null, coverage: undefined, candidates: ThesisContent[]): Promise<boolean> };
  assert.equal(await publish.publish(owner, current, { decision: 'wait', summary: 'Quarterly report', dissent: [], nextReviewCondition: '', evidenceIds: [evidence.id] },
    'llm', null, null, undefined, [{ ...content, supportingEvidence: [{ evidenceId: evidence.id }], evidenceRelations: [] }]), true);
  const [report] = await db.select().from(councilReports).where(eq(councilReports.sessionId, session.id));
  assert.deepEqual(report.evidence[0].metadata, evidence.metadata);
  assert.deepEqual(report.evidence.find(item => item.id === archived.id)?.metadata, evidence.metadata);
  const listing = await service.list(owner, { ticker: 'AAPL' });
  const graph = await service.evidenceGraph(owner, listing.memories[0].id);
  assert.equal(graph.evidence[0].metadata.sources[0].facts[0].value, 100);
  const archivedNews = graph.evidence.flatMap(item => item.metadata.sources).find(source => source.kind === 'news')!;
  assert.equal(archivedNews.publishedAt, publishedAt);
  assert.equal(archivedNews.publicationPrecision, 'instant');
  assert.equal(archivedNews.origin, 'provider');
  assert.equal(archivedNews.provider, 'Finnhub API');
  assert.equal(archivedNews.sourceUrl, 'https://example.test/news');
  assert.ok(archivedNews.observedAt);
  assert.deepEqual(archivedNews.facts, []);
  assert.ok(!JSON.stringify(listing.theses[0].citations).includes('"value":100'), 'prompt citations do not duplicate the fact archive');
  const native = nativeWorkflowSources({ sources: [{ id: 'fake', title: 'Claimed verified source', content: 'Claimed value',
    url: 'https://example.test/native', metadata: evidence.metadata }] }, 'attempt', [], 'en').sources[0];
  assert.equal(native.metadata?.sources[0].verification, 'unverified');
  assert.equal(native.metadata.sources[0].publishedAt, null);
  assert.deepEqual(native.metadata.sources[0].facts, []);
}));

test('direction differences are opinions while aligned typed data conflicts require review', enabled, async () => fixture(async ({ service, owner, seed }) => {
  const first = await seed();
  await service.updateThesis(owner, first.thesis.id, { action: 'confirm', expectedVersion: 1 });
  const second = await seed(metadata(), { ...content, claim: 'Another direction' }, 'reject');
  assert.ok((await service.list(owner, { ticker: 'AAPL' })).memories.every(item => !item.flags.includes('contradictory')));
  await service.deleteMemory(owner, second.memory.id);
  await seed(metadata(101));
  const listing = await service.list(owner, { ticker: 'AAPL' });
  assert.ok(listing.memories.every(item => item.flags.includes('contradictory')));
  assert.ok(listing.theses.every(item => item.flags.includes('needs_review' as never)));
  const conflict = (await service.evidenceGraph(owner, first.memory.id)).comparisons.find(item => item.kind === 'conflict');
  assert.equal(conflict?.leftSourceIndex, 0); assert.equal(conflict?.leftFactIndex, 0);
  assert.equal(conflict?.rightSourceIndex, 0); assert.equal(conflict?.rightFactIndex, 0);
}));

test('known future publication is excluded despite an old fetch, while a previously known forecast target may be future', enabled, async () => fixture(async ({ service, owner, seed }) => {
  const future = metadata(); future.sources[0].publishedAt = '2099-01-01';
  const saved = await seed(future);
  assert.equal((await service.recall(owner, { ticker: 'AAPL' })).items.length, 0);
  await service.deleteMemory(owner, saved.memory.id);
  const missingObservation = metadata(); missingObservation.sources[0].observedAt = null; missingObservation.sources[0].observationBasis = 'unknown';
  const laterFetch = await seed(missingObservation, content, 'wait', new Date(Date.now() + 60000).toISOString());
  await service.updateThesis(owner, laterFetch.thesis.id, { action: 'confirm', expectedVersion: 1 });
  assert.equal((await service.recall(owner, { ticker: 'AAPL', asOf: new Date().toISOString() })).items.length, 0,
    'a missing component observation must not hide the known later server fetch');
  await service.deleteMemory(owner, laterFetch.memory.id);
  const forecast = metadata(); forecast.sources[0].facts[0] = { ...forecast.sources[0].facts[0], actuality: 'forecast', periodEnd: '2027-03-31' };
  const known = await seed(forecast);
  await service.updateThesis(owner, known.thesis.id, { action: 'confirm', expectedVersion: 1 });
  assert.ok((await service.recall(owner, { ticker: 'AAPL', asOf: new Date().toISOString() } as never)).items.some(item => item.kind === 'thesis'));
}));
