import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LocalAgentsService } from './local-agents.service';
import { LocalAgentStore } from './local-agents.store';
import { parseCompanionPoll, providerFromId, providerCatalog } from './local-agents.requests';
import type { LocalAgentExecution } from './local-agents.types';

const options = (messageId = 'message-1'): LocalAgentExecution => ({ agentId: 'native-codex', messageId, prompt: 'Public research',
  onTask: async () => undefined, onProgress: async () => undefined, shouldContinue: async () => true });

test('native service claims per-account execution, persists before dispatch, and resumes without rerunning', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'squabble-native-service-'));
  const priorMode = process.env.LOCAL_AGENTS_MODE; const priorHost = process.env.SERVER_HOST;
  process.env.LOCAL_AGENTS_MODE = 'native'; process.env.SERVER_HOST = '127.0.0.1';
  let executions = 0;
  const service = new LocalAgentsService({
    detectNativeAgents: async () => [{ ...providerCatalog.codex, state: 'ready' }],
    openNativeLogin: async () => undefined,
    runNativeAgent: async (_provider, _prompt, run) => {
      executions++; run.onProgress('Searching public sources');
      return { text: 'Research report', usageTokens: null };
    },
  }, new LocalAgentStore(directory));
  try {
    assert.equal((await service.status('alice')).items[0].connected, false);
    await service.connect('alice', 'native-codex');
    await assert.rejects(service.connect('bob', 'native-codex'), /LOCAL_AGENT_OWNED/);
    await assert.rejects(service.execute('bob', options()), /LOCAL_AGENT_NOT_FOUND/);
    let taskId = '';
    const result = await service.execute('alice', { ...options(), onTask: async (ref) => { taskId = ref.taskId;
      assert.equal((await service.store.task('alice', taskId)).state, 'staged'); },
      onDispatch: async () => assert.ok(taskId, 'task identity must be checkpointed before paid execution'),
    });
    assert.equal(result.text, 'Research report'); assert.equal(result.usageTokens, null);
    assert.equal((await service.execute('alice', { ...options(), remoteTaskId: taskId })).text, result.text);
    assert.equal(executions, 1);
    await assert.rejects(service.execute('bob', { ...options(), remoteTaskId: taskId }), /LOCAL_TASK_NOT_FOUND/);
    await service.disconnect('alice', 'native-codex');
    assert.equal((await service.list('alice')).length, 0);
  } finally {
    await service.onModuleDestroy();
    if (priorMode === undefined) delete process.env.LOCAL_AGENTS_MODE; else process.env.LOCAL_AGENTS_MODE = priorMode;
    if (priorHost === undefined) delete process.env.SERVER_HOST; else process.env.SERVER_HOST = priorHost;
    await rm(directory, { recursive: true, force: true });
  }
});

test('pausing native research cancels the runtime and never returns its late report', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'squabble-native-cancel-'));
  const prior = process.env.SQUABBLE_DESKTOP_ORIGIN;
  process.env.SQUABBLE_DESKTOP_ORIGIN = 'http://127.0.0.1:43199';
  let aborted = false;
  const service = new LocalAgentsService({
    detectNativeAgents: async () => [{ ...providerCatalog.codex, state: 'ready' }], openNativeLogin: async () => undefined,
    runNativeAgent: async (_provider, _prompt, run) => new Promise((resolve) => {
      run.signal.addEventListener('abort', () => { aborted = true; resolve({ text: 'Late report', usageTokens: 1 }); }, { once: true });
    }),
  }, new LocalAgentStore(directory));
  try {
    await service.connect('alice', 'native-codex');
    await assert.rejects(service.execute('alice', { ...options(), shouldContinue: async () => false }), /LOCAL_CANCELLED/);
    assert.equal(aborted, true);
    assert.equal((await service.store.findMessage('alice', 'message-1'))?.state, 'cancelled');
  } finally {
    await service.onModuleDestroy();
    if (prior === undefined) delete process.env.SQUABBLE_DESKTOP_ORIGIN; else process.env.SQUABBLE_DESKTOP_ORIGIN = prior;
    await rm(directory, { recursive: true, force: true });
  }
});

test('companion input cannot inject paths, catalog links, invalid usage or oversized output', () => {
  const parsed = parseCompanionPoll({ agents: [{ ...providerCatalog.codex, state: 'ready', installUrl: 'https://evil.example' }], updates: [] });
  assert.equal(parsed.agents[0].installUrl, providerCatalog.codex.installUrl);
  assert.throws(() => parseCompanionPoll({ agents: [{ ...providerCatalog.codex, state: 'ready' }, { ...providerCatalog.codex, state: 'ready' }], updates: [] }));
  assert.throws(() => parseCompanionPoll({ agents: [], updates: [{ id: '5c5b47c2-4e9a-4f4e-bb17-a206e877ff13', state: 'completed', text: 'x'.repeat(512_001) }] }));
  assert.throws(() => parseCompanionPoll({ agents: [], updates: [{ id: '5c5b47c2-4e9a-4f4e-bb17-a206e877ff13', state: 'completed', text: '研'.repeat(200_000) }] }));
  assert.throws(() => parseCompanionPoll({ agents: [], updates: [{ id: '5c5b47c2-4e9a-4f4e-bb17-a206e877ff13', state: 'completed', text: 'report', usageTokens: -1 }] }));
  for (const id of ['http://localhost:1234', 'codex;whoami', '../codex', 'companion-codex']) assert.throws(() => providerFromId(id, 'native'));
});

test('a cancelling native process keeps its provider slot until the process actually exits', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'squabble-native-draining-'));
  const prior = process.env.SQUABBLE_DESKTOP_ORIGIN;
  process.env.SQUABBLE_DESKTOP_ORIGIN = 'http://127.0.0.1:43199';
  let release: () => void = () => undefined;
  let executions = 0;
  const service = new LocalAgentsService({
    detectNativeAgents: async () => [{ ...providerCatalog.codex, state: 'ready' }], openNativeLogin: async () => undefined,
    runNativeAgent: async () => {
      executions++;
      if (executions === 1) await new Promise<void>((resolve) => { release = resolve; });
      return { text: 'Research result', usageTokens: null };
    },
  }, new LocalAgentStore(directory));
  try {
    await service.connect('alice', 'native-codex');
    await assert.rejects(service.execute('alice', { ...options(), shouldContinue: async () => false }), /LOCAL_CANCELLED/);
    await assert.rejects(service.execute('alice', options('second-message')), /LOCAL_BUSY/);
    assert.equal(executions, 1);
  } finally {
    release(); await service.onModuleDestroy();
    if (prior === undefined) delete process.env.SQUABBLE_DESKTOP_ORIGIN; else process.env.SQUABBLE_DESKTOP_ORIGIN = prior;
    await rm(directory, { recursive: true, force: true });
  }
});
