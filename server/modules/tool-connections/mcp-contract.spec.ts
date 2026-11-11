import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { McpClientAdapter } from './mcp-client.adapter';
import { ToolTransportPolicy } from './tool-transport-policy';

export async function fakeMcp() {
  let schemaVersion = 1, calls = 0, authenticated = true, dropped = false, oversized = false;
  const methods: string[] = [];
  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== 'Bearer fixture-secret' || !authenticated) { res.writeHead(401); res.end(); return; }
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const message = JSON.parse(Buffer.concat(chunks).toString('utf8')); methods.push(message.method);
    if (!('id' in message)) { res.writeHead(202); res.end(); return; }
    let result: unknown;
    if (message.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'fixture', version: '1' } };
    if (message.method === 'tools/list') result = { tools: [{ name: 'lookup', description: `lookup v${schemaVersion}`,
      inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'], additionalProperties: false },
      annotations: { readOnlyHint: true } }] };
    if (message.method === 'tools/call') {
      calls++;
      if (dropped) { req.socket.destroy(); return; }
      result = { content: [{ type: 'text', text: oversized ? 'x'.repeat(2_100_000) : `found ${message.params.arguments.q}` }] };
    }
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const endpoint = `http://127.0.0.1:${address.port}/mcp`;
  return { endpoint, methods, get calls() { return calls; }, changeSchema() { schemaVersion++; },
    expireAuth() { authenticated = false; }, dropCall() { dropped = true; }, oversize() { oversized = true; },
    close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }) };
}

test('official MCP client lists and calls exact frozen schemas; remote readOnly hint does not grant read permission', async () => {
  const fixture = await fakeMcp();
  const adapter = new McpClientAdapter(new ToolTransportPolicy([{ id: 'fixture', endpoint: fixture.endpoint }]));
  const connection = { id: 'fixture', provider: 'mcp', endpoint: fixture.endpoint, secret: 'fixture-secret' };
  try {
    const tools = await adapter.discover(connection);
    assert.equal(fixture.calls, 0); assert.equal(tools[0].effect, 'external_write');
    const result = await adapter.invoke(connection, tools[0], { q: 'cash flow' }, { invocationId: 'invocation' });
    assert.equal(fixture.calls, 1); assert.match(JSON.stringify(result.output), /cash flow/u);
    fixture.changeSchema();
    await assert.rejects(adapter.invoke(connection, tools[0], { q: 'query' }, { invocationId: 'invocation2' }), /TOOL_RECONFIRMATION_REQUIRED/u);
    assert.equal(fixture.calls, 1);
    fixture.expireAuth(); await assert.rejects(adapter.discover(connection), /TOOL_AUTHORIZATION_REQUIRED/u);
  } finally { await fixture.close(); }
});

test('sent MCP call with disconnected response is unknown and is never automatically repeated', async () => {
  const fixture = await fakeMcp();
  const adapter = new McpClientAdapter(new ToolTransportPolicy([{ id: 'fixture', endpoint: fixture.endpoint }]));
  const connection = { id: 'fixture', provider: 'mcp', endpoint: fixture.endpoint, secret: 'fixture-secret' };
  try {
    const [tool] = await adapter.discover(connection); fixture.dropCall();
    await assert.rejects(adapter.invoke(connection, tool, { q: 'x' }, { invocationId: 'invocation' }), /TOOL_PROVIDER_UNKNOWN/u);
    assert.equal(fixture.calls, 1);
  } finally { await fixture.close(); }
});

test('MCP oversized responses are bounded and cancellation before dispatch never sends tools/call', async () => {
  const fixture = await fakeMcp();
  const adapter = new McpClientAdapter(new ToolTransportPolicy([{ id: 'fixture', endpoint: fixture.endpoint }]));
  const connection = { id: 'fixture', provider: 'mcp', endpoint: fixture.endpoint, secret: 'fixture-secret' };
  try {
    const [tool] = await adapter.discover(connection);
    const cancelled = new AbortController(); cancelled.abort();
    await assert.rejects(adapter.invoke(connection, tool, { q: 'x' }, { invocationId: 'cancelled', signal: cancelled.signal }));
    assert.equal(fixture.calls, 0);
    fixture.oversize();
    await assert.rejects(adapter.invoke(connection, tool, { q: 'x' }, { invocationId: 'huge' }), /TOOL_PROVIDER_UNKNOWN|TOOL_OUTPUT_LIMIT/u);
    assert.equal(fixture.calls, 1);
  } finally { await fixture.close(); }
});
