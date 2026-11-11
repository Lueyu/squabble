import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { DocumentJobsService } from './document-jobs.service';
import { DataLibraryService } from './data-library.service';
import { ResearchArtifactsService } from '../research-artifacts/research-artifacts.service';
import { PrivateArtifactStorage } from '../research-artifacts/research-artifacts.storage';
import { ResearchDerivedCleanupService } from '../research-artifacts/research-derived-cleanup.service';
import { dataLibrarySources, dataLibraryVersions } from '../../database/data-library.schema';
import type { DocumentExtractor } from './documents/document-client.interface';

test('document jobs resume receipts, publish a new immutable version and reject late deleted-source output', async () => {
  const url = process.env.RESEARCH_TEST_DATABASE_URL;
  assert.ok(url && new URL(url).pathname.includes('test'), 'A disposable test database is required');
  const ns = `document_jobs_${randomUUID().replaceAll('-', '')}`;
  const admin = postgres(url, { max: 1, onnotice: () => {} });
  const client = postgres(url, { max: 5, onnotice: () => {}, connection: { search_path: ns } });
  const root = await mkdtemp(join(tmpdir(), 'document-jobs-'));
  try {
    await admin.unsafe(`create schema ${ns}`);
    for (const name of ['50_data_library.sql', '51_browser_sources.sql', '54_research_artifacts.sql']) await client.unsafe(readFileSync(`scripts/db/${name}`, 'utf8'));
    const db = drizzle(client), owner = randomUUID(); let submissions = 0, deleteDuringResult = false;
    const [source] = await db.insert(dataLibrarySources).values({ owner, title: 'Fictional PDF', kind: 'file', format: 'pdf',
      mimeType: 'application/pdf', fileName: 'fixture.pdf', fileData: Buffer.from('%PDF-1.7').toString('base64'), versionCount: 1 }).returning();
    const [version] = await db.insert(dataLibraryVersions).values({ owner, sourceId: source.id, version: 1, contentHash: 'c'.repeat(64),
      rawContent: '', extractedText: '', sections: [], byteLength: 8, extractionState: 'needs-text' }).returning();
    await client`update data_library_sources set latest_version_id=${version.id} where id=${source.id}`;
    const adapter: DocumentExtractor = { id: 'fictional', version: '1',
      async submit() { submissions++; return { taskId: 'fixed-task' }; }, async status() { return 'completed'; },
      async result() { if (deleteDuringResult) await client`update data_library_sources set deleted_at=now(),enabled=false,revision=revision+1 where id=${source.id}`;
        return { markdown: 'Revenue 120 万元', lossless: { texts: [{ self_ref: '#/texts/0', text: 'Revenue 120 万元', prov: [{ page_no: 1 }] }] } }; } };
    const artifacts = new ResearchArtifactsService(db, new PrivateArtifactStorage(root));
    const firstService = new DocumentJobsService(db, artifacts, [adapter]);
    const library = new DataLibraryService(db, undefined, undefined, firstService);
    const uploaded = await library.upload(owner, { title: 'Uploaded PDF', fileName: 'fixture.pdf', mimeType: 'application/pdf', data: Buffer.from('%PDF-1.7').toString('base64') });
    assert.equal(uploaded.format, 'pdf'); assert.equal(uploaded.state, 'syncing');
    const job = await firstService.start(owner, source.id, 'fictional', 'gold-config-v1');
    await client`update data_library_sources set lease_until=now()-interval '1 second' where id=${source.id}`;
    const resumed = new DocumentJobsService(db, artifacts, [adapter]);
    await assert.rejects(resumed.poll(randomUUID(), job.jobId), /NOT_FOUND/);
    assert.equal(await resumed.poll(owner, job.jobId), 'completed'); assert.equal(submissions, 2);
    assert.equal(await resumed.poll(owner, job.jobId), 'completed');
    const versions = await client`select * from data_library_versions where source_id=${source.id} order by version`;
    assert.equal(versions.length, 2); assert.equal(versions[0].content_hash, 'c'.repeat(64));
    assert.equal(versions[1].extracted_text, 'Revenue 120 万元');
    const late = await resumed.start(owner, source.id, 'fictional', 'gold-config-v2'); deleteDuringResult = true;
    await assert.rejects(resumed.poll(owner, late.jobId), /SOURCE/);
    assert.equal(Number((await client`select count(*) n from data_library_versions where source_id=${source.id}`)[0].n), 2);
    assert.equal(Number((await client`select count(*) n from research_artifacts where status='active'`)[0].n), 1);
    await new ResearchDerivedCleanupService(db, new PrivateArtifactStorage(root)).runDue();
    assert.equal(Number((await client`select count(*) n from research_artifacts where status='active'`)[0].n), 0);
    assert.deepEqual((await client`select metadata from research_document_extractions where source_id=${source.id}`)[0].metadata, {});
  } finally { await client.end(); await admin.unsafe(`drop schema ${ns} cascade`); await admin.end(); await rm(root, { recursive: true, force: true }); }
});
