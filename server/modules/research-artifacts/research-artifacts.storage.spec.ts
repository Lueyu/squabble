import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { PrivateArtifactStorage } from './research-artifacts.storage';

test('private storage isolates equal content by owner, verifies bytes and rejects traversal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'artifact-storage-'));
  try {
    const storage = new PrivateArtifactStorage(root);
    const a = await storage.write('owner-a', Buffer.from('same'));
    const b = await storage.write('owner-b', Buffer.from('same'));
    assert.notEqual(a.storageRef, b.storageRef);
    assert.equal(a.sha256, b.sha256);
    await assert.rejects(storage.read('owner-b', a.storageRef, a.sha256), /OWNER/);
    await assert.rejects(storage.read('owner-a', '../outside', a.sha256), /STORAGE/);
    await writeFile(join(root, a.storageRef), 'changed');
    await assert.rejects(storage.read('owner-a', a.storageRef, a.sha256), /HASH/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('bounded recovery traverses every private file while preserving backups and symlink targets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'artifact-scan-'));
  const outside = await mkdtemp(join(tmpdir(), 'artifact-scan-outside-'));
  const storage = new PrivateArtifactStorage(root);
  try {
    const files = [];
    for (let index = 0; index < 25; index++) files.push(await storage.write('owner', Buffer.from(String(index))));
    const ownerDirectory = files[0].storageRef.split('/')[0];
    const backup = join(root, ownerDirectory, 'retained-backup.bak');
    await writeFile(backup, 'backup');
    await mkdir(join(root, 'backups'));
    const outsideFile = join(outside, files[0].storageRef.split('/')[1]);
    await writeFile(outsideFile, 'outside');
    await symlink(outside, join(root, storage.ownerDirectory('linked-owner')), 'junction');
    const seen = new Set<string>();
    for (let page = 0; page < 30; page++) {
      const candidates = await storage.reconciliationCandidates(3);
      assert.ok(candidates.length <= 3);
      for (const candidate of candidates) {
        assert.equal(candidate.ownerDirectory, ownerDirectory);
        seen.add(candidate.storageRef);
      }
    }
    assert.equal(seen.size, files.length, 'Recovery pages must advance instead of starving files beyond the first page');
    const old = new Date(Date.now() - 48 * 3600_000);
    await utimes(join(root, files[0].storageRef), old, old);
    assert.equal(await storage.removeUnindexed({ ownerDirectory, storageRef: files[0].storageRef, temporary: false }, new Date()), true);
    await access(backup); await access(outsideFile);
    await assert.rejects(storage.removeUnindexed({ ownerDirectory, storageRef: '../outside', temporary: false }, new Date()), /REFERENCE/);
    await assert.rejects(storage.removeUnindexed({ ownerDirectory: storage.ownerDirectory('linked-owner'),
      storageRef: `${storage.ownerDirectory('linked-owner')}/${files[0].storageRef.split('/')[1]}`, temporary: false }, new Date()), /SYMLINK/);
  } finally {
    await storage.onModuleDestroy();
    await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true });
  }
});
