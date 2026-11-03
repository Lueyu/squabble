import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { test } from 'node:test';
import { LocalAgentCompanion, type NativeRuntime } from './companion.mts';
import { LocalAgentStore } from '../server/modules/local-agents/local-agents.store';
import { pairRequest, parseCompanionPoll, providerCatalog, researchToolRequest, researchToolCancelRequest } from '../server/modules/local-agents/local-agents.requests';
import { validOutput } from '../server/modules/research-tools/research-tools.registry';
import { researchFailure } from './research-protocol.mts';
import type { ResearchActivity } from '../shared/research-events.interface';
import type { ResearchToolBundle, ResearchToolResult } from '../shared/research-tools.interface';

const bundle: ResearchToolBundle = { descriptors: [{ name: 'get_quotes', description: 'A sourced quote',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true } }], snapshot: 'Dated fixture context' };
const toolResult: ResearchToolResult = { status: 'succeeded', data: { price: 123 }, sources: [],
  asOf: '2026-11-01T00:00:00.000Z', truncated: false };
type Options = Parameters<NativeRuntime['runNativeAgent']>[2];
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function event(index: number): ResearchActivity {
  return { id: `fixture:${index}`, kind: 'summary', status: 'running', at: new Date().toISOString(), summary: `Public activity ${index}` };
}

async function fixture(run: NativeRuntime['runNativeAgent']) {
  const directory = await mkdtemp(join(tmpdir(), 'squabble-companion-research-'));
  const store = new LocalAgentStore(join(directory, 'broker'));
  const owner = 'research-owner';
  const sessionId = randomUUID();
  const polls: ReturnType<typeof parseCompanionPoll>[] = [];
  const toolCalls: { taskId: string; owner: string; deviceId?: string; authorization?: string }[] = [];
  const toolCancellations: { taskId: string; callId: string }[] = [];
  let toolHandler: ((request: IncomingMessage, response: ServerResponse) => Promise<void>) | undefined;
  let pollHandler: ((response: ServerResponse, result: object) => Promise<void>) | undefined;
  let deliveredBundle: unknown = undefined;
  const failures: unknown[] = [];
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString());
      response.setHeader('Content-Type', 'application/json');
      const token = request.headers.authorization?.slice(7) ?? '';
      if (request.url?.endsWith('/pair')) {
        const input = pairRequest.parse(body);
        response.end(JSON.stringify(await store.pair(input.code, input.name)));
      } else if (request.url?.endsWith('/poll')) {
        const input = parseCompanionPoll(body); polls.push(input);
        const result = await store.poll(token, input);
        if (deliveredBundle !== undefined) for (const command of result.commands) Object.assign(command, { researchTools: deliveredBundle });
        if (pollHandler) await pollHandler(response, result);
        else response.end(JSON.stringify(result));
      } else if (request.url?.endsWith('/research-tools/cancel')) {
        const input = researchToolCancelRequest.parse(body);
        const task = await store.companionTask(token, input.taskId);
        toolCancellations.push(input);
        response.end(JSON.stringify({ cancelled: await store.cancelToolCall(task.owner, task.id, input.callId) }));
      } else if (request.url?.endsWith('/research-tools')) {
        const input = researchToolRequest.parse(body);
        const task = await store.companionTask(token, input.taskId);
        toolCalls.push({ taskId: task.id, owner: task.owner, deviceId: task.deviceId, authorization: request.headers.authorization });
        if (toolHandler) await toolHandler(request, response);
        else response.end(JSON.stringify(toolResult));
      } else { response.writeHead(404); response.end('{}'); }
    } catch (error) { failures.push(error); response.writeHead(401); response.end('{}'); }
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const helper = new LocalAgentCompanion({ dataDir: join(directory, 'desktop'), name: 'Research fixture',
    native: { detectNativeAgents: async () => [{ ...providerCatalog.codex, state: 'ready',
      researchTools: { mode: 'mcp', reason: 'supported' } }], openNativeLogin: async () => undefined, runNativeAgent: run } });
  const pairing = await store.createPairing(owner);
  await helper.pair(`squabble://pair?origin=${encodeURIComponent(origin)}&code=${pairing.code}`, async () => true);
  await helper.pollOnce(); await helper.pollOnce();
  await store.connectCompanion(owner, 'codex');
  return { helper, store, owner, sessionId, origin, polls, toolCalls, toolCancellations, failures,
    setToolHandler: (handler: typeof toolHandler) => { toolHandler = handler; },
    setPollHandler: (handler: typeof pollHandler) => { pollHandler = handler; },
    setBundle: (value: unknown) => { deliveredBundle = value; },
    stage: async () => {
      const task = await store.stage(owner, 'companion-codex', 'codex', randomUUID(), 'Fixture research', 'run', undefined,
        { scope: { sessionId, revision: 1, memberId: 'fixture-member', memberName: 'Fixture analyst', turn: 1,
          ticker: 'FIX', language: 'en', webResearch: false, expiresAt: Date.now() + 60_000 }, bundle });
      await store.activate(owner, task.id); return task;
    },
    close: async () => {
      await helper.stop(); server.closeAllConnections();
      await new Promise<void>(done => server.close(() => done()));
      assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
      await rm(directory, { recursive: true, force: true });
    } };
}

test('companion failure results satisfy the same output schema published by the MCP registry', () => {
  for (const status of ['unavailable', 'failed', 'cancelled'] as const) {
    assert.ok(validOutput(researchFailure(status, 'RESEARCH_TRANSPORT_UNAVAILABLE')));
  }
});

test('per-call cancellation crosses HTTP and prevents dispatch even when it arrives before the call claim', async () => {
  const started = deferred<Options>(); const finish = deferred<{ text: string; usageTokens: null }>();
  const requested = deferred<void>(); const release = deferred<void>(); const handled = deferred<void>();
  const f = await fixture(async (_provider, _prompt, options) => { started.resolve(options); return finish.promise; });
  let dispatches = 0;
  try {
    const task = await f.stage(); await f.helper.pollOnce(); const options = await started.promise;
    const request = { callId: 'cancel-one', name: 'get_quotes', arguments: {} };
    f.setToolHandler(async (_incoming, response) => {
      requested.resolve(); await release.promise;
      const claim = await f.store.beginToolCall(f.owner, task.id, request);
      if (claim.run) dispatches++;
      response.end(JSON.stringify(claim.result ?? toolResult)); handled.resolve();
    });
    const cancel = new AbortController();
    const pending = options.researchTools!.call(request, cancel.signal);
    await requested.promise; cancel.abort();
    const result = await pending;
    assert.equal(result.status, 'cancelled'); assert.ok(validOutput(result));
    assert.match(JSON.stringify(result.data), /may.*continu/i);
    assert.deepEqual(f.toolCancellations, [{ taskId: task.id, callId: request.callId }]);
    assert.equal(options.signal.aborted, false, 'the parent task stays live');
    release.resolve(); await handled.promise;
    assert.equal(dispatches, 0, 'a cancelled call must never dispatch later');
    assert.equal((await f.store.beginToolCall(f.owner, task.id, request)).result?.status, 'cancelled');
  } finally { release.resolve(); finish.resolve({ text: 'Done', usageTokens: null }); await f.close(); }
});

test('a lost HTTP tool response does not send a cancellation and remains replayable under the same call ID', async () => {
  const started = deferred<Options>(); const finish = deferred<{ text: string; usageTokens: null }>();
  const f = await fixture(async (_provider, _prompt, options) => { started.resolve(options); return finish.promise; });
  let dispatches = 0;
  try {
    const task = await f.stage(); await f.helper.pollOnce(); const options = await started.promise;
    const request = { callId: 'lost-response', name: 'get_quotes', arguments: {} };
    f.setToolHandler(async (_incoming, response) => {
      const claim = await f.store.beginToolCall(f.owner, task.id, request);
      if (claim.run) {
        dispatches++; await f.store.finishToolCall(f.owner, task.id, request.callId, toolResult);
        response.destroy();
      } else response.end(JSON.stringify(claim.result));
    });
    assert.equal((await options.researchTools!.call(request, options.signal)).status, 'unavailable');
    assert.deepEqual(await options.researchTools!.call(request, options.signal), toolResult);
    assert.equal(dispatches, 1); assert.equal(f.toolCancellations.length, 0);
  } finally { finish.resolve({ text: 'Done', usageTokens: null }); await f.close(); }
});

test('research proxy passes a task-bound callback and capability through the real broker protocol', async () => {
  const started = deferred<Options>(); const finish = deferred<{ text: string; usageTokens: null }>();
  const f = await fixture(async (_provider, _prompt, options) => { started.resolve(options); return finish.promise; });
  try {
    const task = await f.stage(); await f.helper.pollOnce(); const options = await started.promise;
    assert.ok(options.researchTools, 'native runtime must receive a research tool callback');
    assert.deepEqual(options.researchTools.descriptors, bundle.descriptors);
    assert.equal(options.researchTools.snapshot, bundle.snapshot);
    assert.deepEqual(await options.researchTools.call({ callId: 'c'.repeat(128), name: 'get_quotes', arguments: {} }, options.signal), toolResult);
    assert.equal(f.toolCalls[0].taskId, task.id); assert.equal(f.toolCalls[0].owner, f.owner);
    assert.equal(f.toolCalls[0].deviceId, (await f.store.deviceFor(f.owner))?.id);
    const serialized = JSON.stringify(options);
    assert.ok(!serialized.includes(f.toolCalls[0].authorization!.slice(7)));
    assert.ok(!serialized.includes(f.origin));
    assert.deepEqual((await f.store.deviceFor(f.owner))?.agents[0].researchTools, { mode: 'mcp', reason: 'supported' });
    finish.resolve({ text: 'Done', usageTokens: null }); await new Promise<void>(done => setImmediate(done));
    await f.helper.pollOnce(); assert.equal((await f.store.task(f.owner, task.id)).state, 'completed');
    assert.deepEqual(f.failures, []);
  } finally { finish.resolve({ text: 'Done', usageTokens: null }); await f.close(); }
});

test('event snapshots retry without loss or duplication and terminal delivery waits for older batches', async () => {
  const started = deferred<Options>(); const finish = deferred<{ text: string; usageTokens: null }>();
  const f = await fixture(async (_provider, _prompt, options) => { started.resolve(options); return finish.promise; });
  try {
    const task = await f.stage(); await f.helper.pollOnce(); const options = await started.promise;
    assert.ok(options.onEvent, 'native activity must have a transport callback');
    for (let index = 0; index < 70; index++) options.onEvent(event(index));
    options.onProgress('Latest progress replaces earlier progress only');
    let lost = true;
    f.setPollHandler(async (response, result) => {
      if (lost) { lost = false; response.destroy(); } else response.end(JSON.stringify(result));
    });
    await f.helper.pollOnce(); assert.equal(f.helper.status.state, 'offline');
    const gate = deferred<void>(); const inFlight = deferred<void>();
    f.setPollHandler(async (response, result) => { inFlight.resolve(); await gate.promise; response.end(JSON.stringify(result)); });
    const polling = f.helper.pollOnce(); await inFlight.promise;
    options.onEvent(event(70)); options.onProgress('Progress during the poll');
    finish.resolve({ text: 'Complete report', usageTokens: null }); await new Promise<void>(done => setImmediate(done));
    gate.resolve(); await polling; f.setPollHandler(undefined);
    await f.helper.pollOnce();
    assert.equal((await f.store.task(f.owner, task.id)).state, 'running');
    await f.helper.pollOnce(); await f.helper.pollOnce();
    const records = (await f.store.eventsForSession(f.owner, f.sessionId)).events.filter(item => item.id.startsWith('fixture:'));
    assert.deepEqual(records.map(item => item.id), Array.from({ length: 71 }, (_, index) => `fixture:${index}`));
    assert.equal((await f.store.task(f.owner, task.id)).state, 'completed');
    const updates = f.polls.flatMap(poll => poll.updates).filter(update => update.id === task.id);
    assert.ok(updates.every(update => (update.events?.length ?? 0) <= 32));
    assert.deepEqual(updates[0].events, updates[1].events, 'lost response must retry the same stable event IDs');
    assert.deepEqual(f.failures, []);
  } finally { finish.resolve({ text: 'Done', usageTokens: null }); await f.close(); }
});

test('malformed research bundles never reach the native runtime', async () => {
  const malformed = [
    { ...bundle, url: 'https://attacker.invalid/tools', token: 'secret' },
    { ...bundle, descriptors: [{ ...bundle.descriptors[0], command: 'arbitrary shell' }] },
    { ...bundle, descriptors: [{ ...bundle.descriptors[0], name: '../shell' }] },
    { ...bundle, descriptors: [{ ...bundle.descriptors[0], annotations: { readOnlyHint: false, destructiveHint: true } }] },
    { ...bundle, descriptors: [{ ...bundle.descriptors[0], inputSchema: { $ref: 'https://attacker.invalid/schema' } }] },
    { ...bundle, descriptors: [bundle.descriptors[0], bundle.descriptors[0]] },
    { ...bundle, snapshot: 'x'.repeat(64_001) },
  ];
  for (const value of malformed) {
    let runs = 0;
    const f = await fixture(async () => { runs++; return { text: 'Should not run', usageTokens: null }; });
    try {
      f.setBundle(value); await f.stage(); await f.helper.pollOnce();
      assert.equal(runs, 0, 'untrusted bundle must be rejected');
      assert.equal(f.helper.status.state, 'offline');
    } finally { await f.close(); }
  }
});

test('proxy rejects redirects, malformed and oversized responses without leaking credentials', async () => {
  const started = deferred<Options>(); const finish = deferred<{ text: string; usageTokens: null }>();
  const f = await fixture(async (_provider, _prompt, options) => { started.resolve(options); return finish.promise; });
  try {
    await f.stage(); await f.helper.pollOnce(); const options = await started.promise;
    assert.ok(options.researchTools);
    const call = () => options.researchTools!.call({ callId: randomUUID(), name: 'get_quotes', arguments: {} }, options.signal);
    f.setToolHandler(async (request, response) => {
      response.writeHead(302, { location: `${f.origin}/redirect-target?token=${request.headers.authorization}` }); response.end();
    });
    assert.equal((await call()).status, 'unavailable');
    f.setToolHandler(async (request, response) => { response.end(JSON.stringify({ error: request.headers.authorization })); });
    const malformed = await call(); assert.equal(malformed.status, 'unavailable');
    assert.ok(!JSON.stringify(malformed).includes(f.toolCalls[0].authorization!.slice(7)));
    f.setToolHandler(async (_request, response) => { response.end(JSON.stringify({ ...toolResult, data: 'x'.repeat(100_000) })); });
    assert.equal((await call()).status, 'unavailable');
    f.setToolHandler(async (request, response) => { response.end(JSON.stringify({ ...toolResult, data: request.headers.authorization })); });
    assert.equal((await call()).status, 'unavailable');
    const calls = f.toolCalls.length;
    assert.equal((await options.researchTools.call({ callId: 'unknown', name: 'arbitrary_command', arguments: {} }, options.signal)).status, 'failed');
    assert.equal((await options.researchTools.call({ callId: 'large', name: 'get_quotes', arguments: { query: 'x'.repeat(5000) } }, options.signal)).status, 'failed');
    assert.equal(f.toolCalls.length, calls);
  } finally { finish.resolve({ text: 'Done', usageTokens: null }); await f.close(); }
});

test('poll cancellation aborts an outstanding HTTP tool request without blocking the heartbeat', async () => {
  const started = deferred<Options>(); const requested = deferred<void>();
  const f = await fixture(async (_provider, _prompt, options) => {
    started.resolve(options);
    if (!options.researchTools) return { text: 'No tools', usageTokens: null };
    const result = await options.researchTools.call({ callId: 'pending', name: 'get_quotes', arguments: {} }, options.signal);
    assert.equal(result.status, 'cancelled'); return { text: 'Cancelled', usageTokens: null };
  });
  try {
    f.setToolHandler(async () => { requested.resolve(); });
    const task = await f.stage(); await f.helper.pollOnce(); const options = await started.promise;
    assert.ok(options.researchTools);
    await requested.promise; await f.store.cancel(f.owner, task.id);
    await f.helper.pollOnce(); assert.equal(options.signal.aborted, true);
    for (let index = 0; index < 5 && f.helper.status.activeTasks; index++) {
      await new Promise<void>(done => setTimeout(done, 10)); await f.helper.pollOnce();
    }
    assert.equal(f.helper.status.activeTasks, 0);
    await f.helper.pollOnce(); assert.equal((await f.store.task(f.owner, task.id)).state, 'cancelled');
  } finally { await f.close(); }
});

test('bounded event buffering reports truncation explicitly and still converges to terminal', async () => {
  const started = deferred<Options>(); const finish = deferred<{ text: string; usageTokens: null }>();
  const f = await fixture(async (_provider, _prompt, options) => { started.resolve(options); return finish.promise; });
  try {
    const task = await f.stage(); await f.helper.pollOnce(); const options = await started.promise;
    assert.ok(options.onEvent);
    for (let index = 0; index < 1000; index++) options.onEvent(event(index));
    finish.resolve({ text: 'Complete', usageTokens: null }); await new Promise<void>(done => setImmediate(done));
    for (let index = 0; index < 12; index++) await f.helper.pollOnce();
    const activities = f.polls.flatMap(poll => poll.updates).flatMap(update => update.events ?? []);
    assert.ok(activities.length <= 256);
    assert.ok(activities.some(item => /omitted|truncat/i.test(item.summary)), 'the public activity stream must expose omitted events');
    assert.equal((await f.store.task(f.owner, task.id)).state, 'completed');
  } finally { finish.resolve({ text: 'Done', usageTokens: null }); await f.close(); }
});
