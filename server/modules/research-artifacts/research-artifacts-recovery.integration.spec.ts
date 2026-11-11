import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { access, mkdtemp, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { ResearchArtifactsService, type ArtifactCreate } from './research-artifacts.service';
import { PrivateArtifactStorage } from './research-artifacts.storage';
import { ResearchDerivedCleanupService } from './research-derived-cleanup.service';

test('artifact recovery removes crash-orphan final bytes after grace and fences live writes', async () => {
  const url = process.env.RESEARCH_TEST_DATABASE_URL;
  assert.ok(url && new URL(url).pathname.includes('test'), 'A disposable test database is required');
  const ns = `artifact_recovery_${randomUUID().replaceAll('-', '')}`;
  const admin = postgres(url, { max: 1, onnotice: () => {} });
  const client = postgres(url, { max: 5, onnotice: () => {}, connection: { search_path: ns } });
  const root = await mkdtemp(join(tmpdir(), 'artifact-recovery-'));
  const old = new Date(Date.now() - 48 * 3600_000);
  let releaseWrite: () => void = () => {};
  let writing = Promise.resolve();
  const renamed = new Promise<void>(resolve => { releaseWrite = resolve; });
  let notifyRenamed: () => void = () => {};
  const didRename = new Promise<void>(resolve => { notifyRenamed = resolve; });
  class FaultStorage extends PrivateArtifactStorage {
    crash = false;
    pause = false;
    lastRef = '';
    override async write(owner: string, data: Buffer) {
      const file = await super.write(owner, data);
      this.lastRef = file.storageRef;
      if (this.crash || this.pause) await utimes(join(root, file.storageRef), old, old);
      if (this.crash) throw new Error('SIMULATED_PROCESS_DEATH_AFTER_RENAME');
      if (this.pause) { notifyRenamed(); await renamed; }
      return file;
    }
  }
  const storage = new FaultStorage(root);
  try {
    await admin.unsafe(`create schema ${ns}`);
    for (const name of ['50_data_library.sql', '51_browser_sources.sql', '54_research_artifacts.sql']) {
      await client.unsafe(readFileSync(`scripts/db/${name}`, 'utf8'));
    }
    const db = drizzle(client), owner = randomUUID(), other = randomUUID();
    const artifacts = new ResearchArtifactsService(db, storage);
    const cleanup = new ResearchDerivedCleanupService(db, new PrivateArtifactStorage(root));
    const input: ArtifactCreate = { runId: randomUUID(), type: 'document', mime: 'text/plain',
      data: Buffer.from('fixture'), dependencies: [], datasetVersionIds: [], dataClasses: [],
      permittedUses: ['research'], retentionUntil: null };
    const committed = await artifacts.create(owner, input);
    const otherCommitted = await artifacts.create(other, input);
    await utimes(join(root, committed.privateStorageRef), old, old);
    await utimes(join(root, otherCommitted.privateStorageRef), old, old);
    const youngOrphan = await storage.write(owner, Buffer.from('inside grace'));
    storage.crash = true;
    await assert.rejects(artifacts.create(owner, input), /SIMULATED_PROCESS_DEATH/);
    const orphanRef = storage.lastRef;
    storage.crash = false;
    await access(join(root, orphanRef));
    await cleanup.runDue();
    await assert.rejects(access(join(root, orphanRef)), /ENOENT/);
    for (const ref of [committed.privateStorageRef, otherCommitted.privateStorageRef, youngOrphan.storageRef]) {
      await access(join(root, ref));
    }
    storage.pause = true;
    writing = artifacts.create(owner, input).then(() => undefined);
    await didRename;
    const liveRef = storage.lastRef;
    const ownerDirectory = createHash('sha256').update(owner).digest('hex');
    const [lock] = await client.begin(async tx => tx`select pg_try_advisory_xact_lock(hashtextextended(${ownerDirectory},54)) acquired`);
    assert.equal(lock.acquired, false, 'The final file must remain fenced until its index transaction commits');
    const collecting = cleanup.runDue();
    await access(join(root, liveRef));
    releaseWrite();
    await writing;
    await collecting;
    await access(join(root, liveRef));
    assert.equal(Number((await client`select count(*) n from research_artifacts`)[0].n), 3);
  } finally {
    releaseWrite(); await writing.catch(() => undefined);
    await client.end(); await admin.unsafe(`drop schema ${ns} cascade`); await admin.end();
    await rm(root, { recursive: true, force: true });
  }
});
