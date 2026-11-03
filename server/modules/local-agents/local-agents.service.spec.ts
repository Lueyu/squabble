import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LocalAgentsService } from './local-agents.service';
import { LocalAgentStore } from './local-agents.store';
import { parseCompanionPoll, providerFromId, providerCatalog, validateNativeAgentConfiguration } from './local-agents.requests';
import { nativeFailureCode, type LocalAgentExecution } from './local-agents.types';
import { LOCAL_AGENT_PROVIDERS } from '../../../shared/local-agents.interface';

const options = (messageId = 'message-1'): LocalAgentExecution => ({ agentId: 'native-codex', messageId, prompt: 'Public research',
  onTask: async () => undefined, onProgress: async () => undefined, shouldContinue: async () => true });

for (const kind of ['USAGE_LIMIT', 'RATE_LIMIT']) test(`native ${kind} persists and resuming does not charge for a second run`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'squabble-native-limit-'));
  const priorMode = process.env.LOCAL_AGENTS_MODE; const priorHost = process.env.SERVER_HOST;
  process.env.LOCAL_AGENTS_MODE = 'native'; process.env.SERVER_HOST = '127.0.0.1';
  let executions = 0;
  const service = new LocalAgentsService({
    detectNativeAgents: async () => [{ ...providerCatalog.codex, state: 'ready' }], openNativeLogin: async () => undefined,
    runNativeAgent: async () => { executions++; throw new Error(`NATIVE_AGENT_${kind}`); },
  }, new LocalAgentStore(directory));
  try {
    await service.connect('alice', 'native-codex');
    await assert.rejects(service.execute('alice', options()), { message: `LOCAL_${kind}` });
    const task = await service.store.findMessage('alice', 'message-1');
    assert.equal(task?.state, 'failed'); assert.equal(task?.error, `LOCAL_${kind}`);
    await assert.rejects(service.execute('alice', { ...options(), remoteTaskId: task!.id }), { message: `LOCAL_${kind}` });
    assert.equal(executions, 1);
  } finally {
    await service.onModuleDestroy();
    if (priorMode === undefined) delete process.env.LOCAL_AGENTS_MODE; else process.env.LOCAL_AGENTS_MODE = priorMode;
    if (priorHost === undefined) delete process.env.SERVER_HOST; else process.env.SERVER_HOST = priorHost;
    await rm(directory, { recursive: true, force: true });
  }
});

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
    await assert.rejects(service.execute('alice', { ...options(), shouldContinue: async () => false }), /LOCAL_PAUSED/);
    assert.equal(aborted, true);
    await service.onModuleDestroy();
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

test('native sign-in failures retain an exact public code through the companion protocol', () => {
  assert.equal(nativeFailureCode(new Error('NATIVE_AGENT_LOGIN_REQUIRED')), 'LOCAL_LOGIN_REQUIRED');
  const id = '5c5b47c2-4e9a-4f4e-bb17-a206e877ff13';
  assert.equal(parseCompanionPoll({ agents: [], updates: [{ id, state: 'failed', error: 'LOCAL_LOGIN_REQUIRED' }] }).updates[0].error,
    'LOCAL_LOGIN_REQUIRED');
  assert.throws(() => parseCompanionPoll({ agents: [], updates: [{ id, state: 'failed', error: 'private diagnostic' }] }));
});

test('native usage and rate limits retain safe public codes through companion validation', () => {
  for (const kind of ['USAGE_LIMIT', 'RATE_LIMIT']) {
    const code = `LOCAL_${kind}`;
    assert.equal(nativeFailureCode(new Error(`NATIVE_AGENT_${kind}`)), code);
    assert.equal(parseCompanionPoll({ agents: [], updates: [{ id: '5c5b47c2-4e9a-4f4e-bb17-a206e877ff13',
      state: 'failed', error: code }] }).updates[0].error, code);
  }
  assert.equal(nativeFailureCode(new Error('private-token: insufficient_quota')), 'LOCAL_TASK_FAILED');
});

test('all seven providers retain bounded capabilities through companion status', () => {
  const agents = LOCAL_AGENT_PROVIDERS.map((provider) => ({ ...providerCatalog[provider], state: 'ready',
    models: [{ id: 'fixture/model', name: 'Fixture model', reasoningEfforts: ['low', 'high'] }],
    reasoningEfforts: ['high'], configurationHelp: 'Choose a local model' }));
  const parsed = parseCompanionPoll({ agents, updates: [] });
  assert.equal(parsed.agents.length, 7);
  for (const agent of parsed.agents) {
    assert.equal(providerFromId(`native-${agent.provider}`, 'native'), agent.provider);
    assert.equal(providerFromId(`companion-${agent.provider}`, 'companion'), agent.provider);
    assert.deepEqual(agent.models, agents[0].models);
    assert.deepEqual(agent.reasoningEfforts, ['high']);
  }
  assert.equal(parseCompanionPoll({ agents: [{ provider: 'codex', state: 'ready' }], updates: [] }).agents[0].models, undefined);
  for (const change of [{ models: [{ id: 'x'.repeat(161), name: 'bad' }] },
    { reasoningEfforts: ['bad\nvalue'] }, { models: [{ id: 'same', name: 'A' }, { id: 'same', name: 'B' }] }]) {
    assert.throws(() => parseCompanionPoll({ agents: [{ provider: 'codex', state: 'ready', ...change }], updates: [] }));
  }
});

test('model-specific reasoning capabilities take precedence over provider defaults', () => {
  const status = { ...providerCatalog.codex, state: 'ready' as const, reasoningEfforts: ['high'],
    models: [{ id: 'basic', name: 'Basic', reasoningEfforts: [] },
      { id: 'reasoner', name: 'Reasoner', reasoningEfforts: ['low'] }] };
  assert.deepEqual(validateNativeAgentConfiguration({ model: 'manual/model', reasoningEffort: 'high' }, status),
    { model: 'manual/model', reasoningEffort: 'high' });
  assert.deepEqual(validateNativeAgentConfiguration({ model: 'reasoner', reasoningEffort: 'low' }, status),
    { model: 'reasoner', reasoningEffort: 'low' });
  for (const model of ['basic', 'reasoner']) {
    assert.throws(() => validateNativeAgentConfiguration({ model, reasoningEffort: 'high' }, status), /LOCAL_CONFIGURATION_UNSUPPORTED/);
  }
});

test('native execution validates capabilities and snapshots settings before dispatch', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'squabble-native-settings-'));
  const prior = process.env.SQUABBLE_DESKTOP_ORIGIN;
  process.env.SQUABBLE_DESKTOP_ORIGIN = 'http://127.0.0.1:43199';
  const settings = { model: 'fixture/model', reasoningEffort: 'high' };
  let executions = 0;
  const service = new LocalAgentsService({
    detectNativeAgents: async () => [{ ...providerCatalog.codex, state: 'ready', models: [], reasoningEfforts: ['low', 'high'] }],
    openNativeLogin: async () => undefined,
    runNativeAgent: async (_provider, _prompt, run) => {
      executions++;
      assert.deepEqual(run.agentSettings, settings);
      return { text: 'Research report', usageTokens: null };
    },
  }, new LocalAgentStore(directory));
  try {
    assert.equal((await service.status('alice')).items.length, 7);
    await service.connect('alice', 'native-codex');
    for (const agentSettings of [{ model: 'bad\nmodel' }, { reasoningEffort: 'unsupported' }, { model: 'x'.repeat(161) }]) {
      await assert.rejects(service.execute('alice', { ...options(), agentSettings }), /LOCAL_.*CONFIGURATION/);
      assert.equal(await service.store.findMessage('alice', 'message-1'), undefined);
    }
    let taskId = '';
    await service.execute('alice', { ...options(), agentSettings: settings, onTask: async (ref) => {
      taskId = ref.taskId;
      assert.deepEqual((await service.store.task('alice', taskId)).agentSettings, settings);
    } });
    await service.execute('alice', { ...options(), remoteTaskId: taskId, agentSettings: { model: 'changed' } });
    assert.equal(executions, 1);
    assert.deepEqual((await new LocalAgentStore(directory).task('alice', taskId)).agentSettings, settings);
  } finally {
    await service.onModuleDestroy();
    if (prior === undefined) delete process.env.SQUABBLE_DESKTOP_ORIGIN; else process.env.SQUABBLE_DESKTOP_ORIGIN = prior;
    await rm(directory, { recursive: true, force: true });
  }
});

test('older companion statuses permit defaults but reject model and reasoning overrides', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'squabble-companion-settings-'));
  const priorOrigin = process.env.SQUABBLE_DESKTOP_ORIGIN;
  const priorMode = process.env.LOCAL_AGENTS_MODE;
  delete process.env.SQUABBLE_DESKTOP_ORIGIN; process.env.LOCAL_AGENTS_MODE = 'companion';
  const service = new LocalAgentsService(undefined, new LocalAgentStore(directory));
  try {
    const paired = await service.store.pair((await service.pairing('alice')).code, 'Old companion');
    await service.store.poll(paired.token, { agents: [{ ...providerCatalog.codex, state: 'ready' }], updates: [] });
    await service.connect('alice', 'companion-codex');
    await service.validate('alice', 'companion-codex');
    for (const agentSettings of [{ model: 'fixture' }, { reasoningEffort: 'high' }]) {
      await assert.rejects(service.execute('alice', { ...options(), agentId: 'companion-codex', agentSettings,
        shouldContinue: async () => false }), /LOCAL_CONFIGURATION_UNSUPPORTED/);
      assert.equal(await service.store.findMessage('alice', 'message-1'), undefined);
    }
  } finally {
    await service.onModuleDestroy();
    if (priorOrigin === undefined) delete process.env.SQUABBLE_DESKTOP_ORIGIN; else process.env.SQUABBLE_DESKTOP_ORIGIN = priorOrigin;
    if (priorMode === undefined) delete process.env.LOCAL_AGENTS_MODE; else process.env.LOCAL_AGENTS_MODE = priorMode;
    await rm(directory, { recursive: true, force: true });
  }
});

test('a companion dispatch racing a pause retains its reference until cancellation is confirmed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'squabble-companion-cancel-race-'));
  const priorOrigin = process.env.SQUABBLE_DESKTOP_ORIGIN;
  const priorMode = process.env.LOCAL_AGENTS_MODE;
  delete process.env.SQUABBLE_DESKTOP_ORIGIN; process.env.LOCAL_AGENTS_MODE = 'companion';
  const service = new LocalAgentsService(undefined, new LocalAgentStore(directory));
  try {
    const paired = await service.store.pair((await service.pairing('alice')).code, 'Companion');
    const agents = [{ ...providerCatalog.codex, state: 'ready' as const }];
    await service.store.poll(paired.token, { agents, updates: [] });
    await service.connect('alice', 'companion-codex');
    await assert.rejects(service.execute('alice', { ...options(), agentId: 'companion-codex', shouldContinue: async () => {
      assert.equal((await service.store.poll(paired.token, { agents, updates: [] })).commands.length, 1);
      return false;
    } }), /LOCAL_PAUSED/);
    assert.equal((await service.store.findMessage('alice', 'message-1'))?.state, 'cancelling');
  } finally {
    await service.onModuleDestroy();
    if (priorOrigin === undefined) delete process.env.SQUABBLE_DESKTOP_ORIGIN; else process.env.SQUABBLE_DESKTOP_ORIGIN = priorOrigin;
    if (priorMode === undefined) delete process.env.LOCAL_AGENTS_MODE; else process.env.LOCAL_AGENTS_MODE = priorMode;
    await rm(directory, { recursive: true, force: true });
  }
});

test('a companion completion racing changed steering discards the finished reference', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'squabble-companion-completion-race-'));
  const priorOrigin = process.env.SQUABBLE_DESKTOP_ORIGIN;
  const priorMode = process.env.LOCAL_AGENTS_MODE;
  delete process.env.SQUABBLE_DESKTOP_ORIGIN; process.env.LOCAL_AGENTS_MODE = 'companion';
  const service = new LocalAgentsService(undefined, new LocalAgentStore(directory));
  try {
    const paired = await service.store.pair((await service.pairing('alice')).code, 'Companion');
    const agents = [{ ...providerCatalog.codex, state: 'ready' as const }];
    await service.store.poll(paired.token, { agents, updates: [] });
    await service.connect('alice', 'companion-codex');
    await assert.rejects(service.execute('alice', { ...options(), agentId: 'companion-codex', shouldContinue: async () => {
      const [command] = (await service.store.poll(paired.token, { agents, updates: [] })).commands;
      await service.store.poll(paired.token, { agents, updates: [{ id: command.id, state: 'completed', text: 'Superseded report' }] });
      return false;
    } }), /LOCAL_CANCELLED/);
    assert.equal((await service.store.findMessage('alice', 'message-1'))?.state, 'completed');
  } finally {
    await service.onModuleDestroy();
    if (priorOrigin === undefined) delete process.env.SQUABBLE_DESKTOP_ORIGIN; else process.env.SQUABBLE_DESKTOP_ORIGIN = priorOrigin;
    if (priorMode === undefined) delete process.env.LOCAL_AGENTS_MODE; else process.env.LOCAL_AGENTS_MODE = priorMode;
    await rm(directory, { recursive: true, force: true });
  }
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
    await assert.rejects(service.execute('alice', { ...options(), shouldContinue: async () => false }), /LOCAL_PAUSED/);
    await assert.rejects(service.execute('alice', options('second-message')), /LOCAL_BUSY/);
    assert.equal(executions, 1);
  } finally {
    release(); await service.onModuleDestroy();
    if (prior === undefined) delete process.env.SQUABBLE_DESKTOP_ORIGIN; else process.env.SQUABBLE_DESKTOP_ORIGIN = prior;
    await rm(directory, { recursive: true, force: true });
  }
});

test('unconfirmed native cancellation preserves an uncertain task instead of allowing replay', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'squabble-native-uncertain-'));
  const prior = process.env.SQUABBLE_DESKTOP_ORIGIN;
  process.env.SQUABBLE_DESKTOP_ORIGIN = 'http://127.0.0.1:43199';
  let executions = 0;
  const service = new LocalAgentsService({
    detectNativeAgents: async () => [{ ...providerCatalog.doubao, state: 'ready' }], openNativeLogin: async () => undefined,
    runNativeAgent: async (_provider, _prompt, run) => {
      executions++;
      await new Promise<void>((resolve) => run.signal.addEventListener('abort', () => resolve(), { once: true }));
      throw new Error('NATIVE_AGENT_CANCEL_UNCONFIRMED');
    },
  }, new LocalAgentStore(directory));
  try {
    await service.connect('alice', 'native-doubao');
    const request = { ...options(), agentId: 'native-doubao', shouldContinue: async () => false };
    await assert.rejects(service.execute('alice', request), /LOCAL_PAUSED/);
    for (let i = 0; i < 30 && (await service.store.findMessage('alice', 'message-1'))?.state !== 'failed'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await assert.rejects(service.execute('alice', request), /LOCAL_DISPATCH_UNCERTAIN/);
    assert.equal(executions, 1);
  } finally {
    await service.onModuleDestroy();
    if (prior === undefined) delete process.env.SQUABBLE_DESKTOP_ORIGIN; else process.env.SQUABBLE_DESKTOP_ORIGIN = prior;
    await rm(directory, { recursive: true, force: true });
  }
});
