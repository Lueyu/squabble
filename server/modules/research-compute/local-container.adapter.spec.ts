import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { LocalContainerAdapter } from './local-container.adapter';

test('local default remains unavailable without private broker configuration', async () => {
  const adapter = new LocalContainerAdapter(null);
  assert.equal(adapter.provider, 'local-container');
  assert.equal(adapter.status(), 'unconfigured');
  await assert.rejects(adapter.run({ jobId: 'fake', manifest: {}, files: [], maxRuntimeMs: 1000, maxOutputBytes: 1024 }, async () => {}), /LOCAL_SANDBOX_UNCONFIGURED/);
});

test('broker endpoints reject public destinations and credentials in URLs', () => {
  for (const endpoint of ['https://example.com', 'http://user:secret@127.0.0.1:8093', 'file:///tmp/socket']) {
    assert.throws(() => new LocalContainerAdapter({ endpoint, token: 'test-only-token'.repeat(3) }), /SANDBOX_BROKER_URL_INVALID/);
  }
});

test('local adapter saves identity before start and verifies terminated output independently', async () => {
  const deployment = randomUUID(), jobId = randomUUID(), sandboxId = `local:${deployment}:${jobId}`;
  const data = Buffer.from('{"classification":"exploratory"}');
  let saved = false, started = 0;
  const receipt = { jobId, sandboxId, state: 'created', terminationConfirmed: false, errorCode: null, imageId: 'sha256:fixture', protocolVersion: 1 };
  const server = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${'fixture-token-'.repeat(4)}`);
    for await (const _chunk of request) { /* Drain bounded synthetic request before responding. */ }
    let body: unknown;
    if (request.url === '/health') body = { status: 'ready', provider: 'local-container', protocolVersion: 1, imageId: 'sha256:fixture', deploymentId: deployment };
    else if (request.url === '/v1/jobs') body = receipt;
    else if (request.url?.endsWith('/start')) { assert.equal(saved, true); started += 1; body = { ...receipt, state: 'succeeded', terminationConfirmed: true }; }
    else body = { ...receipt, state: 'succeeded', terminationConfirmed: true, stdout: '', stderr: '', files: [{ name: 'result.json',
      mime: 'application/json', sha256: createHash('sha256').update(data).digest('hex'), base64: data.toString('base64') }] };
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(body));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const adapter = new LocalContainerAdapter({ endpoint: `http://127.0.0.1:${address.port}`, token: 'fixture-token-'.repeat(4) });
    const result = await adapter.run({ jobId, manifest: {}, files: [], maxRuntimeMs: 1000, maxOutputBytes: 1024 }, async id => { assert.equal(id, sandboxId); saved = true; });
    assert.equal(started, 1); assert.equal(result.terminationConfirmed, true); assert.deepEqual(result.files[0].data, data);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
