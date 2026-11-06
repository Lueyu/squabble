import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { ImportBatchesService } from './import-batches.service';
import { ImportBatchFiles } from './import-batch-files';
import { ScreenshotError } from './screenshot-result';
import type { LocalAgentsService } from '../local-agents/local-agents.service';
import type { LocalAgentExecution } from '../local-agents/local-agents.types';
import type { OcrService } from './ocr.service';

const image = {
  mimeType: 'image/png' as const,
  data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
};
const secondBytes = Buffer.from(image.data, 'base64');
secondBytes[secondBytes.length - 1] ^= 1;
const secondImage = { ...image, data: secondBytes.toString('base64') };
const databaseUrl =
  process.env.EXPERIENCE_TEST_DATABASE_URL ??
  process.env.RESEARCH_TEST_DATABASE_URL;
test(
  'conservative screenshot queue exposes early editable results, bounds concurrency and records real phase durations',
  { skip: !databaseUrl },
  async () => {
    const namespace = 'import_perf_' + randomUUID().replaceAll('-', ''),
      admin = postgres(databaseUrl!, { max: 1, onnotice: () => {} }),
      client = postgres(databaseUrl!, {
        max: 6,
        onnotice: () => {},
        connection: { search_path: namespace },
      }),
      directory = await mkdtemp(join(tmpdir(), 'screenshot-perf-'));
    await admin`CREATE SCHEMA ${admin(namespace)}`;
    let service: ImportBatchesService | undefined;
    let release!: () => void;
    try {
      for (const file of (await readdir('scripts/db'))
        .filter((f) => /^\d\d_.*\.sql$/.test(f) && !f.startsWith('02_'))
        .sort())
        await client.unsafe(await readFile('scripts/db/' + file, 'utf8'));
      const db = drizzle(client),
        owner = randomUUID();
      let calls = 0,
        active = 0,
        maxActive = 0;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let entered!: () => void;
      const secondEntered = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let mode: 'normal' | 'content' | 'auth' = 'normal';
      const agents = {
        validate: async () => undefined,
        execute: async (_owner: string, input: LocalAgentExecution) => {
          calls++;
          active++;
          maxActive = Math.max(maxActive, active);
          try {
            await input.onTask({ taskId: randomUUID(), contextId: 'fixture' });
            await input.onDispatch?.();
            if (mode === 'content' && calls === 1)
              throw new ScreenshotError('INVALID_RESULT');
            if (mode === 'auth')
              throw new ScreenshotError('LOCAL_LOGIN_REQUIRED');
            if (mode === 'normal' && calls === 2) {
              entered();
              await gate;
            }
            return {
              text: JSON.stringify({
                rows: [
                  { ticker: 'TEST', shares: 10, avgCost: 5, currency: 'USD' },
                ],
              }),
            };
          } finally {
            active--;
          }
        },
      } as unknown as LocalAgentsService;
      service = new ImportBatchesService(
        db,
        agents,
        {} as OcrService,
        new ImportBatchFiles(directory),
      );
      const create = async () => {
        const id = randomUUID();
        await service!.create(owner, {
          id,
          executor: { executor: 'local', agentId: 'native-codex' },
        });
        await service!.upload(owner, id, {
          id: randomUUID(),
          filename: 'one.png',
          image,
        });
        await service!.upload(owner, id, {
          id: randomUUID(),
          filename: 'two.png',
          image: secondImage,
        });
        await service!.start(owner, id);
        return id;
      };
      const id = await create();
      await secondEntered;
      let batch = await service.get(owner, id);
      assert.equal(batch.images[0].status, 'completed');
      assert.equal(batch.images[1].status, 'running');
      assert.equal(batch.rows.length, 1);
      batch = await service.edit(
        owner,
        id,
        batch.rows[0].id,
        { shares: 99, confirmed: true },
        batch.revision,
      );
      release();
      await service.waitForIdle(id);
      batch = await service.get(owner, id);
      assert.equal(maxActive, 1);
      assert.equal(calls, 2);
      assert.equal(
        batch.rows[0].shares,
        99,
        'late recognition never overwrites an investor edit',
      );
      assert.ok(batch.rows[0].conflicts?.length);
      assert.equal(batch.images[0].timings?.startupMs !== undefined, true);
      assert.equal(batch.images[0].timings?.inferenceMs !== undefined, true);
      assert.equal(batch.firstResultMs !== undefined, true);
      assert.equal(JSON.stringify(batch).includes(image.data), false);
      mode = 'content';
      calls = 0;
      const contentId = await create();
      await service.waitForIdle(contentId);
      const content = await service.get(owner, contentId);
      assert.equal(calls, 2);
      assert.deepEqual(
        content.images.map((image) => image.status),
        ['failed', 'completed'],
      );
      mode = 'auth';
      calls = 0;
      const authId = await create();
      await service.waitForIdle(authId);
      const auth = await service.get(owner, authId);
      assert.equal(calls, 1);
      assert.equal(auth.status, 'paused');
      assert.equal(auth.images[1].status, 'queued');
    } finally {
      release?.();
      await service?.onModuleDestroy();
      await client.end();
      await admin`DROP SCHEMA ${admin(namespace)} CASCADE`;
      await admin.end();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
