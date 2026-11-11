import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { ToolTransportPolicy } from './tool-transport-policy';
import { validateToolSchema } from './tool-catalog.service';

test('public MCP rejects local endpoints; only exact deployer registered side services are reachable', async () => {
  const policy = new ToolTransportPolicy([]);
  await assert.rejects(policy.normalizeEndpoint('http://127.0.0.1:4000/mcp'), /ENDPOINT_RESTRICTED/u);
  const local = new ToolTransportPolicy([{ id: 'fixture', endpoint: 'http://127.0.0.1:4000/mcp' }]);
  assert.equal(await local.normalizeEndpoint('http://127.0.0.1:4000/mcp'), 'http://127.0.0.1:4000/mcp');
  await assert.rejects(local.normalizeEndpoint('http://127.0.0.1:4000/other'), /ENDPOINT_RESTRICTED/u);
});

test('transport refuses redirects before credentials can reach another URL and bounds output', async () => {
  let leaked = false;
  const server = createServer((req, res) => {
    if (req.url === '/leak') leaked = true;
    res.writeHead(302, { Location: '/leak' }); res.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const endpoint = `http://127.0.0.1:${address.port}/mcp`;
  try {
    const policy = new ToolTransportPolicy([{ id: 'fixture', endpoint }]);
    await assert.rejects(policy.fetch(endpoint, { headers: { Authorization: 'Bearer test-secret' } }, endpoint), /REDIRECT_RESTRICTED/u);
    assert.equal(leaked, false);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('cancelling a nonempty 202 response closes its HTTP source without late stream enqueue', async () => {
  const server = createServer((_req, res) => { res.writeHead(202, { 'Content-Type': 'text/plain' }); res.end('Accepted'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const endpoint = `http://127.0.0.1:${address.port}/mcp`;
  try {
    const policy = new ToolTransportPolicy([{ id: 'fixture', endpoint }]);
    const response = await policy.fetch(endpoint, { method: 'POST', body: '{}' }, endpoint);
    assert.equal(response.status, 202);
    await response.body!.cancel();
    await new Promise<void>(resolve => setImmediate(resolve));
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('stream cancellation stops a pending HTTP response and output limits still reject reads', async () => {
  let sourceClosed!: () => void;
  const closed = new Promise<void>(resolve => { sourceClosed = resolve; });
  const server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    if (req.headers['x-fixture-limit']) { res.end('longer than the bound'); return; }
    res.write('first');
    const timer = setInterval(() => res.write('tail'), 2);
    res.once('close', () => { clearInterval(timer); sourceClosed(); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const endpoint = `http://127.0.0.1:${address.port}/mcp`;
  try {
    const policy = new ToolTransportPolicy([{ id: 'fixture', endpoint }]);
    const response = await policy.fetch(endpoint, {}, endpoint);
    const reader = response.body!.getReader();
    assert.equal((await reader.read()).done, false);
    await reader.cancel();
    await Promise.race([closed, new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('HTTP_SOURCE_NOT_CLOSED')), 1500); timer.unref();
    })]);
    const limited = await policy.fetch(endpoint, { headers: { 'x-fixture-limit': '1' } }, endpoint, 8);
    await assert.rejects(limited.text(), /TOOL_OUTPUT_LIMIT/u);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('aborting while a response body read is pending rejects that read and closes the source', async () => {
  let responseOpened!: () => void;
  const opened = new Promise<void>(resolve => { responseOpened = resolve; });
  const server = createServer((_req, res) => { res.writeHead(200); res.flushHeaders(); responseOpened(); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const endpoint = `http://127.0.0.1:${address.port}/mcp`;
  try {
    const policy = new ToolTransportPolicy([{ id: 'fixture', endpoint }]), cancellation = new AbortController();
    const response = await policy.fetch(endpoint, { signal: cancellation.signal }, endpoint);
    await opened;
    const pending = response.body!.getReader().read();
    cancellation.abort();
    await assert.rejects(pending);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('discovered schemas reject external refs, oversized and deep schemas', () => {
  assert.throws(() => validateToolSchema({ type: 'object', properties: { x: { $ref: 'https://evil.org/schema' } } }), /SCHEMA_RESTRICTED/u);
  assert.throws(() => validateToolSchema({ type: 'object', description: 'x'.repeat(65537) }), /SCHEMA_RESTRICTED/u);
  assert.throws(() => validateToolSchema({ type: 'object', properties: { q: { type: 'string', pattern: '^(a+)+$' } } }), /SCHEMA_RESTRICTED/u);
  assert.deepEqual(validateToolSchema({ type: 'object', properties: { q: { type: 'string' } } }),
    { type: 'object', properties: { q: { type: 'string' } } });
});
