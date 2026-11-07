import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { UserInvestmentStrategyService } from './user-investment-strategy.service';
import { ResearchDocumentsService } from '../research-documents/research-documents.service';
import { userInvestmentStrategies } from '../../database/user-investment-strategies.schema';

test('long research sources save as complete observations while execution placeholders remain unavailable', async t => {
  assert.ok(process.env.STRATEGY_TEST_DATABASE_URL, 'Disposable strategy database required');
  const namespace = `report_source_${randomUUID().replaceAll('-', '')}`;
  const admin = postgres(process.env.STRATEGY_TEST_DATABASE_URL!, { max: 1, onnotice: () => {} });
  const client = postgres(process.env.STRATEGY_TEST_DATABASE_URL!, { max: 5, onnotice: () => {}, connection: { search_path: namespace } });
  await admin`CREATE SCHEMA ${admin(namespace)}`;
  try {
    for (const name of ['01_schema.sql', '39_user_investment_strategies.sql']) await client.unsafe(readFileSync(`scripts/db/${name}`, 'utf8'));
    const db = drizzle(client), owner = randomUUID(), documents = new ResearchDocumentsService(db);
    let modelCalls = 0;
    const service = new UserInvestmentStrategyService(db, documents, { json: async () => { modelCalls++; throw new Error('No model expected'); } } as never);
    const body = ('Fictional holdings and confirmed cash.\n\n'.repeat(400)).slice(0, 14652);
    const placeholder = 'No structured execution proposal was returned.';
    const sections = [{ id: 'summary', title: 'Research summary', content: body },
      { id: 'execution-strategy', title: 'Execution strategy', content: placeholder }];
    const rawContent = sections.map(section => section.content).join('\n\n');
    const version = await documents.submit(owner, { idempotencyKey: 'long-fictional-research', title: 'Full fictional research', kind: 'portfolio', ticker: 'PORTFOLIO',
      content: rawContent, sections, snapshot: { executionPlanError: 'missing' }, availableAt: new Date().toISOString() });
    const source = { kind: 'report' as const, versionId: version.id };
    const startsAt = new Date().toISOString(), endsAt = new Date(Date.now() + 86400000).toISOString();
    const manual = (count: number) => ({ title: 'Manual strategy', body: 'Keep this manual view', timezone: 'Asia/Shanghai', startsAt, endsAt,
      entries: Array.from({ length: count }, (_, i) => ({ id: `manual_${i}`, text: `Retained manual thought ${i}`, sourceKeys: [] })) });

    await t.test('preview and import preserve the complete raw source and split readable text without a model or directives', async () => {
      const preview = await service.sourcePreview(owner, source);
      assert.equal(preview.entries.length, 2);
      assert.equal(preview.entries.map(entry => entry.text).join(''), preview.source.readableContent);
      assert.doesNotMatch(preview.source.readableContent!, /No structured execution/);
      assert.equal(preview.source.content, rawContent);
      assert.equal(preview.source.contentHash, createHash('sha256').update(rawContent).digest('hex'));
      assert.ok(preview.entries.every(entry => entry.text.length <= 12000 && !entry.directive && !entry.mandateRule));
      const saved = await service.importSource(owner, source);
      assert.deepEqual(saved.content.entries, preview.entries);
      assert.equal(saved.status, 'draft'); assert.equal(saved.sources[0].versionId, version.id);
      assert.equal((await service.importSource(owner, source)).id, saved.id);
      assert.equal((await service.preview(owner, saved.id, saved.revision)).preview!.directives.length, 0);
      assert.equal((await service.workspace(owner)).current, null); assert.equal(modelCalls, 0);
      const draft = await service.create(owner, manual(1));
      const appended = await service.addSource(owner, draft.id, draft.revision, source);
      assert.equal(appended.content.body, draft.content.body);
      assert.deepEqual(appended.content.entries[0], draft.content.entries[0]);
      assert.equal(appended.content.entries.length, 3);
      await assert.rejects(service.sourcePreview(randomUUID(), source), /NOT_FOUND|not found/i);
      await assert.rejects(service.sourcePreview(owner, { ...source, sectionId: 'execution-strategy' }), /No validated report execution strategy/);
    });

    await t.test('preview enforces the same entry and source capacities as save before any draft is changed', async () => {
      const crowded = await service.create(owner, manual(19));
      await assert.rejects(service.sourcePreview(owner, source, crowded.id), /At most 20/);
      await assert.rejects(service.addSource(owner, crowded.id, crowded.revision, source), /At most 20/);
      assert.deepEqual(await service.get(owner, crowded.id), crowded);
      const fullSources = await service.create(owner, manual(0));
      const original = (await service.sourcePreview(owner, source)).source;
      await db.update(userInvestmentStrategies).set({ sources: Array.from({ length: 20 }, (_, i) => ({ ...original, key: `report:existing_${i}` })) })
        .where(eq(userInvestmentStrategies.id, fullSources.id));
      const before = await service.get(owner, fullSources.id);
      await assert.rejects(service.sourcePreview(owner, source, fullSources.id), /At most 20/);
      await assert.rejects(service.addSource(owner, fullSources.id, fullSources.revision, source), /At most 20/);
      assert.deepEqual(await service.get(owner, fullSources.id), before);
    });

    await t.test('oversized raw and readable sources remain bounded and revoked versions cannot be imported', async () => {
      const hugeRaw = await documents.submit(owner, { idempotencyKey: 'huge-raw', title: 'Too large', kind: 'portfolio', content: 'x'.repeat(200001),
        sections: [{ id: 'summary', title: 'Summary', content: 'Small readable text' }], availableAt: new Date().toISOString() });
      await assert.rejects(service.sourcePreview(owner, { kind: 'report', versionId: hugeRaw.id }), /200000/);
      const hugeReadable = await documents.submit(owner, { idempotencyKey: 'huge-readable', title: 'Too large', kind: 'portfolio', content: 'Stored record',
        sections: [0, 1, 2].map(i => ({ id: `section${i}`, title: `Section ${i}`, content: 'x'.repeat(70000) })), availableAt: new Date().toISOString() });
      await assert.rejects(service.sourcePreview(owner, { kind: 'report', versionId: hugeReadable.id }), /200000/);
      await documents.revoke(owner, version.id, 'Fictional source withdrawn');
      await assert.rejects(service.sourcePreview(owner, source), /revoked/i);
      assert.equal(modelCalls, 0);
    });
  } finally { await client.end(); await admin`DROP SCHEMA ${admin(namespace)} CASCADE`; await admin.end(); }
});
