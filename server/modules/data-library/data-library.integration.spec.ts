import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { DataLibraryService } from './data-library.service';
import { dataLibrarySources, dataLibraryVersions, dataLibraryJobs } from '../../database/data-library.schema';
import { encodeDataSecret } from './data-library.secrets';
import { DataLibraryError } from './data-library.fetch';
const databaseUrl = process.env.DATA_LIBRARY_TEST_DATABASE_URL ?? process.env.RESEARCH_TEST_DATABASE_URL;
test('data library owns and versions material, indexes Chinese, and removes all deleted evidence', {
  skip: !databaseUrl,
}, async () => {
  const namespace = `data_library_test_${randomUUID().replaceAll('-', '')}`;
  const admin = postgres(databaseUrl!, { max: 1, onnotice: () => {} });
  const client = postgres(databaseUrl!, { max: 3, onnotice: () => {}, connection: { search_path: namespace } });
  const owner = randomUUID(), other = randomUUID();
  try {
    await admin.unsafe(`CREATE SCHEMA ${namespace}`);
    await client.unsafe(readFileSync('scripts/db/50_data_library.sql', 'utf8')); await client.unsafe(readFileSync('scripts/db/51_browser_sources.sql', 'utf8'));
    const db = drizzle(client), service = new DataLibraryService(db);
    const page = await service.create(owner, { kind: 'page', title: '季度研究', text: '公司营收增长，现金流改善。' });
    assert.equal(page.versionCount, 1); assert.equal(page.state, 'ready');
    assert.equal((await service.list(other)).total, 0);
    await assert.rejects(service.detail(other, page.id), /DATA_SOURCE_NOT_FOUND/u);
    assert.equal((await service.list(owner, { q: '季度' })).total, 1);
    const results = await service.search(owner, { query: '现金流' }); assert.equal(results.items.length, 1);
    assert.equal((await service.list(owner, { q: '现金流' })).total, 1);
    const reference = { sourceId: page.id, versionId: page.latestVersionId! };
    assert.equal(await service.validateReferences(owner, [reference]), true);
    assert.equal(await service.validateReferences(other, [reference]), false);
    await service.update(owner, page.id, { enabled: false });
    assert.equal(await service.validateReferences(owner, [reference]), false);
    assert.equal((await service.search(owner, { query: '现金流' })).items.length, 0);
    assert.match((await service.version(owner, page.id, reference.versionId)).extractedText, /现金流改善/u);
    await service.update(owner, page.id, { enabled: true });
    assert.equal(await service.validateReferences(owner, [reference]), true);
    assert.equal((await service.search(owner, { query: '现金流' })).items.length, 1);
    const same = await service.update(owner, page.id, { text: '公司营收增长，现金流改善。' }); assert.equal(same.versionCount, 1);
    const changed = await service.update(owner, page.id, { text: '公司营收增长，但现金流需要观察。' }); assert.equal(changed.versionCount, 2);
    assert.match((await service.version(owner, page.id, reference.versionId)).extractedText, /现金流改善/u);
    await assert.rejects(service.update(other, page.id, { title: 'hijack' }), /DATA_SOURCE_NOT_FOUND/u);
    const png = await service.upload(owner, { title: '图像', fileName: 'chart.png', mimeType: 'image/png',
      description: '现金流对比图', data: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]).toString('base64') });
    assert.equal(png.state, 'needs-text'); assert.equal((await service.file(owner, png.id)).image, true);
    const updatedImage = await service.update(owner, png.id, { description: '新说明：估值对比图' });
    assert.equal(updatedImage.versionCount, 2); assert.equal(updatedImage.state, 'needs-text');
    assert.equal((await service.search(owner, { query: '估值对比图' })).items.length, 1);
    assert.equal((await service.search(owner, { query: '现金流对比图' })).items.length, 0);
    await assert.rejects(service.file(other, png.id), /DATA_SOURCE_NOT_FOUND/u);
    await service.remove(owner, page.id);
    assert.equal(await service.validateReferences(owner, [reference]), false);
    assert.equal((await service.search(owner, { query: '公司营收' })).items.length, 0);
    await assert.rejects(service.version(owner, page.id, reference.versionId), /DATA_SOURCE_NOT_FOUND/u);
    const [deleted] = await db.select().from(dataLibrarySources).where(eq(dataLibrarySources.id, page.id));
    assert.ok(deleted.deletedAt); assert.equal(deleted.secretEnc, null); assert.equal(deleted.title, '');
    await service.remove(owner, png.id); await assert.rejects(service.file(owner, png.id), /DATA_SOURCE_NOT_FOUND/u);
  } finally { await client.end(); await admin.unsafe(`DROP SCHEMA ${namespace} CASCADE`); await admin.end(); }
});
test('sync deduplicates versions, pauses expired authentication, schedules refresh, and cannot resurrect deleted sources', {
  skip: !databaseUrl,
}, async () => {
  const namespace = `data_sync_test_${randomUUID().replaceAll('-', '')}`;
  const admin = postgres(databaseUrl!, { max: 1, onnotice: () => {} });
  const client = postgres(databaseUrl!, { max: 3, onnotice: () => {}, connection: { search_path: namespace } });
  const owner = randomUUID(), previousKey = process.env.SETTINGS_ENCRYPTION_KEY;
  process.env.SETTINGS_ENCRYPTION_KEY = 'test-only-sync-encryption-key-123456';
  try {
    await admin.unsafe(`CREATE SCHEMA ${namespace}`); await client.unsafe(readFileSync('scripts/db/50_data_library.sql', 'utf8')); await client.unsafe(readFileSync('scripts/db/51_browser_sources.sql', 'utf8'));
    const db = drizzle(client); let body = '<article><p>Subscribed research content</p></article>', authExpired = false, requests = 0;
    const service = new DataLibraryService(db, async (url, headers) => {
      requests++; assert.equal(headers?.Cookie, 'session=test-only-cookie');
      if (authExpired) throw new DataLibraryError('NEEDS_AUTH');
      return { status: 200, headers: {}, body: Buffer.from(body), url };
    });
    const [source] = await db.insert(dataLibrarySources).values({ owner, title: 'Private subscription', kind: 'website', format: 'html',
      url: 'https://content-provider.org/research', authKind: 'cookie', secretEnc: encodeDataSecret('session=test-only-cookie'), syncIntervalMinutes: 60 }).returning();
    const first = await service.sync(owner, source.id); assert.equal(first.job.outcome, 'updated'); assert.equal(first.source.versionCount, 1);
    assert.equal(first.source.hasCredential, true); assert.ok(!JSON.stringify(first).includes('test-only-cookie'));
    assert.equal((await service.sync(owner, source.id)).job.outcome, 'unchanged');
    body = '<article><p>Updated research content</p></article>';
    const updated = await service.sync(owner, source.id); assert.equal(updated.source.versionCount, 2);
    authExpired = true;
    const failed = await service.sync(owner, source.id); assert.equal(failed.source.state, 'needs-auth'); assert.equal(failed.source.nextSyncAt, null);
    assert.equal(failed.source.versionCount, 2); assert.equal((await service.search(owner, { query: 'Updated' })).items.length, 1);
    authExpired = false;
    await service.update(owner, source.id, { credential: 'session=test-only-cookie' });
    await db.update(dataLibrarySources).set({ nextSyncAt: new Date(0) }).where(eq(dataLibrarySources.id, source.id));
    const before = requests; await service.runDue(); assert.equal(requests, before + 1);
    assert.ok((await service.detail(owner, source.id)).source.nextSyncAt);
    let continueFetch!: () => void, started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const waiting = new DataLibraryService(db, async url => {
      started(); await new Promise<void>(resolve => { continueFetch = resolve; });
      return { status: 200, headers: {}, body: Buffer.from('<p>Late response</p>'), url };
    });
    const pending = waiting.sync(owner, source.id); await entered;
    await assert.rejects(service.sync(owner, source.id), /SYNC_ALREADY_RUNNING/u);
    await service.remove(owner, source.id); continueFetch(); await assert.rejects(pending, /DATA_SOURCE_NOT_FOUND/u);
    assert.equal((await db.select().from(dataLibraryVersions)).length, 0);
    assert.equal((await service.search(owner, { query: 'response' })).items.length, 0);
    assert.ok((await db.select().from(dataLibraryJobs)).every(job => job.state !== 'running'));
  } finally {
    if (previousKey === undefined) delete process.env.SETTINGS_ENCRYPTION_KEY; else process.env.SETTINGS_ENCRYPTION_KEY = previousKey;
    await client.end(); await admin.unsafe(`DROP SCHEMA ${namespace} CASCADE`); await admin.end();
  }
});
