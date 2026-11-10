import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { councilReports, councilSessions } from '../../database/council.schema';
import { researchMemories, researchTheses } from '../../database/research-memory.schema';
import { ResearchMemoryService } from './research-memory.service';
import { QuoteService } from '../quote/quote.service';

test('global memory inventory preserves pagination, source visibility and owner isolation', {
  skip: !process.env.MEMORY_TEST_DATABASE_URL,
}, async () => {
  const url = process.env.MEMORY_TEST_DATABASE_URL!;
  const namespace = `memory_inventory_${randomUUID().replaceAll('-', '')}`;
  const admin = postgres(url, { max: 1, onnotice: () => {} });
  const client = postgres(url, { max: 4, onnotice: () => {}, connection: { search_path: namespace } });
  await admin`CREATE SCHEMA ${admin(namespace)}`;
  try {
    for (const name of readdirSync('scripts/db').filter(name => /^\d\d_.*\.sql$/u.test(name) && !name.startsWith('02_') && (Number(name.slice(0, 2)) <= 45 || name.startsWith('49_'))).sort()) {
      await client.unsafe(readFileSync(`scripts/db/${name}`, 'utf8'));
    }
    const db = drizzle(client), owner = randomUUID(), other = randomUUID();
    const service = new ResearchMemoryService(db, new QuoteService(db, undefined as never));
    for (const [index, user] of [owner, owner, other].entries()) {
      const [session] = await db.insert(councilSessions).values({ owner: user, ticker: 'TEST', profileVersion: 1, profileSnapshot: {} as never, status: 'completed' }).returning();
      const [report] = await db.insert(councilReports).values({ owner: user, sessionId: session.id, version: 1, revision: 1, summary: user === other ? 'FOREIGN SECRET' : `Saved ${index}`, decision: 'wait', dissent: [], nextReviewCondition: 'Review', evidence: [], engine: 'llm' }).returning();
      const [memory] = await db.insert(researchMemories).values({ owner: user, ticker: 'TEST', market: 'US', topic: 'general', language: 'en', sessionId: session.id, reportId: report.id, reportVersion: 1, reportRevision: 1, reportCreatedAt: report.createdAt, summary: report.summary, decision: 'wait', createdAt: new Date(`2026-11-0${index + 1}T00:00:00Z`) }).returning();
      await db.insert(researchTheses).values({ owner: user, memoryId: memory.id, status: 'candidate', content: { claim: report.summary, supportingEvidence: [], opposingEvidence: [], assumptions: [], indicators: [], invalidationConditions: [] } });
    }
    const first = await service.inventory(owner, { offset: 0, limit: 1 });
    const second = await service.inventory(owner, { offset: 1, limit: 1 });
    assert.equal(first.total, 2);
    assert.equal(first.memories.length, 1);
    assert.equal(first.theses.length, 1);
    assert.notEqual(first.memories[0].id, second.memories[0].id);
    assert.equal(JSON.stringify([first, second]).includes('FOREIGN SECRET'), false);
    assert.equal((await service.inventory(other)).total, 1);
    assert.equal((await service.inventory(randomUUID())).total, 0);
    await assert.rejects(service.inventory('', {}));
    await assert.rejects(service.inventory(owner, { limit: 101 }));
  } finally {
    await client.end();
    await admin`DROP SCHEMA ${admin(namespace)} CASCADE`;
    await admin.end();
  }
});
