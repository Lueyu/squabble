import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { E2bAdapter } from './e2b.adapter';
import type { ComputeSandboxFactory, ComputeSandbox } from './e2b.adapter';

const config = { apiKey: 'fake-e2b-only', templateId: 'fixed-analytics-template', templateVersion: 'worker-1' };
const bytes = Buffer.from('{"result":1}');
const output = { files: [{ name: 'result.json', mime: 'application/json', sizeBytes: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex') }] };
function sandbox(overrides: Partial<ComputeSandbox> = {}): ComputeSandbox {
  return { id: 'sandbox-receipt', write: async () => {},
    read: async path => new ReadableStream({ start(controller) {
      controller.enqueue(path.endsWith('outputs.json') ? Buffer.from(JSON.stringify(output)) : bytes); controller.close();
    } }), execute: async () => ({ stdout: 'done', stderr: '', error: null }), kill: async () => true, ...overrides };
}

test('unconfigured E2B does not create a sandbox', async () => {
  let creates = 0;
  const adapter = new E2bAdapter(null, async () => { creates += 1; return sandbox(); });
  assert.equal(adapter.status(), 'unconfigured');
  await assert.rejects(adapter.run({ jobId: 'fake-job', manifest: {}, files: [], maxRuntimeMs: 1000, maxOutputBytes: 1000 },
    async () => {}), /E2B_UNCONFIGURED/);
  assert.equal(creates, 0);
});

test('single sandbox creation disables public network and uses a durable idempotency key', async () => {
  let creates = 0, kills = 0, saved = '';
  const factory: ComputeSandboxFactory = async options => {
    creates += 1;
    assert.equal(options.allowInternetAccess, false); assert.equal(options.network.allowPublicTraffic, false);
    assert.deepEqual(options.envs, {}); assert.equal(options.idempotencyKey, 'fake-job');
    return sandbox({ kill: async () => { kills += 1; return true; } });
  };
  const result = await new E2bAdapter(config, factory).run({ jobId: 'fake-job', manifest: {}, files: [],
    maxRuntimeMs: 1000, maxOutputBytes: 1000 }, async id => { saved = id; });
  assert.equal(creates, 1); assert.equal(kills, 1); assert.equal(saved, 'sandbox-receipt');
  assert.equal(result.terminationConfirmed, true); assert.equal(result.files[0].data.toString(), bytes.toString());
});

test('execution or download failure always destroys the sandbox and never creates a replacement', async () => {
  for (const failure of ['execute', 'download']) {
    let creates = 0, kills = 0;
    const adapter = new E2bAdapter(config, async () => {
      creates += 1;
      return sandbox({ ...(failure === 'execute' ? { execute: async () => { throw new Error('execution transport lost'); } }
        : { read: async () => { throw new Error('download lost'); } }), kill: async () => { kills += 1; return true; } });
    });
    await assert.rejects(adapter.run({ jobId: 'fake-job', manifest: {}, files: [], maxRuntimeMs: 1000, maxOutputBytes: 1000 }, async () => {}));
    assert.equal(creates, 1); assert.equal(kills, 1);
  }
});

test('unconfirmed cleanup remains unknown and corrupt output is never accepted', async () => {
  const adapter = new E2bAdapter(config, async () => sandbox({ kill: async () => { throw new Error('unknown termination'); } }));
  await assert.rejects(adapter.run({ jobId: 'fake-job', manifest: {}, files: [], maxRuntimeMs: 1000, maxOutputBytes: 1000 }, async () => {}),
    /E2B_CLEANUP_UNKNOWN/);
  const corrupt = new E2bAdapter(config, async () => sandbox({ read: async path => new ReadableStream({ start(controller) {
    controller.enqueue(path.endsWith('outputs.json') ? Buffer.from(JSON.stringify(output)) : Buffer.from('tampered')); controller.close();
  } }) }));
  await assert.rejects(corrupt.run({ jobId: 'fake-job', manifest: {}, files: [], maxRuntimeMs: 1000, maxOutputBytes: 1000 }, async () => {}), /OUTPUT_INTEGRITY/);
});

test('SDK false kill response confirms the sandbox is already absent', async () => {
  const result = await new E2bAdapter(config, async () => sandbox({ kill: async () => false })).run(
    { jobId: 'fake-job', manifest: {}, files: [], maxRuntimeMs: 1000, maxOutputBytes: 1000 }, async () => {});
  assert.equal(result.terminationConfirmed, true);
});
