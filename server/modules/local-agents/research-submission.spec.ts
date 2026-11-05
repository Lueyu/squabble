import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LocalAgentsService } from './local-agents.service';
import { LocalAgentStore } from './local-agents.store';
import { providerCatalog } from './local-agents.requests';

test('native submission requires runtime entry; cancelled staging and activation failure never claim receipt', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'squabble-submit-native-'));
  const prior = process.env.SQUABBLE_DESKTOP_ORIGIN;
  process.env.SQUABBLE_DESKTOP_ORIGIN = 'http://127.0.0.1:43199';
  let submitted = 0, runs = 0;
  const service = new LocalAgentsService({ detectNativeAgents: async () => [{ ...providerCatalog.codex, state: 'ready' }],
    openNativeLogin: async () => {}, runNativeAgent: async () => { runs++; assert.equal(submitted, 0); return { text: 'Fixture', usageTokens: null }; },
  }, new LocalAgentStore(directory));
  const request = { agentId: 'native-codex', messageId: 'normal', prompt: 'Fixture', onTask: async () => {},
    onProgress: async () => {}, shouldContinue: async () => true, onSubmitted: async (delivery: string) => {
      assert.equal(runs, 1, 'receipt follows actual runtime entry'); assert.equal(delivery, 'runtime'); submitted++; } };
  try {
    await service.connect('alice', 'native-codex');
    await assert.rejects(service.execute('alice', { ...request, messageId: 'cancel-stage',
      onTask: async ref => { await service.store.cancel('alice', ref.taskId); } }), /LOCAL_CANCELLED/);
    assert.equal(submitted, 0); assert.equal(runs, 0);
    const activate = service.store.activate.bind(service.store);
    service.store.activate = async () => { throw new Error('fixture activation failed'); };
    await assert.rejects(service.execute('alice', { ...request, messageId: 'activation-failure' }), /activation failed/);
    service.store.activate = activate;
    assert.equal(submitted, 0); assert.equal(runs, 0);
    await service.execute('alice', request);
    assert.equal(submitted, 1); assert.equal(runs, 1);
  } finally { await service.onModuleDestroy();
    if (prior === undefined) delete process.env.SQUABBLE_DESKTOP_ORIGIN; else process.env.SQUABBLE_DESKTOP_ORIGIN = prior;
    await rm(directory, { recursive: true, force: true }); }
});

test('companion queueing and invalid configuration are not submissions; only an emitted command records delivery', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'squabble-submit-companion-'));
  const prior = process.env.SQUABBLE_DESKTOP_ORIGIN, mode = process.env.LOCAL_AGENTS_MODE;
  delete process.env.SQUABBLE_DESKTOP_ORIGIN; process.env.LOCAL_AGENTS_MODE = 'companion';
  const service = new LocalAgentsService(undefined, new LocalAgentStore(directory));
  const agents = [{ ...providerCatalog.codex, state: 'ready' as const }];
  let submitted = 0;
  try {
    const paired = await service.store.pair((await service.pairing('alice')).code, 'Fixture');
    await service.store.poll(paired.token, { agents, updates: [] }); await service.connect('alice', 'companion-codex');
    const request = { agentId: 'companion-codex', messageId: 'queued', prompt: 'Fixture', onTask: async () => {},
      onProgress: async () => {}, onSubmitted: async (delivery: string) => { assert.equal(delivery, 'companion-command'); submitted++; } };
    await assert.rejects(service.execute('alice', { ...request, shouldContinue: async () => false }), /LOCAL_CANCELLED/);
    assert.equal(submitted, 0);
    await assert.rejects(service.execute('alice', { ...request, messageId: 'config-failed', shouldContinue: async () => {
      await service.store.poll(paired.token, { agents: [], updates: [] }); return true;
    } }), /LOCAL_VERSION_UNSUPPORTED/);
    assert.equal(submitted, 0);
    await service.store.poll(paired.token, { agents, updates: [] });
    await service.execute('alice', { ...request, messageId: 'delivered', shouldContinue: async () => {
      const [command] = (await service.store.poll(paired.token, { agents, updates: [] })).commands;
      assert.equal(submitted, 0, 'queued state is not an Agent receipt');
      await service.store.poll(paired.token, { agents, updates: [{ id: command.id, state: 'completed', text: 'Fixture' }] });
      return true;
    } });
    assert.equal(submitted, 1);
    await assert.rejects(service.execute('alice', { ...request, messageId: 'emitted-before-pause', shouldContinue: async () => {
      assert.equal((await service.store.poll(paired.token, { agents, updates: [] })).commands.length, 1);
      return false;
    } }), /LOCAL_PAUSED/);
    assert.equal(submitted, 2, 'an already-emitted command remains attributed to its original attempt after pause');
  } finally { await service.onModuleDestroy();
    if (prior === undefined) delete process.env.SQUABBLE_DESKTOP_ORIGIN; else process.env.SQUABBLE_DESKTOP_ORIGIN = prior;
    if (mode === undefined) delete process.env.LOCAL_AGENTS_MODE; else process.env.LOCAL_AGENTS_MODE = mode;
    await rm(directory, { recursive: true, force: true }); }
});
