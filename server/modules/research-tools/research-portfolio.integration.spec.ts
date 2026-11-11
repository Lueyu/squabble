import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { councilSessions } from '../../database/council.schema';
import type { QuoteService } from '../quote/quote.service';
import type { EvidenceService } from '../research-core/evidence.service';
import type { ResearchMemoryService } from '../research-memory/research-memory.service';
import type { DataFinancialService } from '../data-library/data-financial.service';
import type { ResearchToolScope } from '../../../shared/research-tools.interface';
import { ResearchToolsService } from './research-tools.service';
import { agentRuntimeRuns } from '../../database/agent-tooling.schema';
import { newCheckpoint } from '../council/council.dialogue';

test('portfolio tools query only frozen authorized instruments and preserve unknown business time', async () => {
  const url = process.env.RESEARCH_TEST_DATABASE_URL;
  assert.ok(url && new URL(url).pathname.includes('test'), 'Disposable database required');
  const ns = `portfolio_tool_${randomUUID().replaceAll('-', '')}`, owner = randomUUID(), id = randomUUID();
  const admin = postgres(url, { max: 1, onnotice: () => {} }), client = postgres(url, { max: 4, onnotice: () => {}, connection: { search_path: ns } });
  try {
    await admin.unsafe(`create schema ${ns}`);
    await client.unsafe(readFileSync('scripts/db/01_schema.sql', 'utf8'));
    const db = drizzle(client), symbols: string[] = [], financialRequests: unknown[] = [];
    const now = new Date().toISOString();
    const frozen = { id: 'owner-facts', title: 'Frozen fixture', sourceName: 'Frozen owner context', sourceUrl: null,
      content: JSON.stringify({ holdings: [{ ticker: 'AAPL', market: 'US', shares: '10' }, { ticker: 'MSFT', market: 'US', shares: '20' }], cash: [{ currency: 'HKD', amount: null }] }),
      role: 'fundamental' as const, evidenceType: 'other', relevanceScore: 1, fetchedAt: now };
    await db.insert(councilSessions).values({ id, owner, profileVersion: 1, ticker: 'PORTFOLIO', language: 'en', status: 'running', revision: 1,
      profileSnapshot: { name: 'Fixture', template: 'balanced', tickers: [], minimumRating: 'Buy', customPrompt: '', maxOrderPct: 5,
        dailyLossLimitPct: 3, maxOrdersPerDay: 1, notifyOnProposal: false, council: { enabled: true, webResearch: false,
          members: [{ id: 'analyst', name: 'Analyst', role: 'researcher', model: 'fast', instructions: '' }] } },
      evidenceSnapshot: [frozen], checkpoint: { cycleId: randomUUID(), nextTurn: 0, turns: [{ memberId: 'analyst', phase: 'opening' }], toolKindsUsed: [], pendingResearch: [] } });
    const quotes = { getQuote: async (symbol: string) => { symbols.push(symbol); return { symbol, price: 10, currency: 'USD', market: 'US', timestamp: Date.now() }; } };
    const financial = { query: async (_who: string, request: unknown) => { financialRequests.push(request);
      return { status: 'succeeded', data: { timing: { dataAsOf: null } }, observedAt: now, asOf: now, sources: [], freshness: 'filing' }; } };
    const service = new ResearchToolsService(db, quotes as unknown as QuoteService, {} as EvidenceService, {} as ResearchMemoryService,
      undefined, financial as unknown as DataFinancialService);
    const scope: ResearchToolScope = { sessionId: id, revision: 1, memberId: 'analyst', memberName: 'Analyst', turn: 0,
      ticker: 'PORTFOLIO', language: 'en', webResearch: false, expiresAt: Date.now() + 60_000, frozenInstrumentIds: ['US:AAPL'] };
    const result = await service.call(owner, scope, { callId: 'quotes-1', name: 'get_portfolio_quotes', arguments: {} });
    assert.equal(result.status, 'succeeded'); assert.deepEqual(symbols, ['AAPL']);
    const denied = await service.call(owner, scope, { callId: 'financial-denied', name: 'get_portfolio_financials',
      arguments: { instrumentId: 'US:MSFT', provider: 'sec', operation: 'financials' } });
    assert.equal(denied.status, 'unavailable'); assert.equal(financialRequests.length, 0);
    const allowed = await service.call(owner, scope, { callId: 'financial-1', name: 'get_portfolio_financials',
      arguments: { instrumentId: 'US:AAPL', provider: 'sec', operation: 'financials' } });
    assert.equal(allowed.status, 'succeeded');
    assert.equal((financialRequests[0] as { symbol: string }).symbol, 'AAPL');
    assert.equal(service.runtimeEnvelope(allowed, 'invocation').provenance.dataAsOf, null);
    await db.update(councilSessions).set({ status: 'paused' }).where(eq(councilSessions.id, id));
    await service.call(owner, scope, { callId: 'quotes-after-stop', name: 'get_portfolio_quotes', arguments: {} });
    assert.deepEqual(symbols, ['AAPL']);
  } finally { await client.end(); await admin.unsafe(`drop schema ${ns} cascade`); await admin.end(); }
});

test('managed browser observations become member-private citeable evidence, while closing creates none', async () => {
  const url = process.env.RESEARCH_TEST_DATABASE_URL;
  assert.ok(url && new URL(url).pathname.includes('test'), 'Disposable database required');
  const ns = `browser_evidence_${randomUUID().replaceAll('-', '')}`, owner = randomUUID(), runId = randomUUID();
  const admin = postgres(url, { max: 1, onnotice: () => {} });
  const client = postgres(url, { max: 4, onnotice: () => {}, connection: { search_path: ns } });
  try {
    await admin.unsafe(`create schema ${ns}`);
    await client.unsafe(readFileSync('scripts/db/01_schema.sql', 'utf8'));
    await client.unsafe(readFileSync('scripts/db/53_agent_tool_runtime.sql', 'utf8'));
    const db = drizzle(client);
    const members = [{ id: 'analyst', name: 'Analyst', role: 'researcher' as const, model: 'fast' as const, instructions: '' }];
    const checkpoint = newCheckpoint(members, { independent: true });
    const [session] = await db.insert(councilSessions).values({ owner, profileVersion: 1, ticker: 'AAPL', language: 'en', status: 'running',
      profileSnapshot: { name: 'Fixture', template: 'balanced', tickers: [], minimumRating: 'Buy', customPrompt: '', maxOrderPct: 5,
        dailyLossLimitPct: 3, maxOrdersPerDay: 1, notifyOnProposal: false, council: { enabled: true, webResearch: true, members } },
      evidenceSnapshot: [], checkpoint }).returning();
    await db.insert(agentRuntimeRuns).values({ id: runId, owner, identityHash: 'a'.repeat(64), identity: {}, driver: 'controlled',
      frozenInputHash: 'b'.repeat(64), frozenInputEnc: 'fixture', policy: {} });
    const browsers = { open: async () => ({ sessionId: 'browser', expiresAt: Date.now() + 60_000 }),
      act: async () => ({ url: 'https://example.com/filing', title: 'Fixture filing', text: 'Revenue was 42.',
        links: [], observedAt: new Date().toISOString() }), close: async () => {} };
    const service = new ResearchToolsService(db, {} as never, {} as never, {} as never,
      undefined, undefined, undefined, undefined, undefined, browsers as never);
    const scope: ResearchToolScope = { sessionId: session.id, revision: session.revision, memberId: 'analyst', memberName: 'Analyst', turn: 0,
      ticker: 'AAPL', language: 'en', webResearch: true, expiresAt: Date.now() + 60_000,
      runtimeScope: { owner, runId, leaseToken: 'fixture', sourceVersions: [] } as never };
    const read = await service.call(owner, scope, { callId: 'browse', name: 'browser_research', arguments: { action: 'read' } });
    assert.equal(read.status, 'succeeded');
    assert.ok((read.data as { evidenceId?: string }).evidenceId, 'the final answer must be able to cite this observation');
    const closed = await service.call(owner, scope, { callId: 'close', name: 'browser_research', arguments: { action: 'close' } });
    assert.equal(closed.status, 'succeeded');
    assert.equal((closed.data as { evidenceId?: string }).evidenceId, undefined);
    const [saved] = await db.select().from(councilSessions).where(eq(councilSessions.id, session.id));
    assert.equal(saved.evidenceSnapshot.length, 0);
    const privateEvidence = saved.checkpoint?.simple?.privateEvidence?.analyst ?? [];
    assert.equal(privateEvidence.length, 1);
    assert.match(privateEvidence[0].content, /Revenue was 42/);
    assert.equal(privateEvidence[0].id, (read.data as { evidenceId: string }).evidenceId);
  } finally { await client.end(); await admin.unsafe(`drop schema ${ns} cascade`); await admin.end(); }
});
