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
import type { DocumentExtractor, DocumentTaskReceipt } from './documents/document-client.interface';

for (const change of ['cancel', 'disable', 'edit', 'delete', 'query-only cancel'] as const) {
  for (const callback of [false, true]) {
    test(`late ${callback ? 'callback' : 'return'} receipt survives ${change} without publication or replay`, async () => {
      const url = process.env.RESEARCH_TEST_DATABASE_URL;
      assert.ok(url && new URL(url).pathname.includes('test'), 'A disposable test database is required');
      const ns = `late_receipt_${randomUUID().replaceAll('-', '')}`;
      const admin = postgres(url, { max: 1, onnotice: () => {} });
      const client = postgres(url, { max: 5, onnotice: () => {}, connection: { search_path: ns } });
      const root = await mkdtemp(join(tmpdir(), 'late-document-receipt-'));
      let release: () => void = () => {};
      const response = new Promise<void>(resolve => { release = resolve; });
      let started: () => void = () => {};
      const submitting = new Promise<void>(resolve => { started = resolve; });
      let pending: Promise<unknown> = Promise.resolve();
      try {
        await admin.unsafe(`create schema ${ns}`);
        for (const name of ['50_data_library.sql', '51_browser_sources.sql', '54_research_artifacts.sql']) {
          await client.unsafe(readFileSync(`scripts/db/${name}`, 'utf8'));
        }
        const db = drizzle(client), owner = randomUUID();
        const [source] = await db.insert(dataLibrarySources).values({ owner, title: 'Delayed PDF', kind: 'file', format: 'pdf',
          mimeType: 'application/pdf', fileName: 'fixture.pdf', fileData: Buffer.from('%PDF-1.7').toString('base64'), versionCount: 1 }).returning();
        const [version] = await db.insert(dataLibraryVersions).values({ owner, sourceId: source.id, version: 1, contentHash: 'a'.repeat(64),
          rawContent: '', extractedText: '', sections: [], byteLength: 8, extractionState: 'needs-text' }).returning();
        await client`update data_library_sources set latest_version_id=${version.id} where id=${source.id}`;
        let submissions = 0, results = 0, queries = 0;
        const cancelled: string[] = [];
        const receipt = { taskId: 'remote-created-before-response', fileId: 'remote-file' };
        const adapter: DocumentExtractor = { id: 'deferred', version: '1',
          async submit(_file, onReceipt) {
            submissions++; started(); await response;
            if (callback) await onReceipt?.(receipt);
            return receipt;
          },
          ...(change === 'query-only cancel' ? {} : { async cancel(remote: DocumentTaskReceipt) { cancelled.push(remote.taskId); } }),
          async status() { queries++; return 'completed'; },
          async result() { results++; return { markdown: 'Must not publish', lossless: {} }; },
        };
        const storage = new PrivateArtifactStorage(root);
        const service = new DocumentJobsService(db, new ResearchArtifactsService(db, storage), [adapter]);
        const cleanup = new ResearchDerivedCleanupService(db, storage);
        const library = new DataLibraryService(db, undefined, undefined, service, cleanup);
        pending = service.start(owner, source.id, adapter.id, 'v1').then(value => value, error => error);
        await submitting;
        const [task] = await client`select job_id from research_document_tasks where source_id=${source.id}`;
        if (change === 'cancel' || change === 'query-only cancel') await service.cancel(owner, task.job_id);
        else if (change === 'delete') await library.remove(owner, source.id);
        else await library.update(owner, source.id, change === 'disable' ? { enabled: false } : { title: 'Edited source' });
        release(); await pending;
        await service.runDue(); await cleanup.runDue();
        const [settled] = await client`select receipt,state from research_document_tasks where job_id=${task.job_id}`;
        assert.deepEqual(settled.receipt, receipt);
        assert.equal(settled.state, 'cancelled');
        assert.equal((await client`select state from data_library_jobs where id=${task.job_id}`)[0].state, 'cancelled');
        assert.deepEqual(cancelled, change === 'query-only cancel' ? [] : [receipt.taskId]);
        assert.equal(queries, change === 'query-only cancel' ? 1 : 0);
        assert.equal(submissions, 1); assert.equal(results, 0);
        assert.equal(Number((await client`select count(*) n from research_artifacts`)[0].n), 0);
        assert.equal(Number((await client`select count(*) n from data_library_versions where source_id=${source.id}`)[0].n), change === 'delete' ? 0 : 1);
        const [saved] = await client`select active_job_id,lease_token,enabled,title from data_library_sources where id=${source.id}`;
        assert.equal(saved.active_job_id, null); assert.equal(saved.lease_token, null);
        if (change === 'disable' || change === 'delete') assert.equal(saved.enabled, false);
        if (change === 'edit') assert.equal(saved.title, 'Edited source');
      } finally {
        release(); await pending;
        await client.end(); await admin.unsafe(`drop schema ${ns} cascade`); await admin.end();
        await rm(root, { recursive: true, force: true });
      }
    });
  }
}
