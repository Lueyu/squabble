import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq, or } from 'drizzle-orm';
import { councilReports, councilSessions } from '../../database/council.schema';
import type { BuilderConfig } from '../../../shared/api.interface';
import type { ResearchToolScope } from '../../../shared/research-tools.interface';
import type { QuoteService } from '../quote/quote.service';
import type { EvidenceService } from '../multi-agent/evidence.service';
import { ResearchToolsService } from './research-tools.service';

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
  try { await db.delete(councilSessions).where(or(eq(councilSessions.owner, owner), eq(councilSessions.owner, otherOwner))); }
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
    { collectResearch: async () => { throw new Error('Provider must not be called'); } } as unknown as EvidenceService);
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
  const denied = await service.call(otherOwner, scope, request);
  assert.equal(denied.status, 'cancelled'); assert.ok(!JSON.stringify(denied).includes('Owned prior'));
  await db.update(councilSessions).set({ revision: 5 }).where(eq(councilSessions.id, current.id));
  const stale = await service.call(owner, scope, request);
  assert.equal(stale.errorCode, 'RESEARCH_SCOPE_EXPIRED');
});
