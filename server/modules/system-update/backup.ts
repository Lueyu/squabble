import { randomUUID } from 'node:crypto';
import { chmod, copyFile, mkdir, rename, rm, stat, writeFile, lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { PrivateArtifactStorage } from '../research-artifacts/research-artifacts.storage';

export interface UpdateArtifactSnapshot {
  artifactRoot: string;
  artifacts: Array<{ storageRef: string; sha256: string; sizeBytes: number }>;
  keys?: { jwt?: string; settings?: string };
}

async function copyArtifacts(pending: string, snapshot: UpdateArtifactSnapshot): Promise<void> {
  const root = resolve(snapshot.artifactRoot), destination = join(pending, 'research-artifacts');
  const storage = new PrivateArtifactStorage(root);
  const files = [];
  for (const entry of snapshot.artifacts) {
    if (!/^[a-f0-9]{64}\/[a-f0-9-]{36}$/u.test(entry.storageRef) || !/^[a-f0-9]{64}$/u.test(entry.sha256)) {
      throw new Error('UPDATE_ARTIFACT_MANIFEST_INVALID');
    }
    const path = resolve(root, entry.storageRef), rel = relative(await realpath(root), await realpath(path));
    if (isAbsolute(rel) || rel.startsWith('..') || (await lstat(path)).isSymbolicLink()) throw new Error('UPDATE_ARTIFACT_PATH_INVALID');
    // Storage references encode the owner's hash; verify the bytes independently of the live API's source policy.
    const { createHash } = await import('node:crypto');
    const { readFile } = await import('node:fs/promises');
    const info = await lstat(path);
    if (!info.isFile() || info.size !== entry.sizeBytes || info.size > storage.maxFileBytes) throw new Error('UPDATE_ARTIFACT_SIZE_MISMATCH');
    const data = await readFile(path);
    if (createHash('sha256').update(data).digest('hex') !== entry.sha256) throw new Error('UPDATE_ARTIFACT_HASH_MISMATCH');
    const target = join(destination, entry.storageRef);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, data, { flag: 'wx', mode: 0o600 });
    files.push(entry);
  }
  await writeFile(join(pending, 'artifact-manifest.json'), JSON.stringify({ version: 1, files }, null, 2), { mode: 0o600 });
}

export async function createUpdateBackup(
  backupRoot: string,
  secretsRoot: string,
  dump: (destination: string) => Promise<void>,
  snapshot?: UpdateArtifactSnapshot,
): Promise<string> {
  await mkdir(backupRoot, { recursive: true, mode: 0o700 });
  const name = `${new Date().toISOString().replace(/[:.]/gu, '-')}-${randomUUID()}`;
  const pending = join(backupRoot, `.pending-${name}`);
  const complete = join(backupRoot, name);
  await mkdir(pending, { mode: 0o700 });
  try {
    const databaseFile = join(pending, 'database.dump');
    await dump(databaseFile);
    if ((await stat(databaseFile)).size === 0) throw new Error('Database backup is empty');
    await chmod(databaseFile, 0o600);
    const keySources: Record<string, string> = {};
    for (const filename of ['jwt.key', 'settings.key']) {
      const runtimeValue = filename === 'jwt.key' ? snapshot?.keys?.jwt : snapshot?.keys?.settings;
      if (runtimeValue?.trim()) {
        await writeFile(join(pending, filename), runtimeValue, { mode: 0o600, flag: 'wx' });
        keySources[filename] = 'runtime';
        continue;
      }
      try {
        const target = join(pending, filename);
        await copyFile(join(secretsRoot, filename), target);
        await chmod(target, 0o600);
        keySources[filename] = 'persistent-file';
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        const value = filename === 'jwt.key' ? snapshot?.keys?.jwt : snapshot?.keys?.settings;
        if (!value?.trim()) throw new Error('UPDATE_MATCHING_ENCRYPTION_KEYS_REQUIRED');
        await writeFile(join(pending, filename), value, { mode: 0o600, flag: 'wx' });
      }
    }
    await writeFile(join(pending, 'key-provenance.json'), JSON.stringify(keySources, null, 2), { mode: 0o600 });
    if (snapshot) await copyArtifacts(pending, snapshot);
    await rename(pending, complete);
    return complete;
  } catch (error) {
    await rm(pending, { recursive: true, force: true });
    throw error;
  }
}
