import assert from 'node:assert/strict';
import { test } from 'node:test';
import { request } from 'node:http';
import type { ResearchToolBundle, ResearchToolResult } from '../../shared/research-tools.interface';
import { createResearchToolBridge } from './tool-bridge';
import { researchToolCapability, researchSnapshotPrompt } from './tool-config';

const bundle: ResearchToolBundle = { snapshot: 'Quote as of 2026-11-03: 42', descriptors: [{
  name: 'squabble_quote', description: 'Read a quote', inputSchema: { type: 'object' },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
}] };
const result: ResearchToolResult = { status: 'succeeded', data: { price: 42 }, sources: [], asOf: '2026-11-03', truncated: false };

function rpc(url: string, token: string, body: unknown, headers: Record<string, string> = {}): Promise<{status: number; body: Record<string, unknown>}> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers } }, res => {
      let text: string = ''; res.setEncoding('utf8'); res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode!, body: text ? JSON.parse(text) : {} }));
    });
    req.on('error', reject); req.end(JSON.stringify(body));
  });
}
const message = (method: string, params: unknown = {}, id: number = 1) => ({ jsonrpc: '2.0', id, method, params });

test('MCP bridge performs initialize, list and full tool invocation on authenticated loopback only', async () => {
  const calls: unknown[] = [];
  const bridge = await createResearchToolBridge({ ...bundle, call: async (value) => { calls.push(value); return result; } }, new AbortController().signal);
  try {
    assert.match(bridge.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/u);
    assert.ok(bridge.token.length >= 40);
    assert.equal((await rpc(bridge.url, 'wrong', message('tools/list'))).status, 401);
    assert.equal((await rpc(bridge.url, bridge.token, message('tools/list'), { host: 'attacker.invalid' })).status, 403);
    assert.equal((await rpc(bridge.url, bridge.token, message('tools/list'), { origin: 'https://attacker.invalid' })).status, 403);
    const init = await rpc(bridge.url, bridge.token, message('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } }));
    assert.equal(init.status, 200); assert.equal((init.body.result as Record<string, unknown>).protocolVersion, '2025-03-26');
    const listed = await rpc(bridge.url, bridge.token, message('tools/list'));
    assert.deepEqual((listed.body.result as Record<string, unknown>).tools, bundle.descriptors);
    const called = await rpc(bridge.url, bridge.token, message('tools/call', { name: 'squabble_quote', arguments: { ticker: 'TEST' } }, 3));
    assert.deepEqual((called.body.result as Record<string, unknown>).structuredContent, result);
    assert.equal(JSON.parse(((called.body.result as { content: { text: string }[] }).content[0]).text).data.price, 42);
    assert.equal(calls.length, 1);
    assert.deepEqual((calls[0] as { arguments: unknown }).arguments, { ticker: 'TEST' });
    const denied = await rpc(bridge.url, bridge.token, message('tools/call', { name: 'shell', arguments: {} }));
    assert.equal((denied.body.error as Record<string, unknown>).code, -32602);
    assert.equal(calls.length, 1);
  } finally { await bridge.close(); }
  await assert.rejects(rpc(bridge.url, bridge.token, message('tools/list')));
});

test('MCP bridge bounds requests and suppresses callback errors', async () => {
  const bridge = await createResearchToolBridge({ ...bundle, call: async () => { throw new Error('PRIVATE_SECRET'); } }, new AbortController().signal);
  try {
    assert.equal((await rpc(bridge.url, bridge.token, message('tools/list', { padding: 'x'.repeat(70_000) }))).status, 413);
    const failed = await rpc(bridge.url, bridge.token, message('tools/call', { name: 'squabble_quote', arguments: {} }));
    assert.equal(JSON.stringify(failed).includes('PRIVATE_SECRET'), false);
    assert.equal((failed.body.result as Record<string, unknown>).isError, true);
  } finally { await bridge.close(); }
});

test('MCP lost-response retry reuses its call ID and result; changing arguments under the same RPC ID is rejected', async () => {
  let calls: number = 0;
  const bridge = await createResearchToolBridge({ ...bundle, call: async () => { calls++; return result; } }, new AbortController().signal);
  try {
    const first = await rpc(bridge.url, bridge.token, message('tools/call', { name: 'squabble_quote', arguments: { ticker: 'TEST', limit: 2 } }, 7));
    const retry = await rpc(bridge.url, bridge.token, message('tools/call', { name: 'squabble_quote', arguments: { limit: 2, ticker: 'TEST' } }, 7));
    assert.deepEqual(retry, first); assert.equal(calls, 1);
    const changed = await rpc(bridge.url, bridge.token, message('tools/call', { name: 'squabble_quote', arguments: { ticker: 'OTHER' } }, 7));
    assert.equal((changed.body.error as Record<string, unknown>).code, -32602); assert.equal(calls, 1);
  } finally { await bridge.close(); }
});

test('concurrent duplicate RPC requests share the in-flight callback', async () => {
  let calls: number = 0; let finish!: (result: ResearchToolResult) => void;
  let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve; });
  const pending = new Promise<ResearchToolResult>(resolve => { finish = resolve; });
  const bridge = await createResearchToolBridge({ ...bundle, call: async () => {
    calls++; started(); return pending;
  } }, new AbortController().signal);
  try {
    const first = rpc(bridge.url, bridge.token, message('tools/call', { name: 'squabble_quote', arguments: {} }, 9));
    await ready;
    const retry = rpc(bridge.url, bridge.token, message('tools/call', { name: 'squabble_quote', arguments: {} }, 9));
    finish(result);
    assert.deepEqual(await first, await retry); assert.equal(calls, 1);
  } finally { await bridge.close(); }
});

test('a dropped HTTP connection does not repeat the tool on a retry', async () => {
  let calls: number = 0; let finish!: (result: ResearchToolResult) => void;
  let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve; });
  const pending = new Promise<ResearchToolResult>(resolve => { finish = resolve; });
  const bridge = await createResearchToolBridge({ ...bundle, call: async () => { calls++; started(); return pending; } }, new AbortController().signal);
  try {
    const payload = message('tools/call', { name: 'squabble_quote', arguments: {} }, 17);
    const lost = request(bridge.url, { method: 'POST', headers: { authorization: `Bearer ${bridge.token}`, 'content-type': 'application/json' } });
    lost.on('error', () => undefined); lost.end(JSON.stringify(payload));
    await ready; lost.destroy();
    const retried = rpc(bridge.url, bridge.token, payload);
    finish(result);
    assert.deepEqual(((await retried).body.result as Record<string, unknown>).structuredContent, result);
    assert.equal(calls, 1);
  } finally { await bridge.close(); }
});

test('MCP cancellation notification cancels and caches exactly the targeted tool request', async () => {
  let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve; });
  let signal: AbortSignal | undefined; let calls: number = 0;
  const bridge = await createResearchToolBridge({ ...bundle, call: async (_value, incoming) => {
    calls++; signal = incoming; started(); return new Promise<ResearchToolResult>(() => undefined);
  } }, new AbortController().signal);
  try {
    const payload = message('tools/call', { name: 'squabble_quote', arguments: {} }, 18);
    const pending = rpc(bridge.url, bridge.token, payload);
    await ready;
    assert.equal((await rpc(bridge.url, bridge.token, { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 18 } })).status, 202);
    const cancelled = await pending;
    assert.equal(((cancelled.body.result as Record<string, unknown>).structuredContent as ResearchToolResult).status, 'cancelled');
    assert.match(JSON.stringify(((cancelled.body.result as Record<string, unknown>).structuredContent as ResearchToolResult).data), /may.*continu/i);
    assert.equal(signal?.aborted, true);
    assert.deepEqual(await rpc(bridge.url, bridge.token, payload), cancelled); assert.equal(calls, 1);
  } finally { await bridge.close(); }
});

test('MCP cancellation aborts pending callbacks and closes the server without waiting for an ignoring callback', async () => {
  const abort = new AbortController();
  let callSignal: AbortSignal | undefined;
  let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve; });
  const bridge = await createResearchToolBridge({ ...bundle, call: async (_value, signal) => {
    callSignal = signal; started(); return new Promise<ResearchToolResult>(() => undefined);
  } }, abort.signal);
  const pending = rpc(bridge.url, bridge.token, message('tools/call', { name: 'squabble_quote', arguments: {} }));
  void pending.catch(() => undefined);
  await ready; abort.abort(); await bridge.close();
  assert.equal(callSignal?.aborted, true);
  await assert.rejects(rpc(bridge.url, bridge.token, message('tools/list')));
});

test('capability floors and snapshot fallback are explicit for all seven providers', () => {
  assert.deepEqual(researchToolCapability('codex', 'codex-cli 0.104.0'), { mode: 'mcp', reason: 'supported' });
  assert.equal(researchToolCapability('codex', '0.103.9').reason, 'version_unsupported');
  assert.equal(researchToolCapability('claude', '2.1.221 (Claude Code)').mode, 'mcp');
  assert.equal(researchToolCapability('claude', '2.1.220').reason, 'version_unsupported');
  assert.equal(researchToolCapability('codex', undefined).mode, 'snapshot');
  for (const provider of ['gemini', 'antigravity', 'opencode', 'kimi', 'doubao'] as const) {
    assert.deepEqual(researchToolCapability(provider, '999.0.0'), { mode: 'snapshot', reason: 'runtime_unsupported' });
  }
  const prompt: string = researchSnapshotPrompt('Assignment', bundle.snapshot);
  assert.ok(prompt.startsWith('Assignment')); assert.match(prompt, /read-only evidence/iu);
  assert.match(prompt, /\d{4}-\d{2}-\d{2}T/u); assert.ok(prompt.includes('Quote as of'));
  assert.ok(researchSnapshotPrompt('Assignment', 'x'.repeat(100_000)).length < 70_000);
});
