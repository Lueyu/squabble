import { Inject, Injectable, Optional } from '@nestjs/common';
import { createHash } from 'node:crypto';
import {
  mkdir,
  readFile,
  readdir,
  lstat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { NativeAgentImage } from '../../../shared/native-image.interface';
import { validateNativeImage } from '../../local-agents/native-image';
/** Private account directories, fixed UUID names, and leases prevent expiry racing a reader. */
@Injectable()
export class ImportBatchFiles {
  readonly root: string;
  private leases = new Map<string, number>();
  constructor(
    @Optional()
    @Inject('IMPORT_BATCH_FILES_ROOT')
    root?: string,
  ) {
    this.root = resolve(
      root ??
        process.env.IMPORT_BATCH_FILES_ROOT ??
        join(homedir(), '.squabble', 'import-images'),
    );
  }
  private path(owner: string, id: string, batchId = 'legacy') {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('INVALID_IMAGE_ID');
    if (batchId !== 'legacy' && !/^[0-9a-f-]{36}$/i.test(batchId))
      throw new Error('INVALID_BATCH_ID');
    return join(
      this.root,
      createHash('sha256').update(owner).digest('hex'),
      batchId,
      id,
    );
  }
  async put(
    owner: string,
    id: string,
    input: NativeAgentImage,
    batchId?: string,
  ) {
    const image = validateNativeImage(input),
      path = this.path(owner, id, batchId);
    await mkdir(join(path, '..'), { recursive: true, mode: 0o700 });
    await writeFile(path, Buffer.from(image.data, 'base64'), {
      mode: 0o600,
      flag: 'wx',
    });
    return {
      fingerprint: createHash('sha256')
        .update(Buffer.from(image.data, 'base64'))
        .digest('hex'),
      bytes: Buffer.byteLength(image.data, 'base64'),
    };
  }
  async read<T>(
    owner: string,
    id: string,
    mimeType: NativeAgentImage['mimeType'],
    reader: (image: NativeAgentImage) => Promise<T>,
    batchId?: string,
  ): Promise<T> {
    const path = this.path(owner, id, batchId);
    this.leases.set(path, (this.leases.get(path) ?? 0) + 1);
    try {
      return await reader({
        mimeType,
        data: (await readFile(path)).toString('base64'),
      });
    } finally {
      const count = (this.leases.get(path) ?? 1) - 1;
      if (count) this.leases.set(path, count);
      else this.leases.delete(path);
    }
  }
  async remove(owner: string, id: string, batchId?: string): Promise<boolean> {
    const path = this.path(owner, id, batchId);
    if (this.leases.has(path)) return false;
    await unlink(path).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
    return true;
  }
  /** Upload interrupted before DB registration: reclaim only unreferenced files older than 24h. */
  async cleanupUnreferenced(
    references: Array<{ owner: string; batchId: string; imageId: string }>,
    now = Date.now(),
  ) {
    const keep = new Set(
      references.map((ref) => this.path(ref.owner, ref.imageId, ref.batchId)),
    );
    const owners = await readdir(this.root, { withFileTypes: true }).catch(
      (error) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      },
    );
    for (const owner of owners) {
      if (!owner.isDirectory() || !/^[a-f0-9]{64}$/.test(owner.name)) continue;
      const ownerPath = join(this.root, owner.name);
      for (const batch of await readdir(ownerPath, { withFileTypes: true })) {
        if (
          !batch.isDirectory() ||
          (batch.name !== 'legacy' && !/^[0-9a-f-]{36}$/i.test(batch.name))
        )
          continue;
        const batchPath = join(ownerPath, batch.name);
        for (const image of await readdir(batchPath, { withFileTypes: true })) {
          if (!image.isFile() || !/^[0-9a-f-]{36}$/i.test(image.name)) continue;
          const path = join(batchPath, image.name);
          if (keep.has(path) || this.leases.has(path)) continue;
          const stat = await lstat(path);
          if (stat.mtimeMs <= now - 24 * 3600_000)
            await unlink(path).catch((error) => {
              if (error.code !== 'ENOENT') throw error;
            });
        }
      }
    }
  }
}
