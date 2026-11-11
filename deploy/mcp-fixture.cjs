// Synthetic acceptance server. Enabled only by the isolated acceptance override.
const { createServer } = require('node:http');
let version = 1, calls = 0;
const methods = [];
createServer(async (request, response) => {
  const send = (status, value) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
  if (request.url === '/health') return send(200, { status: 'ok', synthetic: true });
  if (request.headers.authorization !== 'Bearer fixture-secret') return send(401, { error: 'FIXTURE_AUTH_REQUIRED' });
  if (request.url === '/fixture/stats') return send(200, { calls, methods, version });
  if (request.method === 'POST' && request.url === '/fixture/change') return send(200, { version: ++version });
  if (request.method !== 'POST' || request.url !== '/mcp') return send(405, {});
  const parts = []; let bytes = 0;
  for await (const part of request) { bytes += part.length; if (bytes > 64_000) return send(413, {}); parts.push(part); }
  let message;
  try { message = JSON.parse(Buffer.concat(parts)); } catch { return send(400, {}); }
  methods.push(message.method);
  if (!('id' in message)) return send(202, {});
  let result;
  if (message.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'Squabble synthetic MCP', version: '1' } };
  else if (message.method === 'tools/list') result = { tools: [{ name: 'fixture_echo', description: `Synthetic read-only echo v${version}`,
    inputSchema: { type: 'object', properties: { q: { type: 'string', maxLength: 100 } }, required: ['q'], additionalProperties: false }, annotations: { readOnlyHint: true } }] };
  else if (message.method === 'tools/call' && message.params?.name === 'fixture_echo') {
    calls++; result = { content: [{ type: 'text', text: `Synthetic result: ${message.params.arguments.q}` }] };
  } else return send(200, { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Fixture method unavailable' } });
  return send(200, { jsonrpc: '2.0', id: message.id, result });
}).listen(8084, '0.0.0.0');
