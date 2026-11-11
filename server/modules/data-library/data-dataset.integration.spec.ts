import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { DataDatasetService } from './data-dataset.service';
import { DataLibraryService } from './data-library.service';
import { PrivateArtifactStorage } from '../research-artifacts/research-artifacts.storage';
import { ResearchArtifactsService } from '../research-artifacts/research-artifacts.service';
import { ResearchDerivedCleanupService } from '../research-artifacts/research-derived-cleanup.service';
import { dataLibrarySources, dataLibraryVersions } from '../../database/data-library.schema';
import type { ResearchDatasetVersion } from '../../../shared/research-dataset.interface';
import { verifyDatasetContent } from './data-dataset.rules';

test('full immutable datasets and derived private artifacts retain exact source fences', async () => {
  const url = process.env.RESEARCH_TEST_DATABASE_URL;
  assert.ok(url && new URL(url).pathname.includes('test'), 'A disposable test database is required');
  const ns = `datasets_${randomUUID().replaceAll('-', '')}`;
  const admin = postgres(url, { max: 1, onnotice: () => {} });
  const client = postgres(url, { max: 5, onnotice: () => {}, connection: { search_path: ns } });
  const directory = await mkdtemp(join(tmpdir(), 'squabble-artifacts-'));
  try {
    await admin.unsafe(`create schema ${ns}`);
    for (const name of ['50_data_library.sql', '51_browser_sources.sql', '54_research_artifacts.sql']) {
      await client.unsafe(readFileSync(`scripts/db/${name}`, 'utf8'));
    }
    const db = drizzle(client), datasets = new DataDatasetService(db);
    const artifacts = new ResearchArtifactsService(db, new PrivateArtifactStorage(directory));
    const owner = randomUUID(), other = randomUUID();
    const [source] = await db.insert(dataLibrarySources).values({ owner, title: 'Fixture', kind: 'page', format: 'text' }).returning();
    const [version] = await db.insert(dataLibraryVersions).values({ owner, sourceId: source.id, version: 1,
      contentHash: 'a'.repeat(64), rawContent: 'fixture', extractedText: 'fixture', sections: [], byteLength: 7,
      extractionState: 'ready' }).returning();
    const sourceVersion = { sourceId: source.id, sourceVersionId: version.id, contentHash: version.contentHash };
    await client`update data_library_sources set latest_version_id=${version.id},version_count=1 where id=${source.id}`;
    const rows = Array.from({ length: 1205 }, (_, i) => ({ id: i, value: String(i) }));
    const metadata: Omit<ResearchDatasetVersion, 'id' | 'owner' | 'contentHash' | 'storageRef' | 'status'> = {
      sourceVersion, dependencies: [], schema: { fields: ['id', 'value'] }, schemaVersion: '1', provider: 'fictional',
      operation: 'history', parameterVersion: '1', timing: { observedAt: '2026-01-01T00:00:00Z',
        fetchedAt: '2026-01-01T00:00:00Z', dataAsOf: null, marketDate: null, reportPeriod: null,
        announcedAt: null, availableAt: null, availableAtBasis: null, datePrecision: 'unknown' },
      coverage: { status: 'partial', rowCount: rows.length, expectedRowCount: 1500, from: null, to: null,
        missing: ['PAGE_INTERRUPTED'], delayed: null }, adjustment: 'unknown', corporateActionsVersionId: null,
      dataClasses: ['public'], license: { termsRef: null, permittedUses: ['research'], retentionUntil: null },
    };
    const [first, duplicate] = await Promise.all([datasets.create(owner, { metadata, rows }), datasets.create(owner, { metadata, rows })]);
    assert.equal(duplicate.id, first.id);
    assert.equal((await datasets.rows(owner, first.id)).length, 1205);
    const preview = await datasets.summary(owner, first.id, 12);
    assert.equal(preview.summary.truncated, true);
    assert.equal(preview.summary.rowCount, 1205);
    assert.equal(preview.rows.length, 12);
    assert.equal(preview.summary.coverage.status, 'partial');
    await assert.rejects(datasets.rows(other, first.id), /NOT_FOUND/);
    await assert.rejects(datasets.create(owner, { metadata: { ...metadata,
      sourceVersion: { ...sourceVersion, contentHash: 'b'.repeat(64) } }, rows }), /SOURCE/);
    const artifact = await artifacts.create(owner, { runId: randomUUID(), type: 'chart', mime: 'image/png',
      data: Buffer.from('fictional image'), dependencies: [], datasetVersionIds: [first.id],
      dataClasses: ['portfolio'], permittedUses: ['research'], retentionUntil: null });
    assert.deepEqual(artifact.effectiveDataClasses.sort(), ['portfolio', 'private_material', 'public']);
    assert.deepEqual((await artifacts.download(owner, artifact.id)).data, Buffer.from('fictional image'));
    await assert.rejects(artifacts.download(other, artifact.id), /NOT_FOUND/);
    await client`insert into research_source_policies(source_version_id,owner,data_classes,permitted_uses)
      values(${version.id},${owner},'["application"]'::jsonb,'[]'::jsonb)`;
    assert.ok((await datasets.read(owner, first.id)).dataClasses.includes('application'));
    assert.equal(verifyDatasetContent(await datasets.read(owner, first.id), await datasets.rows(owner, first.id)), true);
    assert.deepEqual((await datasets.read(owner, first.id)).license.permittedUses, []);
    assert.ok((await artifacts.download(owner, artifact.id)).artifact.effectiveDataClasses.includes('application'));
    assert.deepEqual((await artifacts.download(owner, artifact.id)).artifact.permittedUses, []);
    const [v2] = await db.insert(dataLibraryVersions).values({ owner, sourceId: source.id, version: 2, contentHash: 'b'.repeat(64),
      rawContent: 'v2', extractedText: 'v2', sections: [], byteLength: 2, extractionState: 'ready' }).returning();
    await client`update data_library_sources set latest_version_id=${v2.id},version_count=2 where id=${source.id}`;
    assert.equal((await datasets.rows(owner, first.id)).length, 1205);
    await client`update data_library_sources set enabled=false where id=${source.id}`;
    await assert.rejects(artifacts.download(owner, artifact.id), /SOURCE/);
    await client`update data_library_sources set enabled=true where id=${source.id}`;
    await datasets.revoke(owner, first.id);
    await assert.rejects(artifacts.download(owner, artifact.id), /DATASET/);
    await assert.rejects(datasets.create(owner, { metadata, rows }), /REVOKED/);
    await new DataLibraryService(db, undefined, undefined, undefined,
      new ResearchDerivedCleanupService(db, new PrivateArtifactStorage(directory))).remove(owner, source.id);
    assert.equal(Number((await client`select count(*) n from data_library_versions where source_id=${source.id}`)[0].n), 0);
    assert.equal((await client`select rows from research_dataset_versions where id=${first.id}`)[0].rows.length, 0);
    await assert.rejects(access(join(directory, artifact.privateStorageRef)), /ENOENT/);
  } finally {
    await client.end(); await admin.unsafe(`drop schema ${ns} cascade`); await admin.end();
    await rm(directory, { recursive: true, force: true });
  }
});
