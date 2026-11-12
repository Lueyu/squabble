import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { ToolTransportPolicy } from '../tool-connections/tool-transport-policy';
import { A2aProtocolAdapter } from './a2a-protocol.adapter';

test('real HTTP A2A v1 discovers card and sends exact v1 nonstreaming JSON-RPC', async () => {
  let origin = '';
  const requests: unknown[] = [];
  const server = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/.well-known/agent-card.json') {
      res.end(JSON.stringify({ name: 'Fixture', version: '1', defaultOutputModes: ['application/json'],
        supportedInterfaces: [{ protocolVersion: '1.0', protocolBinding: 'JSONRPC', url: origin + '/rpc' }], skills: [] }));
      return;
    }
    let body = ''; for await (const chunk of req) body += chunk;
    const rpc = JSON.parse(body); requests.push(rpc);
    assert.equal(req.headers['a2a-version'], '1.0');
    res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { message: {
      messageId: 'result', contextId: 'ctx', role: 'ROLE_AGENT', parts: [{ text: '{"answer":"fixture"}' }],
    } } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  const cardUrl = origin + '/.well-known/agent-card.json', endpoint = origin + '/rpc';
  try {
    const adapter = new A2aProtocolAdapter(new ToolTransportPolicy([{ id: 'card', endpoint: cardUrl }, { id: 'rpc', endpoint }]));
    const card = await adapter.discover(cardUrl);
    assert.equal(card.interfaceUrl, endpoint);
    const result = await adapter.rpc(card.interfaceUrl, 'SendMessage', { message: { messageId: 'client', role: 'ROLE_USER', parts: [{ text: 'fixture' }] }, configuration: { returnImmediately: true, historyLength: 0 } });
    assert.ok(result);
    assert.equal((requests[0] as { method: string }).method, 'SendMessage');
    assert.deepEqual(adapter.output(adapter.unwrap(result), true), { state: 'completed', text: '{"answer":"fixture"}', data: { answer: 'fixture' }, contextId: 'ctx' });
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('profile rejects unsupported versions, cross-origin interfaces and URL artifacts', async () => {
  const adapter = new A2aProtocolAdapter(new ToolTransportPolicy([]));
  assert.throws(() => adapter.parseCard({ name: 'old', version: '1', supportedInterfaces: [{ protocolVersion: '0.3', protocolBinding: 'JSONRPC', url: 'https://example.com/rpc' }] }, 'https://example.com/card'), /A2A_VERSION_UNSUPPORTED/u);
  assert.throws(() => adapter.parseCard({ name: 'bad', version: '1', supportedInterfaces: [{ protocolVersion: '1.0', protocolBinding: 'JSONRPC', url: 'https://different.example/rpc' }] }, 'https://example.com/card'), /A2A_ENDPOINT_RESTRICTED/u);
  assert.throws(() => adapter.output({ task: { id: 't', status: { state: 'TASK_STATE_COMPLETED' }, artifacts: [{ artifactId: 'a', parts: [{ url: 'https://example.com/private' }] }] } }, true), /A2A_INVALID_OUTPUT/u);
});
