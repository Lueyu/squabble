import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { LocalAgentStore } from './local-agents.store';
import { LocalAgentsService } from './local-agents.service';
import { CompanionController } from './companion.controller';
import { providerCatalog } from './local-agents.requests';
import type { ResearchToolResult } from '../../../shared/research-tools.interface';

function deferred() {
  let resolve!: () => void;
  return { promise: new Promise<void>(done => { resolve = done; }), resolve: () => resolve() };
}
const descriptor = { name: 'get_quotes', description: 'Quote', inputSchema: { type: 'object' },
  annotations: { readOnlyHint: true as const, destructiveHint: false as const, openWorldHint: true } };
const result: ResearchToolResult = { status: 'succeeded', data: { price: 42 }, sources: [],
  asOf: new Date().toISOString(), truncated: false };
const request = { callId: 'cancel-me', name: 'get_quotes', arguments: {} };
async function fixture(tools: object, run: (service: LocalAgentsService, taskId: string, root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'squabble-tool-cancel-'));
  const store = new LocalAgentStore(root);
  const service = new LocalAgentsService({ detectNativeAgents: async () => [], openNativeLogin: async () => undefined,
    runNativeAgent: async () => ({ text: 'unused', usageTokens: null }) }, store, tools as never);
  try {
    await store.connectNative('alice', 'codex');
    const task = await store.stage('alice', 'native-codex', 'codex', randomUUID(), 'Research', 'run', undefined,
      { scope: { sessionId: randomUUID(), revision: 1, memberId: 'analyst', memberName: 'Analyst', turn: 0,
        ticker: 'FIX', language: 'en', webResearch: false, expiresAt: Date.now() + 60_000 },
      bundle: { descriptors: [descriptor], snapshot: '{}' } });
    await store.activate('alice', task.id); await store.takeNative('alice', task.id);
    await run(service, task.id, root);
  } finally {
    await service.onModuleDestroy();
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
    await rm(root, { recursive: true, force: true });
  }
}

test('cancellation persists before a claim and prevents later execution or replay', async () => {
  let calls = 0;
  await fixture({ isCurrent: async () => true, call: async () => { calls++; return result; } }, async (service, taskId, root) => {
    assert.equal(await service.cancelResearchTool('alice', taskId, request.callId), true);
    const saved = JSON.parse(await readFile(join(root, 'tasks', `${taskId}.json`), 'utf8'));
    assert.ok(saved.cancelledToolCallIds.includes(request.callId));
    assert.equal((await service.callResearchTool('alice', taskId, request)).status, 'cancelled');
    assert.equal((await service.callResearchTool('alice', taskId, request)).status, 'cancelled');
    assert.equal(calls, 0);
    await assert.rejects(service.cancelResearchTool('bob', taskId, request.callId), /LOCAL_TASK_NOT_FOUND/);
  });
});

test('explicit cancellation aborts the active signal and blocks follow-up dispatch and false success', async () => {
  const entered = deferred(); const release = deferred(); let received: AbortSignal | undefined; let followups = 0;
  await fixture({ isCurrent: async () => true,
    call: async (_owner: string, _scope: unknown, _request: unknown,
      options: { signal: AbortSignal; shouldContinue: () => Promise<boolean> }) => {
      received = options.signal; entered.resolve(); await release.promise;
      if (await options.shouldContinue()) followups++;
      return result;
    },
  }, async (service, taskId) => {
    assert.equal(typeof service.cancelResearchTool, 'function');
    const pending = service.callResearchTool('alice', taskId, request); await entered.promise;
    await service.cancelResearchTool('alice', taskId, request.callId);
    assert.equal(received?.aborted, true);
    release.resolve(); const cancelled = await pending;
    assert.equal(cancelled.status, 'cancelled'); assert.match(JSON.stringify(cancelled.data), /may.*continu/i);
    assert.equal(followups, 0);
    assert.deepEqual(await service.callResearchTool('alice', taskId, request), cancelled);
    const task = await service.store.task('alice', taskId);
    assert.equal(task.state, 'running');
    assert.equal(task.events?.filter(event => event.callId === request.callId).at(-1)?.status, 'cancelled');
    assert.ok(!task.events?.some(event => event.callId === request.callId && event.status === 'succeeded'));
  }).finally(() => release.resolve());
});

test('a persisted cancel wins the finish race but cannot rewrite a previously completed call', async () => {
  await fixture({}, async (service, taskId) => {
    await service.store.beginToolCall('alice', taskId, request);
    await service.cancelResearchTool('alice', taskId, request.callId);
    assert.equal((await service.store.finishToolCall('alice', taskId, request.callId, result)).status, 'cancelled');
    const completed = { ...request, callId: 'already-completed' };
    await service.store.beginToolCall('alice', taskId, completed);
    await service.store.finishToolCall('alice', taskId, completed.callId, result);
    assert.equal(await service.cancelResearchTool('alice', taskId, completed.callId), false);
    assert.deepEqual((await service.store.beginToolCall('alice', taskId, completed)).result, result);
  });
});

test('the cancel endpoint authenticates the assigned live companion and validates the call ID', async () => {
  await fixture({}, async (service) => {
    const prior = process.env.SQUABBLE_DESKTOP_ORIGIN; const priorMode = process.env.LOCAL_AGENTS_MODE;
    delete process.env.SQUABBLE_DESKTOP_ORIGIN; process.env.LOCAL_AGENTS_MODE = 'companion';
    try {
      const pairing = await service.store.pair((await service.store.createPairing('alice')).code, 'Fixture');
      await service.store.poll(pairing.token, { agents: [{ ...providerCatalog.codex, state: 'ready' }], updates: [] });
      await service.store.connectCompanion('alice', 'codex');
      const scope = { sessionId: randomUUID(), revision: 1, memberId: 'analyst', memberName: 'Analyst', turn: 0,
        ticker: 'FIX', language: 'en' as const, webResearch: false, expiresAt: Date.now() + 60_000 };
      const task = await service.store.stage('alice', 'companion-codex', 'codex', randomUUID(), 'Research', 'run', undefined,
        { scope, bundle: { descriptors: [descriptor], snapshot: '{}' } });
      await service.store.activate('alice', task.id);
      await service.store.poll(pairing.token, { agents: [{ ...providerCatalog.codex, state: 'ready' }], updates: [] });
      const controller = new CompanionController(service);
      await assert.rejects(controller.cancelResearchTool(undefined, { taskId: task.id, callId: request.callId }));
      await assert.rejects(controller.cancelResearchTool(`Bearer ${pairing.token}`, { taskId: task.id, callId: '../invalid' }));
      assert.deepEqual(await controller.cancelResearchTool(`Bearer ${pairing.token}`, { taskId: task.id, callId: request.callId }), { cancelled: true });
      assert.equal((await service.store.beginToolCall('alice', task.id, request)).result?.status, 'cancelled');
    } finally {
      if (prior === undefined) delete process.env.SQUABBLE_DESKTOP_ORIGIN; else process.env.SQUABBLE_DESKTOP_ORIGIN = prior;
      if (priorMode === undefined) delete process.env.LOCAL_AGENTS_MODE; else process.env.LOCAL_AGENTS_MODE = priorMode;
    }
  });
});
