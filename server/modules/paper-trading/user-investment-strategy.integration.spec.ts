import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { UserInvestmentStrategyService } from './user-investment-strategy.service';
import { ResearchDocumentsService } from '../research-documents/research-documents.service';
import { councilMessages, councilSessions } from '../../database/council.schema';
import { userInvestmentStrategies, userInvestmentStrategyRevisions } from '../../database/user-investment-strategies.schema';
import type { StrategyDraftInput } from '../../../shared/user-investment-strategy.interface';

test('saved strategy drafts, immutable sources, confirmations and runtime activation share ownership and atomic fences', { skip: !process.env.STRATEGY_TEST_DATABASE_URL }, async () => {
  const namespace = 'user_strategy_' + randomUUID().replaceAll('-', '');
  const admin = postgres(process.env.STRATEGY_TEST_DATABASE_URL!, { max: 1, onnotice: () => undefined });
  const client = postgres(process.env.STRATEGY_TEST_DATABASE_URL!, { max: 8, onnotice: () => undefined, connection: { search_path: namespace } });
  await admin.unsafe('CREATE SCHEMA ' + namespace);
  try {
    await client.unsafe(readFileSync('scripts/db/01_schema.sql', 'utf8'));
    await client.unsafe(readFileSync('scripts/db/39_user_investment_strategies.sql', 'utf8'));
    await client.unsafe(readFileSync('scripts/db/39_user_investment_strategies.sql', 'utf8'));
    const db = drizzle(client); const owner = randomUUID(); const stranger = randomUUID();
    const documents = new ResearchDocumentsService(db); let calls = 0;
    let modelOutput: unknown = { entries: [] }; let duringPreparation: (() => Promise<void>) | undefined;
    const model = { json: async () => { calls++; await duringPreparation?.(); return modelOutput; } };
    const service = new UserInvestmentStrategyService(db, documents, model as never);
    const now = new Date(); const end = new Date(now.getTime() + 86400000).toISOString();
    const content: StrategyDraftInput = { title: 'Fictional investor instructions', body: '只观察 AAPL', timezone: 'Asia/Shanghai', startsAt: now.toISOString(), endsAt: end,
      entries: [{ id: 'manual', text: '只观察 AAPL', sourceKeys: [] }] };
    const draft = await service.create(owner, content);
    assert.equal((await service.workspace(owner)).current, null);
    const ready = await service.preview(owner, draft.id, draft.revision);
    await db.transaction(tx => service.confirmInTransaction(tx, owner, draft.id, ready.revision, ready.preview!.contentHash, null, async () => undefined));
    const applied = (await service.workspace(owner)).current!;
    assert.equal(applied.id, draft.id);
    assert.equal(calls, 0, 'saving and deterministic preview must not invoke any provider');
    const edit = await service.create(owner, { ...content, body: '继续观察', entries: [{ id: 'manual', text: '继续观察', sourceKeys: [] }] }, applied.id);
    await service.update(owner, edit.id, edit.revision, { ...edit.content, title: 'New manual opinion' });
    assert.equal((await service.workspace(owner)).current!.content.body, content.body);
    await assert.rejects(service.update(owner, edit.id, edit.revision, edit.content), /changed/i);
    await assert.rejects(service.get(stranger, edit.id), /not found/i);
    await assert.rejects(service.update(owner, applied.id, applied.revision, applied.content), /immutable|changed/i);

    const report = await documents.submit(owner, { idempotencyKey: 'fictional-source', title: 'Fictional report', kind: 'deep', ticker: 'AAPL',
      content: 'AAPL 继续观察', sections: [{ id: 'view', title: 'View', content: 'AAPL 继续观察' }], availableAt: now.toISOString(), dataAsOf: now.toISOString() });
    const source = { kind: 'report' as const, versionId: report.id };
    const structuredSections = [{ id: 'summary', title: 'Summary', content: 'AAPL keep watching cash flow.' },
      { id: 'holdings', title: 'Holdings', content: JSON.stringify([{ ticker: 'AAPL', rationale: 'Wait for the next filing.', triggers: ['Check cash conversion'] }]) },
      { id: 'evidence', title: 'Raw evidence', content: JSON.stringify([{ title: 'Filing', sourceUrl: 'https://example.org/filing', content: 'PRIVATE_RAW_EVIDENCE' }]) }];
    const structuredReport = await documents.submit(owner, { idempotencyKey: 'structured-fictional-source', title: 'Structured report', kind: 'portfolio',
      content: structuredSections.map(section => `## ${section.title}\n\n${section.content}`).join('\n\n'), sections: structuredSections, availableAt: now.toISOString() });
    const whole = await service.sourcePreview(owner, { kind: 'report', versionId: structuredReport.id });
    assert.match(whole.entries[0].text, /AAPL keep watching cash flow/u);
    assert.match(whole.entries[0].text, /Wait for the next filing/u);
    assert.doesNotMatch(whole.entries[0].text, /PRIVATE_RAW_EVIDENCE|rationale|sourceUrl/u);
    const holdingSection = await service.sourcePreview(owner, { kind: 'report', versionId: structuredReport.id, sectionId: 'holdings' });
    assert.match(holdingSection.entries[0].text, /Wait for the next filing/u);
    assert.equal(holdingSection.source.content, structuredSections[1].content, 'the exact archived raw section remains pinned');
    const [sourceSession] = await db.insert(councilSessions).values({ owner, ticker: 'AAPL', title: 'Fictional message source', scene: 'stock',
      status: 'completed', profileVersion: 1, profileSnapshot: {} as never }).returning();
    const [opinionMessage] = await db.insert(councilMessages).values({ owner, sessionId: sourceSession.id, role: 'researcher', memberName: 'Fixture',
      content: 'Cash flow needs checking.', revision: 1, metadata: { response: { thesis: 'Cash flow needs checking.', evidencePoints: ['The filing records lower cash.'],
        risks: ['Liquidity risk remains.'], nextChecks: ['Read the next filing.'], details: 'Keep position sizes under review.' } } }).returning();
    const messageSource = { kind: 'message' as const, messageId: opinionMessage.id };
    const messageAddition = await service.sourcePreview(owner, messageSource);
    assert.match(messageAddition.entries[0].text, /Liquidity risk remains/u);
    assert.match(messageAddition.entries[0].text, /Keep position sizes under review/u);
    assert.equal(messageAddition.source.messageId, opinionMessage.id);
    assert.equal(messageAddition.source.sessionId, sourceSession.id);
    await assert.rejects(service.sourcePreview(stranger, messageSource), /not found/i);
    const [progressMessage] = await db.insert(councilMessages).values({ owner, sessionId: sourceSession.id, role: 'researcher', memberName: 'Fixture',
      content: 'Checking source', revision: 1, metadata: { phase: 'progress' } }).returning();
    await assert.rejects(service.sourcePreview(owner, { kind: 'message', messageId: progressMessage.id }), /released readable source/i);
    const target = await service.get(owner, edit.id);
    const diff = await service.sourcePreview(owner, source, target.id);
    assert.equal(diff.entries.length, 1); assert.equal((await service.get(owner, target.id)).revision, target.revision);
    const imported = await service.addSource(owner, target.id, target.revision, source);
    assert.equal(imported.content.body, target.content.body);
    assert.equal(imported.content.entries[0].text, target.content.entries[0].text);
    const retry = await service.addSource(owner, target.id, target.revision, source);
    assert.equal(retry.revision, imported.revision);
    assert.equal(retry.sources.length, 1);
    await assert.rejects(service.sourcePreview(stranger, source), /not[_ ]found/i);
    await documents.revoke(owner, report.id, 'fictional revoked evidence');
    assert.equal((await service.get(owner, target.id)).sources[0].content, 'AAPL 继续观察');
    await assert.rejects(service.sourcePreview(owner, source), /revoked/i);
    const revisions = await service.revisions(owner, target.id);
    assert.ok(revisions.items.length >= 3);
    assert.equal(revisions.items.find(row => row.revision === 1)!.sources.length, 0);

    const next = await service.create(owner, content, applied.id);
    const nextReady = await service.preview(owner, next.id, next.revision);
    await assert.rejects(db.transaction(tx => service.confirmInTransaction(tx, owner, next.id, nextReady.revision,
      nextReady.preview!.contentHash, applied.id, async () => { throw new Error('activation failed'); })), /activation failed/);
    assert.equal((await service.workspace(owner)).current!.id, applied.id);
    assert.equal((await service.get(owner, next.id)).status, 'draft');
    await assert.rejects(db.transaction(tx => service.confirmInTransaction(tx, owner, next.id, nextReady.revision,
      'stale-preview', applied.id, async () => undefined)), /preview/i);

    const naturalText = 'AAPL 到 100 买 10 股';
    const concrete = await service.create(owner, { ...content, body: naturalText, entries: [{ id: 'natural', text: naturalText, sourceKeys: [] }],
      limits: { maxPositionPct: 30, maxDailyIncreasePct: 10, maxDailyTurnoverPct: 30 } });
    modelOutput = { entries: [{ id: 'natural', directive: { ticker: 'AAPL', side: 'buy', trigger: { kind: 'price_lte', price: 100 }, quantity: 10,
      reviewedText: naturalText, numericEvidence: [{ field: 'trigger.price', value: 100, quote: '100' }, { field: 'quantity', value: 10, quote: '10' }] } }] };
    const prepared = await service.prepare(owner, concrete.id, concrete.revision, 'natural-first-preparation');
    assert.equal(prepared.preview!.directives[0].quantity, 10);
    assert.equal(prepared.content.entries[0].text, naturalText);
    assert.equal(calls, 1);
    assert.equal((await service.prepare(owner, concrete.id, concrete.revision, 'natural-first-preparation')).revision, prepared.revision);
    assert.equal(calls, 1, 'retrying one preparation must not invoke a provider twice');
    const changed = await service.update(owner, concrete.id, prepared.revision, { ...prepared.content, body: '只观察 AAPL', entries: [{ ...prepared.content.entries[0], text: '只观察 AAPL' }] });
    modelOutput = { entries: [] };
    const observed = await service.prepare(owner, changed.id, changed.revision, 'natural-observation-preparation');
    assert.equal(observed.preview!.entries[0].state, 'observation');
    assert.equal(observed.preview!.directives.length, 0);

    const late = await service.create(owner, concrete.content);
    duringPreparation = async () => { await service.update(owner, late.id, late.revision, { ...late.content, body: 'New manual instruction wins' }); };
    await assert.rejects(service.prepare(owner, late.id, late.revision, 'late-preparation-key'), /changed/i);
    const callsAfterLate = calls;
    await assert.rejects(service.prepare(owner, late.id, late.revision, 'late-preparation-key'), /already dispatched/i);
    assert.equal(calls, callsAfterLate);
    assert.equal((await service.get(owner, late.id)).content.body, 'New manual instruction wins');
    duringPreparation = undefined;

    const firstConcurrent = await service.create(owner, content); const secondConcurrent = await service.create(owner, content);
    const concurrentPreviews = await Promise.all([service.preview(owner, firstConcurrent.id, 1), service.preview(owner, secondConcurrent.id, 1)]);
    const results = await Promise.allSettled(concurrentPreviews.map(candidate => db.transaction(tx => service.confirmInTransaction(tx, owner,
      candidate.id, candidate.revision, candidate.preview!.contentHash, applied.id, async () => undefined))));
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1, 'only one concurrent total strategy can replace the same current strategy');
    assert.equal(results.filter(result => result.status === 'rejected').length, 1);

    const pagingOwner = randomUUID();
    const oldStrategies = await db.insert(userInvestmentStrategies).values(Array.from({ length: 105 }, (_, index) => ({ owner: pagingOwner,
      status: 'confirmed' as const, content: { ...content, title: `Fictional history ${index}` }, confirmedAt: now, createdAt: now, updatedAt: now }))).returning();
    const workspace = await service.workspace(pagingOwner);
    assert.equal(workspace.history.length, 20, 'the workspace returns a bounded recent history page');
    assert.ok(workspace.historyCursor);
    const seen = workspace.history.map(item => item.id); let cursor = workspace.historyCursor;
    while (cursor) { const page = await service.history(pagingOwner, cursor); seen.push(...page.items.map(item => item.id)); cursor = page.nextCursor; }
    assert.equal(seen.length, 105); assert.equal(new Set(seen).size, 105, 'all confirmations remain reachable once even at the same timestamp');
    assert.deepEqual(new Set(seen), new Set(oldStrategies.map(item => item.id)));
    await assert.rejects(service.history(stranger, oldStrategies[0].id), /not found/i);
    await assert.rejects(service.history(pagingOwner, 'not-an-owned-cursor'), /identifier/i);
    await assert.rejects(service.history(owner, edit.id), /confirmed/i);
    const oldDrafts = await db.insert(userInvestmentStrategies).values(Array.from({ length: 105 }, (_, index) => ({ owner: pagingOwner,
      status: 'draft' as const, content: { ...content, title: `Fictional draft ${index}` }, createdAt: now, updatedAt: now }))).returning();
    const draftWorkspace = await service.workspace(pagingOwner);
    assert.equal(draftWorkspace.drafts.length, 20); assert.ok(draftWorkspace.draftsCursor);
    const draftIds = draftWorkspace.drafts.map(item => item.id); let draftCursor = draftWorkspace.draftsCursor;
    while (draftCursor) { const page = await service.drafts(pagingOwner, draftCursor); draftIds.push(...page.items.map(item => item.id)); draftCursor = page.nextCursor; }
    assert.equal(draftIds.length, 105); assert.deepEqual(new Set(draftIds), new Set(oldDrafts.map(item => item.id)));
    await assert.rejects(service.drafts(stranger, oldDrafts[0].id), /not found/i);
    await assert.rejects(service.drafts(pagingOwner, oldStrategies[0].id), /draft/i);

    const revisionDraft = await service.create(pagingOwner, content);
    await db.insert(userInvestmentStrategyRevisions).values(Array.from({ length: 104 }, (_, index) => ({ owner: pagingOwner, strategyId: revisionDraft.id,
      revision: index + 2, snapshot: { ...revisionDraft, revision: index + 2 } })));
    const revisionPage = await service.revisions(pagingOwner, revisionDraft.id);
    assert.equal(revisionPage.items.length, 20); assert.ok(revisionPage.nextBefore);
    const revisionNumbers = revisionPage.items.map(item => item.revision); let before = revisionPage.nextBefore;
    while (before) { const page = await service.revisions(pagingOwner, revisionDraft.id, before); revisionNumbers.push(...page.items.map(item => item.revision)); before = page.nextBefore; }
    assert.deepEqual(revisionNumbers, Array.from({ length: 105 }, (_, index) => 105 - index));
    await assert.rejects(service.revisions(stranger, revisionDraft.id, 50), /not found/i);
  } finally { await client.end(); await admin.unsafe('DROP SCHEMA ' + namespace + ' CASCADE'); await admin.end(); }
});
