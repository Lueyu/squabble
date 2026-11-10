import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { analysis, paperAccounts, paperOrders, paperTrades } from '../../database/schema';
import { councilMessages, councilReports, councilSessions, councilRevisionRequests } from '../../database/council.schema';
import { councilMemberAttempts, simpleCouncilRequests } from '../../database/simple-council.schema';
import { researchDocuments, researchDocumentVersions } from '../../database/research-documents.schema';
import { researchDeletionRequests } from '../../database/research-deletions.schema';
import { ResearchDocumentsService } from './research-documents.service';
import { CouncilService } from '../council/council.service';
import { SimpleCouncilService } from '../council/simple-council.service';
import { CouncilRecoveryService } from '../council/council-recovery.service';
import { CouncilReportResumeService } from '../council/council-report-resume.service';
import { ChannelBriefsService } from '../channel/channel-briefs.service';
import { ChannelService } from '../channel/channel.service';
import { channelBriefs, channelBubbles } from '../../database/channel.schema';
import { ResearchMemoryService } from '../research-memory/research-memory.service';
import { normalizeBuilderConfig } from '../paper-trading/agent-builder.rules';
import { newCheckpoint } from '../council/council.dialogue';
import { lockMemoryOwner } from '../research-memory/research-memory.fence';

test('durable research deletion: owner/CAS receipts, independent versions and paid-task/source fences', {
  skip: !process.env.RESEARCH_TEST_DATABASE_URL,
}, async t => {
  const namespace = `research_delete_${randomUUID().replaceAll('-', '')}`;
  const admin = postgres(process.env.RESEARCH_TEST_DATABASE_URL!, { max: 1, onnotice: () => {} });
  const client = postgres(process.env.RESEARCH_TEST_DATABASE_URL!, { max: 6, onnotice: () => {}, connection: { search_path: namespace } });
  await admin`CREATE SCHEMA ${admin(namespace)}`;
  try {
    for (const file of readdirSync('scripts/db').filter(name => /^\d\d_.*\.sql$/u.test(name) && !name.startsWith('02_')).sort()) {
      await client.unsafe(readFileSync(`scripts/db/${file}`, 'utf8'));
    }
    await client.unsafe(readFileSync('scripts/db/49_research_deletions.sql', 'utf8'));
    const db = drizzle(client), owner = randomUUID(), stranger = randomUUID();
    const documents = new ResearchDocumentsService(db);
    let calls = 0;
    const forbidden = async () => { calls++; throw new Error('No model dispatch is permitted'); };
    const llm = { chatFastJSON: forbidden, isConfigured: async () => false };
    const council = new CouncilService(db, llm as never, {} as never, {} as never, {} as never,
      undefined, undefined, undefined, undefined, documents);
    const simple = new SimpleCouncilService(db, council, llm as never, undefined, undefined, documents);
    simple.resolveMembers = async () => ({ members: [], executors: [] });
    const config = normalizeBuilderConfig({ name: 'Fictional only', template: 'guard', tickers: ['TEST'], minimumRating: 'Buy',
      customPrompt: '', maxOrderPct: 5, dailyLossLimitPct: 3, maxOrdersPerDay: 1, notifyOnProposal: false, priceRules: [], language: 'en' });
    config.council = { enabled: true, members: [], webResearch: false };
    const session = async (values: Partial<typeof councilSessions.$inferInsert> = {}) => {
      const [row] = await db.insert(councilSessions).values({ owner, ticker: 'TEST', scene: 'stock', title: 'Fictional task',
        profileVersion: 1, profileSnapshot: config, status: 'completed', checkpoint: newCheckpoint([], { independent: true }), ...values }).returning();
      return row;
    };
    const published = async () => {
      const row = await session();
      const [report] = await db.insert(councilReports).values({ owner, sessionId: row.id, version: 1, revision: row.revision,
        decision: 'wait', summary: 'Fictional archived conclusion', dissent: [], nextReviewCondition: 'Check a fictional source',
        evidence: [], tokensUsed: 0, engine: 'llm', publicationOutcome: 'succeeded' }).returning();
      const version = await documents.importSource(owner, { type: 'council', id: report.id });
      return { row, report, version };
    };

    await t.test('delete exactly one version, clear adoption, preserve other versions and durable retries', async () => {
      const first = await documents.submit(owner, { idempotencyKey: 'one', title: 'One', kind: 'deep', content: 'One',
        availableAt: '2026-01-01T00:00:00Z', sections: [{ id: 'summary', title: 'One', content: 'One' }] });
      const draft = await documents.createDraft(owner, first.id, { title: 'Two', content: 'Two', changeReason: 'Fictional correction' });
      const second = await documents.publishDraft(owner, draft.id, draft.revision);
      await documents.adopt(owner, second.id, null);
      const frozen = (await documents.resolveReferences(owner, [{ versionId: second.id }]))[0];
      const retained = await session({ references: [{ versionId: second.id }], resolvedReferences: [frozen] });
      const input = { expectedVersion: second.version, requestKey: randomUUID() };
      await assert.rejects(documents.deleteVersion(stranger, second.id, input), /REPORT_NOT_FOUND/);
      await assert.rejects(documents.deleteVersion(owner, second.id, { ...input, expectedVersion: 90 }), /RESEARCH_DELETE_REVISION_CONFLICT/);
      const [deleted, retry] = await Promise.all([documents.deleteVersion(owner, second.id, input), documents.deleteVersion(owner, second.id, input)]);
      assert.deepEqual(deleted, retry);
      assert.deepEqual(await new ResearchDocumentsService(db).deleteVersion(owner, second.id, input), deleted);
      await assert.rejects(documents.deleteVersion(owner, first.id, input), /RESEARCH_DELETE_REQUEST_CONFLICT/);
      assert.equal((await documents.getVersion(owner, first.id)).content, 'One');
      await assert.rejects(documents.getVersion(owner, second.id), /REPORT_NOT_FOUND/);
      await assert.rejects(documents.publishDraft(owner, draft.id, draft.revision), /REPORT_NOT_FOUND/);
      await assert.rejects(documents.resolveReferences(owner, [{ versionId: second.id }]), /REPORT_NOT_FOUND/);
      await assert.rejects(db.transaction(async tx => { await lockMemoryOwner(tx, owner); await documents.assertExecutionSourcesInTransaction(tx, owner, [{ versionId: second.id }], new Date()); }), /REPORT_NOT_FOUND/);
      const [document] = await db.select().from(researchDocuments).where(eq(researchDocuments.id, first.reportId));
      assert.equal(document.latestVersionId, first.id); assert.equal(document.adoptedVersionId, null);
      const [saved] = await db.select().from(councilSessions).where(eq(councilSessions.id, retained.id));
      assert.deepEqual(saved.resolvedReferences, [frozen]);
      const index = await documents.list(owner, { history: true });
      assert.ok(index.items.some(item => item.id === first.id)); assert.ok(!index.items.some(item => item.id === second.id));
    });

    await t.test('legacy imports cannot revive a deleted version; a genuinely new daily result can be published', async () => {
      const [legacy] = await db.insert(analysis).values({ owner, ticker: 'TEST', analysisDate: '2026-11-01', analysis: 'Old fictional result' }).returning();
      const first = await documents.importSource(owner, { type: 'daily', id: legacy.id });
      await documents.deleteVersion(owner, first.id, { expectedVersion: 1, requestKey: randomUUID() });
      await assert.rejects(documents.importSource(owner, { type: 'daily', id: legacy.id }), /REPORT_NOT_FOUND/);
      for (let i = 0; i < 2; i++) assert.ok(!(await documents.list(owner, { history: true })).items.some(item => item.id === first.id));
      await documents.writeDaily(owner, { ticker: 'TEST', analysisDate: legacy.analysisDate, analysis: 'New fictional result' });
      const next = await documents.importSource(owner, { type: 'daily', id: legacy.id });
      assert.equal(next.version, 2); assert.notEqual(next.id, first.id); assert.equal(next.reportId, first.reportId);
      const rows = await db.select().from(researchDocumentVersions).where(eq(researchDocumentVersions.reportId, first.reportId));
      assert.equal(rows.length, 2); assert.ok(rows.find(row => row.id === first.id)?.deletedAt);
    });

    await t.test('task deletion retains reports, messages and executed trades, blocks every replay/resume and late publication', async () => {
      const { row, report, version } = await published();
      const [message] = await db.insert(councilMessages).values({ owner, sessionId: row.id, role: 'user', memberName: 'Fixture', content: 'Saved input', revision: 1 }).returning();
      const [account] = await db.insert(paperAccounts).values({ owner, name: 'Fictional ledger' }).returning();
      const [order] = await db.insert(paperOrders).values({ owner, accountId: account.id, ticker: 'TEST', side: 'buy', quantity: '1', status: 'filled' }).returning();
      await db.insert(paperTrades).values({ owner, accountId: account.id, orderId: order.id, ticker: 'TEST', side: 'buy', quantity: '1', price: '10', fee: '0', cashAfter: '90' });
      await db.update(councilReports).set({ paperOrderId: order.id }).where(eq(councilReports.id, report.id));
      const create = { message: 'Saved input', requestKey: randomUUID() };
      await db.insert(simpleCouncilRequests).values({ owner, sessionId: row.id, requestKey: create.requestKey,
        inputHash: createHash('sha256').update(JSON.stringify({ operation: 'create', ...create })).digest('hex') });
      const input = { expectedRevision: row.revision, requestKey: randomUUID() };
      await assert.rejects(simple.delete(stranger, row.id, input), /not found/);
      const result = await simple.delete(owner, row.id, input);
      assert.deepEqual(await simple.delete(owner, row.id, input), result);
      assert.ok(!(await simple.list(owner)).some(item => item.id === row.id));
      await assert.rejects(simple.create(owner, create), /not found/);
      await assert.rejects(council.runSession(owner, row.id), /not found/);
      await assert.rejects(council.pauseSession(owner, row.id), /not found/);
      await assert.rejects(simple.rename(owner, row.id, { title: 'Restore', requestKey: randomUUID() }), /not found/);
      await assert.rejects(simple.addMessage(owner, row.id, { message: 'Restore', requestKey: randomUUID() }), /not found/);
      await assert.rejects(new CouncilRecoveryService(db).reserve(owner, row.id, { memberId: 'test', action: 'retry_member', expectedRevision: row.revision, requestKey: randomUUID() }), /not found/);
      await assert.rejects(new CouncilReportResumeService(db).reserve(owner, row.id, { expectedRevision: row.revision, requestKey: randomUUID() }), /not found/);
      await council.onModuleInit(); await simple.onApplicationBootstrap();
      assert.equal((await documents.getVersion(owner, version.id)).sourceStatus, 'missing');
      await assert.rejects(documents.resolveReferences(owner, [{ versionId: version.id }]), /REPORT_SOURCE_MISSING/);
      await assert.rejects(documents.importSource(owner, { type: 'council', id: report.id }), /REPORT_SOURCE_NOT_FOUND/);
      assert.equal(await (council as unknown as { publish: (...args: unknown[]) => Promise<boolean> }).publish(owner, row, {}, 'llm', null), false);
      await assert.rejects(db.update(councilSessions).set({ deletedAt: null, status: 'running' }).where(eq(councilSessions.id, row.id)), /RESEARCH_DELETED|Failed query/);
      assert.equal((await db.select().from(councilMessages).where(eq(councilMessages.id, message.id))).length, 1);
      assert.equal((await db.select().from(paperTrades).where(eq(paperTrades.orderId, order.id))).length, 1);
      assert.equal((await db.select().from(councilReports).where(eq(councilReports.id, report.id)))[0].paperOrderId, order.id);
    });

    await t.test('active, uncertain, stale and unresolved remote tasks require settlement without dispatch', async () => {
      const running = await session({ status: 'running' });
      await assert.rejects(simple.delete(owner, running.id, { expectedRevision: 1, requestKey: randomUUID() }), /REQUIRES_SETTLEMENT/);
      const uncertain = await session({ status: 'paused' });
      await db.insert(councilMemberAttempts).values({ owner, sessionId: uncertain.id, cycleId: uncertain.checkpoint!.cycleId, memberId: 'fixture',
        attempt: 1, revision: 1, turn: 0, resourceKey: 'local:fixture', inputHash: 'fictional', inputSnapshot: {}, status: 'unknown', dispatchStarted: true });
      await assert.rejects(simple.delete(owner, uncertain.id, { expectedRevision: 1, requestKey: randomUUID() }), /REQUIRES_SETTLEMENT/);
      const remote = await session({ status: 'paused', checkpoint: { ...newCheckpoint([], { independent: true }),
        remote: { agentId: 'fixture', taskId: 'unknown-fixture', messageId: randomUUID(), turn: 0, revision: 1, dispatchStarted: true } } });
      await assert.rejects(simple.delete(owner, remote.id, { expectedRevision: 1, requestKey: randomUUID() }), /REQUIRES_SETTLEMENT/);
      const revised = await session({ revision: 2 });
      const key = randomUUID();
      await assert.rejects(simple.delete(owner, revised.id, { expectedRevision: 1, requestKey: key }), /REVISION_CONFLICT/);
      assert.equal((await db.select().from(researchDeletionRequests).where(eq(researchDeletionRequests.requestKey, key))).length, 0);
      assert.ok((await simple.delete(owner, revised.id, { expectedRevision: 2, requestKey: key })).deleted);
      const editing = await session();
      await db.insert(councilRevisionRequests).values({ owner, sessionId: editing.id, requestKey: randomUUID(), inputHash: 'fixture', status: 'pending' });
      await assert.rejects(simple.delete(owner, editing.id, { expectedRevision: 1, requestKey: randomUUID() }), /REQUIRES_SETTLEMENT/);
    });

    await t.test('deleting the original report disables memory recall and archival without deleting memory history', async () => {
      const { row, report, version } = await published();
      const memory = new ResearchMemoryService(db, { detectMarket: (ticker: string) => ({ market: 'US', displaySymbol: ticker, symbolNative: ticker }) } as never);
      const input = { sessionId: row.id, ticker: 'TEST', language: 'zh-CN' as const, report: { ...report, createdAt: report.createdAt.toISOString() } };
      const saved = await memory.archiveReport(owner, input);
      assert.ok(saved);
      const draft = await documents.createDraft(owner, version.id, { title: 'Manual sibling', content: 'Manual sibling', changeReason: 'Fictional correction' });
      const sibling = await documents.publishDraft(owner, draft.id, 1);
      await documents.deleteVersion(owner, sibling.id, { expectedVersion: sibling.version, requestKey: randomUUID() });
      assert.equal((await memory.getMemory(owner, saved.id)).sourceStatus, 'available');
      await documents.deleteVersion(owner, version.id, { expectedVersion: version.version, requestKey: randomUUID() });
      assert.equal((await memory.getMemory(owner, saved.id)).sourceStatus, 'source-deleted');
      await assert.rejects(memory.archiveReport(owner, input), /MEMORY_SOURCE_NOT_FOUND/);
      assert.ok((await documents.list(owner, { history: true })).items.every(item => item.id !== version.id));
    });
    await t.test('deleting a task fences existing and newly compiled channel briefs at final publication', async () => {
      const { row, report, version } = await published();
      await db.update(councilSessions).set({ checkpoint: { ...row.checkpoint!, simple: { ...row.checkpoint!.simple!, researchOnly: true } } }).where(eq(councilSessions.id, row.id));
      const quotes = { getQuote: forbidden };
      const channel = new ChannelService(db, quotes as never);
      await channel.onModuleInit();
      await channel.ingestReport(owner, { id: version.id, revision: version.version, title: version.title,
        content: report.summary, sections: version.sections, createdAt: report.createdAt.toISOString(),
        source: { type: 'council', id: report.id, researchOnly: true } });
      const briefs = new ChannelBriefsService(db, channel, quotes as never);
      await (briefs as unknown as { compilePublished(): Promise<void> }).compilePublished();
      const stored = await db.select().from(channelBriefs).where(eq(channelBriefs.owner, owner));
      assert.ok(stored.length > 0);
      await simple.delete(owner, row.id, { expectedRevision: row.revision, requestKey: randomUUID() });
      // Even a dispatcher that already read a ready brief must recheck inside the owner fence.
      assert.equal(await channel.publishTemplate(owner, { briefId: stored[0].id } as never), null);
      await briefs.tick();
      const after = await db.select().from(channelBriefs).where(eq(channelBriefs.owner, owner));
      assert.equal(after.length, stored.length);
      assert.ok(after.every(item => item.data.status === 'invalidated'));
      assert.equal((await db.select().from(channelBubbles).where(eq(channelBubbles.owner, owner))).length, 0);
    });
    assert.equal(calls, 0);
  } finally {
    await client.end();
    await admin`DROP SCHEMA ${admin(namespace)} CASCADE`;
    await admin.end();
  }
});
