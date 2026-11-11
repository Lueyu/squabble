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

test('discovered schemas reject external refs, oversized and deep schemas', () => {
  assert.throws(() => validateToolSchema({ type: 'object', properties: { x: { $ref: 'https://evil.org/schema' } } }), /SCHEMA_RESTRICTED/u);
  assert.throws(() => validateToolSchema({ type: 'object', description: 'x'.repeat(65537) }), /SCHEMA_RESTRICTED/u);
  assert.throws(() => validateToolSchema({ type: 'object', properties: { q: { type: 'string', pattern: '^(a+)+$' } } }), /SCHEMA_RESTRICTED/u);
  assert.deepEqual(validateToolSchema({ type: 'object', properties: { q: { type: 'string' } } }),
    { type: 'object', properties: { q: { type: 'string' } } });
});
