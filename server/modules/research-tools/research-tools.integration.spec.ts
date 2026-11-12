import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq, or } from 'drizzle-orm';
import { councilReports, councilSessions } from '../../database/council.schema';
import { councilResearchTasks } from '../../database/research-workflow.schema';
import { researchMemories, researchMemoryPreferences } from '../../database/research-memory.schema';
import type { BuilderConfig } from '../../../shared/api.interface';
import type { ResearchToolScope } from '../../../shared/research-tools.interface';
import type { QuoteService } from '../quote/quote.service';
import type { EvidenceService, EvidenceInput } from '../research-core/evidence.service';
import { ResearchToolsService } from './research-tools.service';
import { ResearchMemoryService } from '../research-memory/research-memory.service';
import { waitForSavedAvailability } from '../council/council-test.fixture';

// CI/the disposable test harness initializes the base schema and additive migrations.
const url = process.env.COUNCIL_TEST_DATABASE_URL;
const dbTest = url ? test : test.skip;
const client = url ? postgres(url, { max: 2, onnotice: () => undefined }) : null;
const db = client ? drizzle(client) : null;
const owner = randomUUID();
const otherOwner = randomUUID();
const config: BuilderConfig = { name: 'Research tools fixture', template: 'balanced', tickers: ['AAPL'],
  minimumRating: 'Buy', customPrompt: '', maxOrderPct: 5, dailyLossLimitPct: 3, maxOrdersPerDay: 1,
  notifyOnProposal: false, council: { enabled: true, webResearch: false, members: [
    { id: 'researcher', name: 'Researcher', role: 'researcher', instructions: '', model: 'fast' },
    { id: 'manager', name: 'Manager', role: 'manager', instructions: '', model: 'fast' },
  ] } };

after(async () => {
  if (!client || !db) return;
  try {
    await db.delete(researchMemories).where(or(eq(researchMemories.owner, owner), eq(researchMemories.owner, otherOwner)));
    await db.delete(researchMemoryPreferences).where(eq(researchMemoryPreferences.owner, owner));
    await db.delete(councilSessions).where(or(eq(councilSessions.owner, owner), eq(councilSessions.owner, otherOwner)));
  }
  finally { await client.end(); }
});

dbTest('real SQL isolates Council-only report history by both owners, ticker and visible revision', async () => {
  const [current, previous, differentTicker, foreign] = await db.insert(councilSessions).values([
    { owner, profileVersion: 1, profileSnapshot: config, ticker: 'AAPL', language: 'en', status: 'running', revision: 4,
      checkpoint: { cycleId: randomUUID(), nextTurn: 0, turns: [{ memberId: 'researcher', phase: 'opening' }],
        toolKindsUsed: [], pendingResearch: [] } },
    { owner, profileVersion: 1, profileSnapshot: config, ticker: 'AAPL', language: 'en', status: 'completed', revision: 8 },
    { owner, profileVersion: 1, profileSnapshot: config, ticker: 'MSFT', language: 'en', status: 'completed', revision: 8 },
    { owner: otherOwner, profileVersion: 1, profileSnapshot: config, ticker: 'AAPL', language: 'en', status: 'completed', revision: 8 },
  ]).returning();
  const base = { decision: 'wait' as const, dissent: ['Fixture dissent'], nextReviewCondition: 'Next filed results',
    engine: 'local' as const, evidence: [{ id: 'filing', title: 'Fixture filing',
      content: 'Revenue USD 1000000, year ended 2025-12-31.', sourceUrl: 'https://www.sec.gov/Archives/fixture',
      fetchedAt: '2026-10-30T10:00:00.000Z' }] };
  await db.insert(councilReports).values([
    { ...base, owner, sessionId: previous.id, version: 1, revision: 7, summary: 'Owned prior Council report' },
    { ...base, owner: otherOwner, sessionId: foreign.id, version: 1, revision: 7, summary: 'Foreign report owner' },
    { ...base, owner, sessionId: foreign.id, version: 2, revision: 7, summary: 'Foreign parent session' },
    { ...base, owner: otherOwner, sessionId: previous.id, version: 2, revision: 7, summary: 'Foreign child report' },
    { ...base, owner, sessionId: differentTicker.id, version: 1, revision: 7, summary: 'Different ticker report' },
    { ...base, owner, sessionId: current.id, version: 1, revision: 5, summary: 'Future current revision' },
    { ...base, owner, sessionId: previous.id, version: 3, revision: 9, summary: 'Future previous revision' },
  ]);
  const service = new ResearchToolsService(db,
    { getQuote: async () => { throw new Error('Provider must not be called'); } } as unknown as QuoteService,
    { collectResearch: async () => { throw new Error('Provider must not be called'); } } as unknown as EvidenceService,
    new ResearchMemoryService(db, {} as QuoteService));
  const scope: ResearchToolScope = { sessionId: current.id, revision: 4, memberId: 'researcher', memberName: 'Researcher',
    turn: 0, ticker: 'AAPL', language: 'en', webResearch: false, expiresAt: Date.now() + 60_000 };
  assert.equal(await service.isCurrent(owner, scope), true);
  assert.equal(await service.isCurrent(otherOwner, scope), false);
  for (const changed of [{ revision: 3 }, { ticker: 'MSFT' }, { turn: 1 }, { memberId: 'manager' }]) {
    assert.equal(await service.isCurrent(owner, { ...scope, ...changed }), false);
  }
  const request = { callId: 'history', name: 'get_research_report', arguments: { limit: 3 } };
  const result = await service.call(owner, scope, request);
  assert.equal(result.status, 'succeeded');
  const data = result.data as { reports: Array<{ type: string; version: number; revision: number; summary: string }> };
  assert.equal(data.reports.length, 1);
  assert.equal(data.reports[0].type, 'council_report');
  assert.equal(data.reports[0].version, 1); assert.equal(data.reports[0].revision, 7);
  assert.equal(data.reports[0].summary, 'Owned prior Council report');
  assert.match(JSON.stringify(result), /2026-10-30T10:00:00.000Z/);
  assert.ok(!/Foreign|Different ticker|Future/.test(JSON.stringify(result)));
  const [historySession] = await db.select().from(councilSessions).where(eq(councilSessions.id, current.id));
  assert.deepEqual(historySession.evidenceSnapshot, [], 'saved reports must remain live references, not durable tool copies');
  const denied = await service.call(otherOwner, scope, request);
  assert.equal(denied.status, 'cancelled'); assert.ok(!JSON.stringify(denied).includes('Owned prior'));
  await db.update(councilSessions).set({ revision: 5 }).where(eq(councilSessions.id, current.id));
  const stale = await service.call(owner, scope, request);
  assert.equal(stale.errorCode, 'RESEARCH_SCOPE_EXPIRED');
});

dbTest('real workflow scope is durable and memory tools/snapshots respect owner, live deletion and recall preference', async () => {
  const cycleId = randomUUID();
  const checkpoint = { cycleId, nextTurn: 99, turns: [], toolKindsUsed: [], pendingResearch: [],
    workflow: { goal: 'financials' as const, peers: [], parallelism: 2 as const, recallEnabled: true } };
  const [current, source] = await db.insert(councilSessions).values([
    { owner, profileVersion: 1, profileSnapshot: config, ticker: 'AAPL', language: 'en', status: 'running', revision: 1, checkpoint },
    { owner, profileVersion: 1, profileSnapshot: config, ticker: 'AAPL', language: 'en', status: 'completed', revision: 1 },
  ]).returning();
  const [report] = await db.insert(councilReports).values({ owner, sessionId: source.id, version: 1, revision: 1,
    summary: 'Live historical opinion', decision: 'wait', dissent: [], nextReviewCondition: 'Next filing', engine: 'local',
    evidence: [{ id: 'filing', title: 'SEC', sourceUrl: 'https://www.sec.gov/Archives/fixture',
      content: 'Historical evidence', fetchedAt: new Date().toISOString() }] }).returning();
  const [archived] = await db.insert(researchMemories).values({ owner, ticker: 'AAPL', market: 'US', topic: 'general', language: 'en',
    sessionId: source.id, reportId: report.id, reportVersion: 1, reportRevision: 1, reportCreatedAt: report.createdAt,
    summary: report.summary, decision: 'wait' }).returning();
  await waitForSavedAvailability(new Date(Math.max(report.createdAt.getTime(), archived.createdAt.getTime())).toISOString());
  const quotes = { getQuote: async () => { throw new Error('No network calls'); },
    detectMarket: (ticker: string) => ({ market: 'US', displaySymbol: ticker, symbolNative: ticker }) } as unknown as QuoteService;
  const memory = new ResearchMemoryService(db, quotes);
  const frozen = await memory.recall(owner, { ticker: 'AAPL' });
  assert.ok(frozen.items.some(item => item.id === archived.id));
  await db.update(councilSessions).set({ checkpoint: { ...checkpoint, workflow: { ...checkpoint.workflow, memory: frozen } } })
    .where(eq(councilSessions.id, current.id));
  const work = { id: randomUUID(), revision: 1, kind: 'work' as const, startedAt: new Date().toISOString(), state: 'running' as const, messageId: randomUUID() };
  const [task] = await db.insert(councilResearchTasks).values({ owner, sessionId: current.id, cycleId, revision: 1,
    key: 'financials', position: 0, memberId: 'researcher', state: 'running', dependencies: [], skills: [], attempts: [work] }).returning();
  const service = new ResearchToolsService(db, quotes,
    { collectResearch: async () => { throw new Error('No network calls'); } } as unknown as EvidenceService, memory);
  const scope: ResearchToolScope = { sessionId: current.id, revision: 1, memberId: 'researcher', memberName: 'Researcher',
    turn: 0, ticker: 'AAPL', language: 'en', webResearch: false, expiresAt: Date.now() + 60_000 };
  const request = { callId: 'memory', name: 'get_research_memory', arguments: {} };
  assert.equal(await service.isCurrent(owner, scope), true);
  assert.equal(await service.isCurrent(otherOwner, scope), false);
  const result = await service.call(owner, scope, request);
  assert.equal(result.status, 'succeeded'); assert.match(JSON.stringify(result), /Live historical opinion/);
  assert.match((await service.bundle(owner, scope)).snapshot, /Live historical opinion/);
  await memory.updatePreferences(owner, { autoArchive: true, recallEnabled: false });
  assert.equal((await service.call(owner, scope, request)).errorCode, 'RESEARCH_RECALL_DISABLED');
  assert.ok(!(await service.bundle(owner, scope)).snapshot.includes('Live historical opinion'));
  const [refreshed] = await db.select().from(councilSessions).where(eq(councilSessions.id, current.id));
  assert.deepEqual(refreshed.evidenceSnapshot, [], 'memory and context must never be copied into durable tool evidence');
  await memory.updatePreferences(owner, { autoArchive: true, recallEnabled: true });
  await memory.deleteMemory(owner, archived.id);
  assert.ok(!JSON.stringify(await service.call(owner, scope, request)).includes('Live historical opinion'));
  assert.ok(!(await service.bundle(owner, scope)).snapshot.includes('Live historical opinion'));
  await db.update(councilResearchTasks).set({ attempts: [{ ...work, kind: 'review' }] }).where(eq(councilResearchTasks.id, task.id));
  assert.equal(await service.isCurrent(owner, scope), false);
  assert.equal(await service.isCurrent(owner, { ...scope, memberId: 'manager' }), true);
  await db.update(councilResearchTasks).set({ state: 'accepted' }).where(eq(councilResearchTasks.id, task.id));
  assert.equal(await service.isCurrent(owner, { ...scope, memberId: 'manager' }), false);
});

const providerFact: EvidenceInput = { role: 'fundamental', evidenceType: 'financial', title: 'Fixture financials',
  content: 'Period: 2025-01-01 to 2025-12-31. Revenue: USD 1000; Net income: USD 100. Form: 10-K.',
  sourceName: 'SEC EDGAR', sourceUrl: 'https://www.sec.gov/Archives/fixture', relevanceScore: 1 };

async function providerFixture() {
  const cycleId = randomUUID();
  const [session] = await db.insert(councilSessions).values({ owner, profileVersion: 1,
    profileSnapshot: { ...config, council: { ...config.council, webResearch: true } }, ticker: 'AAPL', language: 'en',
    status: 'running', revision: 1, checkpoint: { cycleId, nextTurn: 99, turns: [], toolKindsUsed: [], pendingResearch: [],
      workflow: { goal: 'financials', peers: [], parallelism: 2, recallEnabled: false } } }).returning();
  const attempt = { id: randomUUID(), revision: 1, kind: 'work' as const, startedAt: new Date().toISOString(),
    state: 'running' as const, messageId: randomUUID() };
  const [task] = await db.insert(councilResearchTasks).values({ owner, sessionId: session.id, cycleId, revision: 1,
    key: 'financials', position: 0, memberId: 'researcher', state: 'running', dependencies: [], skills: [], attempts: [attempt] }).returning();
  const quotes = { getQuote: async () => ({ symbol: 'AAPL', price: '100', change: '0', changePercent: '0', currency: 'USD',
    market: 'US', timestamp: Date.now() }) } as unknown as QuoteService;
  const provider = { collectResearch: async (): Promise<EvidenceInput[]> => [providerFact] };
  const service = new ResearchToolsService(db, quotes, provider as unknown as EvidenceService, new ResearchMemoryService(db, quotes));
  const scope: ResearchToolScope = { sessionId: session.id, revision: 1, memberId: 'researcher', memberName: 'Researcher',
    turn: 0, ticker: 'AAPL', language: 'en', webResearch: true, expiresAt: Date.now() + 60_000 };
  return { session, task, attempt, provider, service, scope };
}

dbTest('real SQL atomically appends bounded server tool evidence for parallel calls with durable citation IDs', async () => {
  const { session, service, scope, provider } = await providerFixture();
  const names = ['get_quotes', 'get_financials', 'get_news', 'get_valuation', 'get_peer_comparison',
    'get_valuation_scenarios', 'search_research_web'];
  const results = await Promise.all(names.map(name => service.call(owner, scope, { callId: name, name,
    arguments: name === 'get_valuation_scenarios' ? { metric: 'earnings', multiples: { bear: 10, base: 15, bull: 20 } } : {} })));
  const [current] = await db.select().from(councilSessions).where(eq(councilSessions.id, session.id));
  assert.equal(current.evidenceSnapshot.length, names.length);
  const ids = results.map((result, index) => {
    assert.ok(['succeeded', 'partial'].includes(result.status));
    const id = (result.data as { evidenceId?: string }).evidenceId;
    assert.match(id ?? '', /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/iu);
    const saved = current.evidenceSnapshot.find(item => item.id === id);
    assert.ok(saved, `${names[index]} evidence must be persisted before returning its ID`);
    assert.deepEqual(JSON.parse(saved.content), result);
    assert.equal(saved.relevanceScore, names[index] === 'search_research_web' ? 0 : 1);
    if (names[index] === 'search_research_web') {
      assert.match(saved.sourceName, /unverified/);
      assert.match(saved.title, /unverified/, 'report citation titles must preserve the web provenance warning');
    }
    assert.ok(Buffer.byteLength(saved.content) <= 24_000);
    return id;
  });
  assert.equal(new Set(ids).size, names.length);
  assert.ok(!ids.includes('get_quotes'), 'caller call IDs must not become evidence IDs');
  provider.collectResearch = async () => Array.from({ length: 10 }, () => ({ ...providerFact, content: '财务'.repeat(20_000) }));
  const large = await service.call(owner, scope, { callId: 'large', name: 'get_financials', arguments: {} });
  assert.equal(large.truncated, true);
  const [latest] = await db.select().from(councilSessions).where(eq(councilSessions.id, session.id));
  const saved = latest.evidenceSnapshot.find(item => item.id === (large.data as { evidenceId: string }).evidenceId);
  assert.ok(saved); assert.ok(Buffer.byteLength(saved.content) <= 24_000);
  assert.deepEqual(JSON.parse(saved.content), large);
});

dbTest('real SQL rejects late provider output from replaced attempts and changed revisions without archiving it', async () => {
  for (const change of ['attempt', 'revision', 'owner'] as const) {
    const { session, task, attempt, service, scope, provider } = await providerFixture();
    let release: (value: EvidenceInput[]) => void = () => undefined;
    let started: () => void = () => undefined;
    const ready = new Promise<void>(resolve => { started = resolve; });
    provider.collectResearch = async () => { started(); return new Promise(resolve => { release = resolve; }); };
    const pending = service.call(owner, scope, { callId: 'late', name: 'get_financials', arguments: {} });
    await ready;
    if (change === 'attempt') await db.update(councilResearchTasks).set({ attempts: [
      { ...attempt, state: 'cancelled' }, { ...attempt, id: randomUUID() },
    ] }).where(eq(councilResearchTasks.id, task.id));
    else await db.update(councilSessions).set(change === 'revision' ? { revision: 2 } : { owner: otherOwner })
      .where(eq(councilSessions.id, session.id));
    release([providerFact]);
    const result = await pending;
    assert.equal(result.status, 'cancelled'); assert.equal(result.errorCode, 'RESEARCH_SCOPE_EXPIRED');
    const [current] = await db.select().from(councilSessions).where(eq(councilSessions.id, session.id));
    assert.deepEqual(current.evidenceSnapshot, []);
  }
});
