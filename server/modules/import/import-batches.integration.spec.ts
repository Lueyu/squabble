import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { holdings } from '../../database/schema';
import { ImportBatchesService } from './import-batches.service';
import { ImportBatchFiles } from './import-batch-files';
import { importBatches } from '../../database/import-batches.schema';
import { ImportService } from './import.service';
import type { QuoteService } from '../quote/quote.service';
import type { LocalAgentsService } from '../local-agents/local-agents.service';
import type { OcrService } from './ocr.service';
import type { ImportAnalysisHandoffService } from '../experience/import-analysis-handoff.service';
const image = {
  mimeType: 'image/png' as const,
  data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
};
test(
  'durable batches isolate owners, retain partial results and atomically apply incremental upserts',
  {
    skip:
      !process.env.EXPERIENCE_TEST_DATABASE_URL &&
      !process.env.RESEARCH_TEST_DATABASE_URL,
  },
  async () => {
    const url =
      process.env.EXPERIENCE_TEST_DATABASE_URL ??
      process.env.RESEARCH_TEST_DATABASE_URL!;
    const namespace = 'import_batch_' + randomUUID().replaceAll('-', ''),
      admin = postgres(url, { max: 1, onnotice: () => {} }),
      client = postgres(url, {
        max: 6,
        onnotice: () => {},
        connection: { search_path: namespace },
      });
    const directory = await mkdtemp(join(tmpdir(), 'squabble-import-'));
    await admin`CREATE SCHEMA ${admin(namespace)}`;
    let service: ImportBatchesService | undefined;
    try {
      for (const file of (await readdir('scripts/db'))
        .filter((f) => /^\d\d_.*\.sql$/.test(f) && !f.startsWith('02_'))
        .sort())
        await client.unsafe(await readFile('scripts/db/' + file, 'utf8'));
      const db = drizzle(client),
        owner = randomUUID();
      let calls = 0,
        analysis = 0;
      const tasks = new Map<
        string,
        {
          state: string;
          text?: string;
          error?: string;
        }
      >();
      const agents = {
        validate: async () => undefined,
        cancelTask: async () => 'cancelling',
        store: {
          task: async (_owner: string, taskId: string) => {
            if (!tasks.has(taskId)) throw Error('LOCAL_TASK_NOT_FOUND');
            return tasks.get(taskId);
          },
          cancel: async () => 'cancelling',
        },
        execute: async (
          _owner: string,
          input: {
            onTask: (ref: {
              taskId: string;
              contextId: string;
            }) => Promise<void>;
          },
        ) => {
          calls++;
          await input.onTask({ taskId: randomUUID(), contextId: 'fixture' });
          return {
            text: JSON.stringify({
              rows: [
                {
                  ticker: 'TEST',
                  shares: 10,
                  avgCost: 20,
                  currentPrice: 30,
                  currency: 'USD',
                },
                { ticker: 'BROKEN', shares: 'unclear', currency: 'USD' },
              ],
            }),
          };
        },
      } as unknown as LocalAgentsService;
      const handoff = {
        enqueueInTransaction: async () => {
          analysis++;
          return { id: randomUUID(), state: 'pending' };
        },
      } as unknown as ImportAnalysisHandoffService;
      service = new ImportBatchesService(
        db,
        agents,
        {} as OcrService,
        new ImportBatchFiles(directory),
        handoff,
      );
      const id = randomUUID();
      await service.create(owner, {
        id,
        executor: { executor: 'local', agentId: 'native-codex' },
      });
      await assert.rejects(service.get('stranger', id), /BATCH_NOT_FOUND/);
      await service.upload(owner, id, {
        id: randomUUID(),
        filename: 'one.png',
        image,
      });
      await service.start(owner, id);
      await service.waitForIdle(id);
      let batch = await service.get(owner, id);
      assert.equal(calls, 1);
      assert.equal(batch.rows.length, 2);
      assert.equal(batch.images[0].problemCount, 1);
      const good = batch.rows.find((row) => row.ticker === 'TEST')!;
      await assert.rejects(
        service.edit(
          owner,
          id,
          good.id,
          { currency: null, confirmed: true },
          batch.revision,
        ),
        /INVALID_ROWS/,
      );
      batch = await service.edit(
        owner,
        id,
        good.id,
        { shares: 12, confirmed: true },
        batch.revision,
      );
      const preview = await service.preview(owner, id);
      const request = {
        requestKey: 'first',
        expectedRevision: batch.revision,
        holdingsRevision: preview.holdingsRevision,
        rowIds: [good.id],
        analyze: true,
      };
      const first = await service.commit(owner, id, request);
      assert.equal(first.created, 1);
      assert.equal(analysis, 1);
      assert.equal(
        (await db.select().from(holdings).where(eq(holdings.owner, owner)))[0]
          .currentPrice,
        '30',
      );
      assert.equal((await service.commit(owner, id, request)).id, first.id);
      assert.equal(analysis, 1);
      batch = await service.get(owner, id);
      const bad = batch.rows.find((row) => row.ticker === 'BROKEN')!;
      batch = await service.edit(
        owner,
        id,
        bad.id,
        { shares: 3, avgCost: null, confirmed: true },
        batch.revision,
      );
      const next = await service.preview(owner, id);
      const second = await service.commit(owner, id, {
        requestKey: 'second',
        expectedRevision: batch.revision,
        holdingsRevision: next.holdingsRevision,
        rowIds: [bad.id],
        analyze: false,
      });
      assert.notEqual(second.id, first.id);
      assert.equal(
        (await db.select().from(holdings).where(eq(holdings.owner, owner)))
          .length,
        2,
      );
      batch = await service.get(owner, id);
      batch = await service.edit(
        owner,
        id,
        good.id,
        { shares: 15, confirmed: true },
        batch.revision,
      );
      const stale = await service.preview(owner, id);
      await db
        .update(holdings)
        .set({ shares: '99' })
        .where(eq(holdings.owner, owner));
      await assert.rejects(
        service.commit(owner, id, {
          requestKey: 'stale',
          expectedRevision: batch.revision,
          holdingsRevision: stale.holdingsRevision,
          rowIds: [good.id],
          analyze: false,
        }),
        /HOLDINGS_CHANGED/,
      );
      assert.equal(
        (await db.select().from(holdings).where(eq(holdings.owner, owner)))[0]
          .shares,
        '99',
      );
      const csv = new ImportService(db, {} as QuoteService, handoff);
      const csvInput = {
        source: 'csv' as const,
        requestKey: 'csv:first',
        analyze: true,
        rows: [{ ticker: 'TEST', shares: 42, avgCost: 10 }],
      };
      const csvReceipt = await csv.commit(owner, csvInput);
      assert.equal(csvReceipt.updated, 1);
      assert.equal(csvReceipt.created, 0);
      assert.equal(
        (await csv.commit(owner, csvInput)).receiptId,
        csvReceipt.receiptId,
      );
      const beforeRollback = await db
        .select()
        .from(holdings)
        .where(eq(holdings.owner, owner));
      const failingCsv = new ImportService(
        db,
        {} as QuoteService,
        {
          enqueueInTransaction: async () => {
            throw new Error('fixture-outbox-failure');
          },
        } as unknown as ImportAnalysisHandoffService,
      );
      await assert.rejects(
        failingCsv.commit(owner, {
          source: 'csv',
          requestKey: 'rollback',
          analyze: true,
          rows: [
            { ticker: 'TEST', shares: 1000 },
            { ticker: 'NEW', shares: 100 },
          ],
        }),
        /fixture-outbox-failure/,
      );
      assert.deepEqual(
        (await db.select().from(holdings).where(eq(holdings.owner, owner))).map(
          (row) => [row.id, row.shares],
        ),
        beforeRollback.map((row) => [row.id, row.shares]),
      );
      await assert.rejects(
        service.edit(
          owner,
          id,
          good.id,
          { sourceImageIds: ['other'] } as never,
          batch.revision,
        ),
        /INVALID_ROW_PATCH/,
      );
      const visionId = randomUUID(),
        visionRoute = {
          executor: 'vision' as const,
          model: 'fixture-model',
          baseUrl: 'https://trusted.invalid',
          apiKey: 'fixture-secret',
        };
      let endpoint: string | undefined;
      const visionService = new ImportBatchesService(
        db,
        agents,
        {
          extract: async (input: { baseUrl: string }) => {
            endpoint = input.baseUrl;
            return {
              broker: null,
              rows: [{ ticker: 'SAFE', shares: 1, currency: 'USD' }],
            };
          },
        } as unknown as OcrService,
        new ImportBatchFiles(directory),
        handoff,
      );
      await visionService.create(owner, {
        id: visionId,
        executor: visionRoute,
      });
      await assert.rejects(
        visionService.create('stranger', {
          id: visionId,
          executor: { ...visionRoute, baseUrl: 'https://attacker.invalid' },
        }),
        /BATCH_NOT_FOUND/,
      );
      await assert.rejects(
        visionService.start(owner, visionId, {
          ...visionRoute,
          baseUrl: 'https://attacker.invalid',
        }),
        /INVALID_REQUEST/,
      );
      await visionService.upload(owner, visionId, {
        id: randomUUID(),
        filename: 'safe.png',
        image,
      });
      await visionService.start(owner, visionId);
      await visionService.waitForIdle(visionId);
      assert.equal(
        endpoint,
        'https://trusted.invalid',
        'failed foreign creation never changes the victim execution route',
      );
      await visionService.onModuleDestroy();
      const recoveryId = randomUUID();
      let recovery = await service.create(owner, {
        id: recoveryId,
        executor: { executor: 'local', agentId: 'native-codex' },
      });
      recovery = await service.upload(owner, recoveryId, {
        id: randomUUID(),
        filename: 'old.png',
        image,
      });
      const taskId = randomUUID();
      recovery.status = 'running';
      recovery.images[0].status = 'running';
      recovery.images[0].taskId = taskId;
      recovery.images[0].expiresAt = new Date(0).toISOString();
      await db
        .update(importBatches)
        .set({ state: recovery })
        .where(eq(importBatches.id, recoveryId));
      const beforeRecovery = calls;
      await service.recover();
      assert.equal(
        calls,
        beforeRecovery,
        'restart never replays a dispatched unknown task',
      );
      assert.equal(
        (await service.get(owner, recoveryId)).images[0].status,
        'unknown',
      );
      assert.equal(
        (await service.get(owner, recoveryId)).images[0].cleanupPending,
        true,
        'unknown executor may still be reading',
      );
      tasks.set(taskId, {
        state: 'completed',
        text: JSON.stringify({
          rows: [{ ticker: 'RECOVERED', shares: 1, currency: 'USD' }],
        }),
      });
      await service.recover();
      const recovered = await service.get(owner, recoveryId);
      assert.equal(recovered.rows[0].ticker, 'RECOVERED');
      assert.equal(recovered.images[0].fileAvailable, false);
      assert.equal(calls, beforeRecovery);
      const reselectId = randomUUID();
      await service.create(owner, {
        id: reselectId,
        executor: { executor: 'local', agentId: 'native-codex' },
      });
      let reselect = await service.upload(owner, reselectId, {
        id: randomUUID(),
        filename: 'reselect.png',
        image,
      });
      reselect.images[0].status = 'failed';
      reselect.images[0].expiresAt = new Date(0).toISOString();
      reselect.status = 'completed';
      await db
        .update(importBatches)
        .set({ state: reselect })
        .where(eq(importBatches.id, reselectId));
      await service.expire();
      await assert.rejects(
        service.retry(owner, reselectId, reselect.images[0].id),
        /IMAGE_EXPIRED_RESELECT/,
      );
      await service.reselect(owner, reselectId, reselect.images[0].id, image);
      await service.waitForIdle(reselectId);
      assert.equal(
        (await service.get(owner, reselectId)).images[0].status,
        'completed',
      );
      const tenId = randomUUID(),
        tenAgents = {
          validate: async () => undefined,
          execute: async (
            _owner: string,
            input: {
              onTask: (ref: {
                taskId: string;
                contextId: string;
              }) => Promise<void>;
            },
          ) => {
            await input.onTask({ taskId: randomUUID(), contextId: 'fixture' });
            return {
              text: JSON.stringify({
                rows: Array.from({ length: 10 }, (_, index) => ({
                  ticker: `T${index}`,
                  shares: 10 + index,
                  currency: 'USD',
                  avgCost: null,
                })),
              }),
            };
          },
        } as unknown as LocalAgentsService;
      const tenService = new ImportBatchesService(
        db,
        tenAgents,
        {} as OcrService,
        new ImportBatchFiles(directory),
        handoff,
      );
      await tenService.create(owner, {
        id: tenId,
        executor: { executor: 'local', agentId: 'native-codex' },
      });
      await tenService.upload(owner, tenId, {
        id: randomUUID(),
        filename: 'ten.png',
        image,
      });
      await tenService.upload(owner, tenId, {
        id: randomUUID(),
        filename: 'same-image-again.png',
        image,
      });
      assert.equal(
        (await tenService.get(owner, tenId)).images.length,
        1,
        'fingerprint duplicate never causes another recognition',
      );
      await tenService.start(owner, tenId);
      await tenService.waitForIdle(tenId);
      let ten = await tenService.get(owner, tenId);
      for (const row of ten.rows)
        ten = await tenService.edit(
          owner,
          tenId,
          row.id,
          { confirmed: true },
          ten.revision,
        );
      const seven = await tenService.commit(owner, tenId, {
        requestKey: 'seven-of-ten',
        expectedRevision: ten.revision,
        holdingsRevision: (await tenService.preview(owner, tenId))
          .holdingsRevision,
        rowIds: ten.rows.slice(0, 7).map((row) => row.id),
        analyze: false,
      });
      assert.equal(seven.created, 7);
      ten = await tenService.get(owner, tenId);
      const three = await tenService.commit(owner, tenId, {
        requestKey: 'last-three',
        expectedRevision: ten.revision,
        holdingsRevision: (await tenService.preview(owner, tenId))
          .holdingsRevision,
        rowIds: ten.rows.slice(7).map((row) => row.id),
        analyze: false,
      });
      assert.equal(three.created, 3);
      assert.notEqual(seven.id, three.id);
      assert.ok(ten.firstResultMs !== undefined);
      assert.ok(ten.images[0].timings?.totalMs !== undefined);
      await tenService.onModuleDestroy();
    } finally {
      await service?.onModuleDestroy();
      await client.end();
      await admin`DROP SCHEMA ${admin(namespace)} CASCADE`;
      await admin.end();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
