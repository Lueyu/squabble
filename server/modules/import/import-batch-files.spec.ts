import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ImportBatchFiles } from './import-batch-files';

test('private image leases keep an executor read alive until acknowledged release', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'import-file-lease-')),
    files = new ImportBatchFiles(directory),
    id = randomUUID();
  const image = {
    mimeType: 'image/png' as const,
    data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
  };
  try {
    await files.put('owner', id, image);
    await assert.rejects(
      files.read('stranger', id, image.mimeType, async () => undefined),
    );
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reading!: () => void;
    const entered = new Promise<void>((resolve) => {
      reading = resolve;
    });
    const lease = files.read('owner', id, image.mimeType, async (value) => {
      assert.deepEqual(value, image);
      reading();
      await gate;
    });
    await entered;
    assert.equal(await files.remove('owner', id), false);
    release();
    await lease;
    assert.equal(await files.remove('owner', id), true);
    await assert.rejects(
      files.read('owner', id, image.mimeType, async () => undefined),
    );
    const kept = randomUUID(),
      orphan = randomUUID(),
      batchId = randomUUID();
    await files.put('owner', kept, image, batchId);
    await files.put('owner', orphan, image, batchId);
    await files.cleanupUnreferenced(
      [{ owner: 'owner', batchId, imageId: kept }],
      Date.now() + 25 * 3600_000,
    );
    await files.read(
      'owner',
      kept,
      image.mimeType,
      async () => undefined,
      batchId,
    );
    await assert.rejects(
      files.read(
        'owner',
        orphan,
        image.mimeType,
        async () => undefined,
        batchId,
      ),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
