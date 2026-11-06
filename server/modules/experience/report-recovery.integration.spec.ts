import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { CurrentResearchService } from './current-research.service';
import { ResearchDocumentsService } from '../research-documents/research-documents.service';
import { researchCurrentViews } from '../../database/simple-experience.schema';
import { councilReports, councilSessions } from '../../database/council.schema';
import { automaticResearchTasks } from '../../database/investment-policy.schema';
import { researchDocumentVersions } from '../../database/research-documents.schema';

test('saved daily-team reports recover locally from legacy formatting failures', {
  skip: !process.env.EXPERIENCE_TEST_DATABASE_URL,
}, async () => {
  const namespace = 'report_recovery_' + randomUUID().replaceAll('-', '');
  const admin = postgres(process.env.EXPERIENCE_TEST_DATABASE_URL!, { max: 1, onnotice: () => {} });
  const client = postgres(process.env.EXPERIENCE_TEST_DATABASE_URL!, {
    max: 4, onnotice: () => {}, connection: { search_path: namespace },
  });
  await admin`CREATE SCHEMA ${admin(namespace)}`;
  try {
    for (const name of readdirSync('scripts/db').filter(name => /^\d\d_.*\.sql$/u.test(name) && !name.startsWith('02_')).sort()) {
      await client.unsafe(readFileSync('scripts/db/' + name, 'utf8'));
    }
    const db = drizzle(client), owner = randomUUID(), documents = new ResearchDocumentsService(db);
    const service = new CurrentResearchService(db, documents, {} as never, {} as never);
    const date = '2026-11-06', raw = JSON.stringify({ response: { thesis: 'The retained daily finding.', risks: [], nextChecks: [] } });
    const [session] = await db.insert(councilSessions).values({ owner, ticker: 'PORTFOLIO', scene: 'portfolio_daily',
      title: 'Saved daily team report', status: 'completed', profileVersion: 1, profileSnapshot: {} as never,
      checkpoint: { cycleId: randomUUID(), simple: { researchOnly: true, contextDate: date } } as never }).returning();
    const [report] = await db.insert(councilReports).values({ owner, sessionId: session.id, version: 1, revision: 1,
      decision: 'wait', summary: raw, dissent: [], nextReviewCondition: 'Read the next filing.', evidence: [],
      engine: 'local', publicationOutcome: 'succeeded' }).returning();
    const archive = await documents.importSource(owner, { type: 'council', id: report.id });
    const [automatic] = await db.insert(automaticResearchTasks).values({ owner, key: 'daily-recovery', purpose: 'portfolio', dateKey: date }).returning();
    const [view] = await db.insert(researchCurrentViews).values({ owner, topicKey: 'portfolio', dateKey: date,
      state: 'failed', taskKind: 'formatting_portfolio', taskId: session.id, automaticTaskId: automatic.id, error: 'Formatting needs review.' }).returning();
    const pending = await service.get(owner, 'portfolio', date);
    assert.equal(pending.returnedDocumentId, archive.id, 'the exact returned archive stays reachable before recovery');

    const recovered = await service.reformat(owner, { topicKey: 'portfolio', date, requestKey: 'saved-daily' }, 'Asia/Shanghai');
    assert.equal(recovered.state, 'ready');
    assert.equal(recovered.documentId, archive.id);
    assert.match(recovered.content, /The retained daily finding/u);
    assert.equal((await db.select().from(automaticResearchTasks).where(eq(automaticResearchTasks.id, automatic.id)))[0].state, 'completed');
    assert.equal((await service.reformat(owner, { topicKey: 'portfolio', date, requestKey: 'saved-daily' }, 'Asia/Shanghai')).documentId, archive.id);
    assert.deepEqual(await documents.getVersion(owner, archive.id), archive, 'formatting never rewrites the immutable report');
    assert.equal((await db.select().from(councilReports).where(eq(councilReports.id, report.id)))[0].summary, raw);

    await db.update(researchCurrentViews).set({ state: 'failed', taskKind: 'formatting_daily_research', currentDocumentId: null }).where(eq(researchCurrentViews.id, view.id));
    await db.update(automaticResearchTasks).set({ state: 'claimed' }).where(eq(automaticResearchTasks.id, automatic.id));
    await service.reconcile();
    assert.equal((await service.get(owner, 'portfolio', date)).state, 'ready', 'a fixed reader also repairs retained formatting receipts without an executor');
    assert.equal((await db.select().from(automaticResearchTasks).where(eq(automaticResearchTasks.id, automatic.id)))[0].state, 'completed');

    const [foreign] = await db.insert(researchCurrentViews).values({ owner: randomUUID(), topicKey: 'portfolio', dateKey: date,
      state: 'failed', taskKind: 'formatting_portfolio', taskId: session.id }).returning();
    await assert.rejects(service.reformat(foreign.owner, { topicKey: 'portfolio', date, requestKey: 'foreign' }, 'Asia/Shanghai'), /NO_COMPLETED_RESULT/u);

    await db.update(researchDocumentVersions).set({ revokedAt: new Date() }).where(eq(researchDocumentVersions.id, archive.id));
    await db.update(researchCurrentViews).set({ state: 'failed', taskKind: 'formatting_daily_research', currentDocumentId: null }).where(eq(researchCurrentViews.id, view.id));
    await assert.rejects(service.reformat(owner, { topicKey: 'portfolio', date, requestKey: 'revoked' }, 'Asia/Shanghai'), /REPORT_REVOKED/u);
    await service.reconcile();
    assert.equal((await db.select().from(researchCurrentViews).where(eq(researchCurrentViews.id, view.id)))[0].state, 'failed', 'automatic recovery never republishes revoked material');
  } finally {
    await client.end();
    await admin`DROP SCHEMA ${admin(namespace)} CASCADE`;
    await admin.end();
  }
});
