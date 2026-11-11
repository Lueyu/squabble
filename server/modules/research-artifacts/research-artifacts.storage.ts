import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, opendir, realpath, rename, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

export const RESEARCH_ARTIFACT_STORAGE = Symbol('RESEARCH_ARTIFACT_STORAGE');
export interface ArtifactReconciliationCandidate {
  ownerDirectory: string;
  storageRef: string;
  temporary: boolean;
}
export class PrivateArtifactStorage {
  readonly root: string;
  private reconciliationScan: AsyncGenerator<ArtifactReconciliationCandidate | null> | null = null;
  private scanning = false;
  constructor(root: string, readonly maxFileBytes = 32 * 1024 * 1024) { this.root = resolve(root); }
  ownerDirectory(owner: string): string {
    if (!owner?.trim()) throw new Error('OWNER_REQUIRED');
    return createHash('sha256').update(owner).digest('hex');
  }
  private path(owner: string, storageRef: string): string {
    if (!/^[a-f0-9]{64}\/[a-f0-9-]{36}$/u.test(storageRef)) throw new Error('STORAGE_REFERENCE_INVALID');
    if (storageRef.split('/')[0] !== this.ownerDirectory(owner)) throw new Error('STORAGE_OWNER_MISMATCH');
    const path = resolve(this.root, storageRef), rel = relative(this.root, path);
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('STORAGE_PATH_INVALID');
    return path;
  }
  private async verifyParent(path: string): Promise<void> {
    const root = await realpath(this.root), parent = await realpath(resolve(path, '..'));
    const rel = relative(root, parent);
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('STORAGE_SYMLINK_REJECTED');
  }
  async write(owner: string, data: Buffer): Promise<{ storageRef: string; sha256: string; sizeBytes: number }> {
    if (data.length > this.maxFileBytes) throw new Error('ARTIFACT_TOO_LARGE');
    const ownerDirectory = this.ownerDirectory(owner), id = randomUUID();
    await mkdir(join(this.root, ownerDirectory), { recursive: true, mode: 0o700 });
    const storageRef = `${ownerDirectory}/${id}`, path = this.path(owner, storageRef), temporary = `${path}.tmp`;
    await this.verifyParent(path);
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
    try { await rename(temporary, path); } catch (error) { await rm(temporary, { force: true }); throw error; }
    return { storageRef, sha256: createHash('sha256').update(data).digest('hex'), sizeBytes: data.length };
  }
  async read(owner: string, storageRef: string, sha256: string): Promise<Buffer> {
    const path = this.path(owner, storageRef); await this.verifyParent(path);
    if ((await lstat(path)).isSymbolicLink()) throw new Error('STORAGE_SYMLINK_REJECTED');
    const actual = await realpath(path);
    const rel = relative(await realpath(this.root), actual);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error('STORAGE_SYMLINK_REJECTED');
    }
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > this.maxFileBytes) throw new Error('ARTIFACT_TOO_LARGE');
      const data = await handle.readFile();
      if (createHash('sha256').update(data).digest('hex') !== sha256) throw new Error('ARTIFACT_HASH_MISMATCH');
      return data;
    } finally { await handle.close(); }
  }
  async remove(owner: string, storageRef: string): Promise<void> {
    const path = this.path(owner, storageRef); await this.verifyParent(path); await rm(path, { force: true });
  }
  private async verifyOwnerDirectory(directory: string): Promise<void> {
    const path = join(this.root, directory), info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink() ||
      await realpath(path) !== join(await realpath(this.root), directory)) throw new Error('STORAGE_SYMLINK_REJECTED');
  }
  private async *scanPrivateFiles(): AsyncGenerator<ArtifactReconciliationCandidate | null> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const root = await opendir(this.root);
    for await (const directory of root) {
      // Yield on every entry, including ignored entries, so each sweep has a fixed traversal budget.
      yield null;
      if (!directory.isDirectory() || directory.isSymbolicLink() || !/^[a-f0-9]{64}$/u.test(directory.name)) continue;
      await this.verifyOwnerDirectory(directory.name);
      const files = await opendir(join(this.root, directory.name));
      for await (const entry of files) {
        if (!entry.isFile() || entry.isSymbolicLink() || !/^[a-f0-9-]{36}(\.tmp)?$/u.test(entry.name)) {
          yield null; continue;
        }
        const temporary = entry.name.endsWith('.tmp');
        yield { ownerDirectory: directory.name,
          storageRef: `${directory.name}/${temporary ? entry.name.slice(0, -4) : entry.name}`, temporary };
      }
    }
  }
  /** Cursor handles are retained between bounded pages; shutdown closes them without scanning more files. */
  async reconciliationCandidates(limit = 500): Promise<ArtifactReconciliationCandidate[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('INVALID_RECONCILIATION_LIMIT');
    if (this.scanning) return [];
    this.scanning = true;
    const candidates: ArtifactReconciliationCandidate[] = [];
    try {
      this.reconciliationScan ??= this.scanPrivateFiles();
      for (let visited = 0; visited < limit; visited++) {
        const next = await this.reconciliationScan.next();
        if (next.done) { this.reconciliationScan = null; break; }
        if (next.value) candidates.push(next.value);
      }
      return candidates;
    } catch (error) {
      await this.onModuleDestroy(); throw error;
    } finally { this.scanning = false; }
  }
  /** Caller holds the matching owner-directory advisory lock and has rechecked the durable index. */
  async removeUnindexed(candidate: ArtifactReconciliationCandidate, before: Date): Promise<boolean> {
    if (!/^[a-f0-9]{64}\/[a-f0-9-]{36}$/u.test(candidate.storageRef) ||
      candidate.storageRef.split('/')[0] !== candidate.ownerDirectory) throw new Error('STORAGE_REFERENCE_INVALID');
    await this.verifyOwnerDirectory(candidate.ownerDirectory);
    const path = join(this.root, candidate.storageRef) + (candidate.temporary ? '.tmp' : '');
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.mtime >= before) return false;
      await rm(path); return true;
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
      throw error;
    }
  }
  async onModuleDestroy(): Promise<void> {
    await this.reconciliationScan?.return(undefined);
    this.reconciliationScan = null;
  }
}
