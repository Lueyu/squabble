import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { PostgresJsDatabase } from '../../common/platform';
import type { ImportBatch } from '../../../shared/screenshot-import.interface';
import { ImportBatchesService } from './import-batches.service';
import type { ImportBatchFiles } from './import-batch-files';
import type { LocalAgentsService } from '../local-agents/local-agents.service';
import type { OcrService } from './ocr.service';

function fixture(task = { state: 'failed', error: 'LOCAL_DISPATCH_UNCERTAIN', runtimeEntered: true }) {
  const owner = randomUUID();
  const state: ImportBatch = {
    id: randomUUID(), revision: 0, status: 'queued',
    executor: { executor: 'local', agentId: 'native-codex' },
    images: [{ id: randomUUID(), filename: 'fixture.png', fingerprint: 'fixture', bytes: 1,
      mimeType: 'image/png', status: 'queued', attempt: 0,
      expiresAt: new Date(Date.now() + 3600_000).toISOString(), fileAvailable: true, timings: {} }],
    rows: [], receipts: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  const records = [{ owner, id: state.id, state }];
  const db = { select: () => ({ from: () => Object.assign(Promise.resolve(records), { where: async () => records }) }) };
  let calls = 0, removals = 0;
  const agents = {
    validate: async () => undefined,
    execute: async () => { calls++; return { text: JSON.stringify({ rows: [{ ticker: 'TEST', shares: 1, currency: 'USD' }] }) }; },
    cancelTask: async () => task.state,
    store: { task: async () => task },
  };
  const files = {
    read: async (_owner: string, _id: string, _mime: string, reader: (image: object) => Promise<unknown>) => reader({}),
    remove: async () => { removals++; return true; },
    cleanupUnreferenced: async () => undefined,
  };
  const service = new ImportBatchesService(db as unknown as PostgresJsDatabase, agents as unknown as LocalAgentsService,
    {} as OcrService, files as unknown as ImportBatchFiles);
  service.get = async () => structuredClone(state);
  const internals = service as unknown as {
    mutate(owner: string, id: string, change: (batch: ImportBatch) => void | Promise<void>): Promise<ImportBatch>;
    run(owner: string, id: string): Promise<void>;
  };
  internals.mutate = async (_owner, _id, change) => { await change(state); return structuredClone(state); };
  return { owner, state, service, internals, calls: () => calls, removals: () => removals };
}

test('a cancellation winning the queued-image claim prevents provider dispatch', async () => {
  const f = fixture();
  const mutate = f.internals.mutate;
  let beforeClaim = true;
  f.internals.mutate = async (owner, id, change) => {
    if (beforeClaim) { beforeClaim = false; await f.service.cancel(owner, id); }
    return mutate(owner, id, change);
  };
  await f.internals.run(f.owner, f.state.id);
  assert.equal(f.calls(), 0);
  assert.equal(f.state.status, 'cancelled');
  assert.equal(f.state.images[0].status, 'cancelled');
});

for (const error of ['LOCAL_DISPATCH_UNCERTAIN', 'LOCAL_INTERRUPTED']) {
  test(`cancelled batches retain ${error} image leases until termination is confirmed`, async () => {
    const f = fixture({ state: 'failed', error, runtimeEntered: true });
    f.state.images[0].status = 'unknown';
    f.state.images[0].taskId = randomUUID();
    f.state.images[0].expiresAt = new Date(0).toISOString();
    await f.service.cancel(f.owner, f.state.id);
    await f.service.recover(f.owner, f.state.id);
    assert.equal(f.state.status, 'cancelled');
    assert.equal(f.state.images[0].status, 'unknown');
    assert.equal(f.state.images[0].cleanupPending, true);
    assert.equal(f.state.images[0].fileAvailable, true);
    assert.equal(f.removals(), 0);
    assert.equal(f.calls(), 0);
  });
}

test('confirmed cancellation permits expired original cleanup', async () => {
  const f = fixture({ state: 'cancelled', error: 'LOCAL_CANCELLED', runtimeEntered: true });
  f.state.images[0].status = 'unknown';
  f.state.images[0].taskId = randomUUID();
  f.state.images[0].expiresAt = new Date(0).toISOString();
  await f.service.cancel(f.owner, f.state.id);
  await f.service.recover(f.owner, f.state.id);
  assert.equal(f.state.images[0].status, 'cancelled');
  assert.equal(f.state.images[0].fileAvailable, false);
  assert.equal(f.removals(), 1);
});
