import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ScreenshotJobsService } from './screenshot-jobs.service';
import type { LocalAgentsService } from '../local-agents/local-agents.service';
import type { LocalAgentExecution } from '../local-agents/local-agents.types';
import type { OcrService } from './ocr.service';
import type { ScreenshotExtractRequest } from '../../../shared/screenshot-import.interface';

const image = { mimeType: 'image/png' as const, data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=' };
const reply = '{"broker":null,"rows":[{"ticker":"TEST","shares":2}]}';
const tick = () => new Promise(resolve => setTimeout(resolve, 10));
function request(): ScreenshotExtractRequest { return { requestId: randomUUID(), image, executor: 'local', agentId: 'native-codex' }; }
function setup(execute: (owner: string, options: LocalAgentExecution) => Promise<unknown>, options = {}) {
  return new ScreenshotJobsService({ execute } as unknown as LocalAgentsService, {} as OcrService, options);
}

test('idempotent jobs are owner-scoped, return parsed rows, never expose image or credentials', async () => {
  let calls = 0;
  const service = setup(async (_owner, options) => {
    calls++; assert.deepEqual(options.image, image); return { text: reply };
  });
  const dto = request();
  const job = service.start('alice', dto);
  assert.equal(job.id, dto.requestId);
  service.start('alice', dto);
  await tick();
  assert.equal(calls, 1);
  const done = service.get('alice', job.id);
  assert.equal(done.status, 'completed');
  assert.equal(done.result?.rows[0].shares, 2);
  assert.equal(JSON.stringify(done).includes(image.data), false);
  assert.throws(() => service.get('bob', job.id), /JOB_NOT_FOUND/);
  assert.throws(() => service.start('alice', { ...dto, image: { ...image, data: image.data + 'A' } }), /INVALID_IMAGE|INVALID_REQUEST/);
  done.result!.rows[0].shares = 999;
  assert.equal(service.get('alice', job.id).result?.rows[0].shares, 2);
  await service.onModuleDestroy();
});

test('cancel suppresses late results and keeps occupied import slot until runner stops', async () => {
  let finish!: (value: unknown) => void;
  let execution!: LocalAgentExecution;
  const service = setup(async (_owner, options) => { execution = options; return new Promise(resolve => { finish = resolve; }); });
  const job = service.start('alice', request());
  await tick();
  assert.throws(() => service.start('alice', request()), /IMPORT_BUSY/);
  assert.equal(service.cancel('alice', job.id).status, 'cancelled');
  assert.equal(await execution.shouldContinue(), false);
  assert.throws(() => service.start('alice', request()), /IMPORT_BUSY/);
  finish({ text: reply }); await tick();
  assert.equal(service.get('alice', job.id).status, 'cancelled');
  await service.onModuleDestroy();
});

test('timeout and quota failures are explicit and do not trigger fallback or retry', async () => {
  let calls = 0;
  const quota = setup(async () => { calls++; throw Object.assign(new Error('private diagnostic'), { code: 'LOCAL_USAGE_LIMIT' }); });
  const job = quota.start('alice', request()); await tick();
  assert.equal(quota.get('alice', job.id).error?.code, 'LOCAL_USAGE_LIMIT');
  assert.equal(calls, 1);
  await quota.onModuleDestroy();
  const timeout = setup(async (_owner, options) => {
    while (await options.shouldContinue()) await tick();
    throw new Error('stopped');
  }, { timeoutMs: 5 });
  const slow = timeout.start('alice', request()); await tick(); await tick();
  assert.equal(timeout.get('alice', slow.id).error?.code, 'EXTRACTION_TIMEOUT');
  await timeout.onModuleDestroy();
});

test('bounded lifetime does not replay missing jobs and invalid images never dispatch', async () => {
  let now = 1000; let calls = 0;
  const service = setup(async () => { calls++; return { text: reply }; }, { now: () => now, ttlMs: 100 });
  const dto = request(); service.start('alice', dto); await tick();
  assert.throws(() => service.start('alice', { ...request(), image: { ...image, data: Buffer.from('not an image').toString('base64') } }), /INVALID_IMAGE/);
  now += 101;
  assert.throws(() => service.get('alice', dto.requestId), /JOB_NOT_FOUND/);
  assert.equal(calls, 1);
  await service.onModuleDestroy();
});
