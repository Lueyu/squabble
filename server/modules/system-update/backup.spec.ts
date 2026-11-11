import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createUpdateBackup } from './backup';

test('backup preserves the database dump and persistent secrets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'squabble-update-test-'));
  try {
    const secrets = join(root, 'secrets');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(secrets);
    await writeFile(join(secrets, 'jwt.key'), 'jwt');
    await writeFile(join(secrets, 'settings.key'), 'settings');
    const directory = await createUpdateBackup(join(root, 'backups'), secrets, async (destination) => {
      await writeFile(destination, 'database');
    });
    assert.equal(await readFile(join(directory, 'database.dump'), 'utf8'), 'database');
    assert.equal(await readFile(join(directory, 'jwt.key'), 'utf8'), 'jwt');
    assert.equal(await readFile(join(directory, 'settings.key'), 'utf8'), 'settings');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('update backup verifies every snapshot-indexed artifact and retains relative storage references', async () => {
  const root = await mkdtemp(join(tmpdir(), 'squabble-artifact-backup-'));
  try {
    const artifactRoot = join(root, 'artifacts'), owner = 'a'.repeat(64), file = '00000000-0000-4000-8000-000000000000';
    await mkdir(join(artifactRoot, owner), { recursive: true });
    await writeFile(join(artifactRoot, owner, file), 'immutable');
    const storageRef = `${owner}/${file}`, sha256 = createHash('sha256').update('immutable').digest('hex');
    const directory = await createUpdateBackup(join(root, 'backups'), join(root, 'secrets'), destination => writeFile(destination, 'database'),
      { artifactRoot, artifacts: [{ storageRef, sha256, sizeBytes: 9 }], keys: { jwt: 'fixture-jwt', settings: 'fixture-settings' } });
    assert.equal(await readFile(join(directory, 'research-artifacts', storageRef), 'utf8'), 'immutable');
    const manifest = JSON.parse(await readFile(join(directory, 'artifact-manifest.json'), 'utf8'));
    assert.equal(manifest.files[0].sha256, sha256);
    assert.equal(manifest.files[0].storageRef, storageRef);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a missing or corrupted indexed artifact prevents a complete update backup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'squabble-missing-backup-'));
  try {
    const artifacts = [{ storageRef: `${'a'.repeat(64)}/00000000-0000-4000-8000-000000000000`, sha256: 'b'.repeat(64), sizeBytes: 9 }];
    await assert.rejects(createUpdateBackup(join(root, 'backups'), join(root, 'secrets'), destination => writeFile(destination, 'database'),
      { artifactRoot: join(root, 'artifacts'), artifacts, keys: { jwt: 'fixture-jwt', settings: 'fixture-settings' } }));
    assert.deepEqual(await readdir(join(root, 'backups')), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a failed dump leaves no backup that looks complete', async () => {
  const root = await mkdtemp(join(tmpdir(), 'squabble-update-test-'));
  try {
    await assert.rejects(createUpdateBackup(join(root, 'backups'), join(root, 'secrets'), async () => {
      throw new Error('dump failed');
    }), /dump failed/u);
    assert.deepEqual(await readdir(join(root, 'backups')), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('runtime environment keys override stale generated files in the matched backup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'squabble-authoritative-keys-'));
  try {
    const secrets = join(root, 'secrets'); await mkdir(secrets);
    await writeFile(join(secrets, 'jwt.key'), 'obsolete-jwt');
    await writeFile(join(secrets, 'settings.key'), 'obsolete-settings');
    const directory = await createUpdateBackup(join(root, 'backups'), secrets, destination => writeFile(destination, 'database'), {
      artifactRoot: join(root, 'artifacts'), artifacts: [], keys: { jwt: 'runtime-jwt', settings: 'runtime-settings' },
    });
    assert.equal(await readFile(join(directory, 'jwt.key'), 'utf8'), 'runtime-jwt');
    assert.equal(await readFile(join(directory, 'settings.key'), 'utf8'), 'runtime-settings');
  } finally { await rm(root, { recursive: true, force: true }); }
});
