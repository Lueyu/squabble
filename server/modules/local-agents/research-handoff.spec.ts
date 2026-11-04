import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LocalAgentsService } from './local-agents.service';
import { LocalAgentStore } from './local-agents.store';
import { providerCatalog } from './local-agents.requests';

for (const native of [false, true]) test(`${native ? 'native' : 'companion'} abandons pre-entry work when the execution liveness read throws`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'squabble-abandoned-handoff-'));
  const origin = process.env.SQUABBLE_DESKTOP_ORIGIN, mode = process.env.LOCAL_AGENTS_MODE;
  if (native) process.env.SQUABBLE_DESKTOP_ORIGIN = 'http://127.0.0.1:43199';
  else { delete process.env.SQUABBLE_DESKTOP_ORIGIN; process.env.LOCAL_AGENTS_MODE = 'companion'; }
  let release!: () => void, guarded!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const waiting = new Promise<void>(resolve => { guarded = resolve; });
  let runs = 0, receipts = 0, taskId = '';
  const agents = [{ ...providerCatalog.codex, state: 'ready' as const }], store = new LocalAgentStore(directory);
  const service = new LocalAgentsService({ detectNativeAgents: async () => agents, openNativeLogin: async () => {},
    runNativeAgent: async () => { runs++; return { text: 'Must not enter', usageTokens: null }; } }, store,
  { bundle: async () => ({ descriptors: [], snapshot: '' }) } as never);
  try {
    const paired = native ? undefined : await store.pair((await service.pairing('alice')).code, 'Fixture');
    if (paired) await store.poll(paired.token, { agents, updates: [] });
    const agentId = `${native ? 'native' : 'companion'}-codex`;
    await service.connect('alice', agentId);
    await assert.rejects(service.execute('alice', { agentId, messageId: 'abandoned', prompt: 'Fictional review',
      researchScope: { sessionId: 'session', revision: 1, memberId: 'member', memberName: 'Fixture', turn: 0,
        ticker: 'TEST', language: 'en', webResearch: false, expiresAt: Date.now() + 10000, memoryReferences: [] },
      onTask: async ref => { taskId = ref.taskId; }, onProgress: async () => {}, onSubmitted: async () => { receipts++; },
      withHandoff: async emit => { guarded(); await gate; await emit(); },
      shouldContinue: async () => { if (native) await waiting; throw new Error('Transient database disconnect'); },
    }), /Transient database disconnect/);
    release();
    if (paired) assert.equal((await store.poll(paired.token, { agents, updates: [] })).commands.length, 0);
    await service.onModuleDestroy();
    assert.equal(runs, 0); assert.equal(receipts, 0);
    const saved = await store.task('alice', taskId);
    assert.equal(saved.state, 'cancelled'); assert.equal(saved.runtimeEntered, undefined); assert.equal(saved.commandEmitted, undefined);
  } finally {
    release(); await service.onModuleDestroy();
    if (origin === undefined) delete process.env.SQUABBLE_DESKTOP_ORIGIN; else process.env.SQUABBLE_DESKTOP_ORIGIN = origin;
    if (mode === undefined) delete process.env.LOCAL_AGENTS_MODE; else process.env.LOCAL_AGENTS_MODE = mode;
    await rm(directory, { recursive: true, force: true });
  }
});

test('a controlled empty-memory queue fails closed after guard loss while ordinary run and login still dispatch', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'squabble-required-handoff-'));
  const store = new LocalAgentStore(directory), agents = [{ ...providerCatalog.codex, state: 'ready' as const }];
  try {
    const paired = await store.pair((await store.createPairing('alice')).code, 'Fixture');
    await store.poll(paired.token, { agents, updates: [] }); await store.connectCompanion('alice', 'codex');
    const task = await store.stage('alice', 'companion-codex', 'codex', 'controlled', 'Review', 'run', undefined, undefined, true);
    assert.equal(JSON.parse(await readFile(join(directory, 'tasks', `${task.id}.json`), 'utf8')).handoffRequired, true,
      'the guard requirement is durable before activation');
    const remove = store.registerHandoff('alice', task.id, async emit => emit());
    await store.activate('alice', task.id); remove();
    assert.equal((await store.poll(paired.token, { agents, updates: [] })).commands.length, 0);
    assert.equal((await store.task('alice', task.id)).commandEmitted, undefined);
    const prepared = await store.stage('alice', 'companion-codex', 'codex', 'prepared', 'Pinned memory', 'run', undefined,
      { scope: { sessionId: 'session', revision: 1, memberId: 'member', memberName: 'Fixture', turn: 0,
        ticker: 'TEST', language: 'en', webResearch: false, expiresAt: Date.now() + 10000,
        memoryReferences: [{ kind: 'thesis', id: 'pin', version: 1 }] }, bundle: { descriptors: [], snapshot: '' } });
    await store.activate('alice', prepared.id);
    assert.equal((await store.poll(paired.token, { agents, updates: [] })).commands.length, 0);
    assert.equal((await store.task('alice', prepared.id)).error, 'MEMORY_CONTEXT_CHANGED');
    for (const kind of ['run', 'login'] as const) {
      const plain = await store.stage('alice', 'companion-codex', 'codex', kind, 'Fixture', kind);
      await store.activate('alice', plain.id);
      assert.equal((await store.poll(paired.token, { agents, updates: [] })).commands[0]?.id, plain.id);
      await store.poll(paired.token, { agents, updates: [{ id: plain.id, state: 'completed', text: 'Done' }] });
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a companion poll cannot use a captured guard after it is removed during validation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'squabble-captured-handoff-'));
  const store = new LocalAgentStore(directory), agents = [{ ...providerCatalog.codex, state: 'ready' as const }];
  let release!: () => void, guarded!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), waiting = new Promise<void>(resolve => { guarded = resolve; });
  try {
    const paired = await store.pair((await store.createPairing('alice')).code, 'Fixture');
    await store.poll(paired.token, { agents, updates: [] }); await store.connectCompanion('alice', 'codex');
    const task = await store.stage('alice', 'companion-codex', 'codex', 'captured', 'Review', 'run', undefined, undefined, true);
    const remove = store.registerHandoff('alice', task.id, async emit => { guarded(); await gate; await emit(); });
    await store.activate('alice', task.id);
    const poll = store.poll(paired.token, { agents, updates: [] });
    await waiting; remove(); release();
    assert.equal((await poll).commands.length, 0);
    assert.equal((await store.task('alice', task.id)).commandEmitted, undefined);
  } finally { release(); await rm(directory, { recursive: true, force: true }); }
});

for (const native of [false, true]) test(`${native ? 'native' : 'companion'} preserves actual delivery when the liveness read fails after entry`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'squabble-entered-controller-'));
  const origin = process.env.SQUABBLE_DESKTOP_ORIGIN, mode = process.env.LOCAL_AGENTS_MODE;
  if (native) process.env.SQUABBLE_DESKTOP_ORIGIN = 'http://127.0.0.1:43199';
  else { delete process.env.SQUABBLE_DESKTOP_ORIGIN; process.env.LOCAL_AGENTS_MODE = 'companion'; }
  let entered!: () => void, release!: () => void;
  const entry = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  let runs = 0, receipts = 0, taskId = '';
  const agents = [{ ...providerCatalog.codex, state: 'ready' as const }], store = new LocalAgentStore(directory);
  const service = new LocalAgentsService({ detectNativeAgents: async () => agents, openNativeLogin: async () => {},
    runNativeAgent: async (_provider, _prompt, options) => { runs++; entered();
      await new Promise<void>(resolve => options.signal?.addEventListener('abort', () => resolve(), { once: true }));
      return { text: 'Entered before failure', usageTokens: null }; } }, store);
  try {
    const paired = native ? undefined : await store.pair((await service.pairing('alice')).code, 'Fixture');
    if (paired) await store.poll(paired.token, { agents, updates: [] });
    const agentId = `${native ? 'native' : 'companion'}-codex`; await service.connect('alice', agentId);
    const request = { agentId, messageId: 'entered', prompt: 'Fictional review',
      onTask: async (ref: { taskId: string }) => { taskId = ref.taskId; }, onProgress: async () => {},
      onSubmitted: async () => { receipts++; }, withHandoff: async (emit: () => Promise<void>) => { await emit(); if (native) await gate; },
      shouldContinue: async () => {
        if (native) await entry;
        else assert.equal((await store.poll(paired!.token, { agents, updates: [] })).commands.length, 1);
        throw new Error('Transient database disconnect');
      } };
    await assert.rejects(service.execute('alice', request), /LOCAL_DISPATCH_UNCERTAIN/);
    release(); await service.onModuleDestroy();
    assert.equal(receipts, 1); assert.equal(runs, native ? 1 : 0);
    const saved = await store.task('alice', taskId);
    assert.equal(native ? saved.runtimeEntered : saved.commandEmitted, true);
    assert.equal(saved.error, 'LOCAL_DISPATCH_UNCERTAIN');
    if (paired) assert.equal((await store.poll(paired.token, { agents, updates: [] })).commands.length, 0);
  } finally {
    release(); await service.onModuleDestroy();
    if (origin === undefined) delete process.env.SQUABBLE_DESKTOP_ORIGIN; else process.env.SQUABBLE_DESKTOP_ORIGIN = origin;
    if (mode === undefined) delete process.env.LOCAL_AGENTS_MODE; else process.env.LOCAL_AGENTS_MODE = mode;
    await rm(directory, { recursive: true, force: true });
  }
});

for (const unexpected of [true, false]) test(`fast native abort preserves ${unexpected ? 'unexpected post-entry uncertainty' : 'explicit cancellation'} after the handoff returns`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'squabble-fast-abort-'));
  const origin = process.env.SQUABBLE_DESKTOP_ORIGIN; process.env.SQUABBLE_DESKTOP_ORIGIN = 'http://127.0.0.1:43199';
  let submitted!: () => void, handoffReturned = false, runs = 0, receipts = 0, taskId = '';
  const receipt = new Promise<void>(resolve => { submitted = resolve; });
  const store = new LocalAgentStore(directory);
  const service = new LocalAgentsService({ detectNativeAgents: async () => [{ ...providerCatalog.codex, state: 'ready' }],
    openNativeLogin: async () => {}, runNativeAgent: async (_provider, _prompt, options) => {
      runs++; await new Promise<void>(resolve => options.signal?.addEventListener('abort', () => resolve(), { once: true }));
      return { text: 'Already entered', usageTokens: null };
    } }, store);
  try {
    await service.connect('alice', 'native-codex');
    await assert.rejects(service.execute('alice', { agentId: 'native-codex', messageId: 'fast-abort', prompt: 'Fictional review',
      onTask: async ref => { taskId = ref.taskId; }, onProgress: async () => {},
      withHandoff: async emit => { await emit(); handoffReturned = true; },
      onSubmitted: async () => { receipts++; submitted(); }, shouldContinue: async () => {
        await receipt; assert.equal(handoffReturned, true);
        if (unexpected) throw new Error('Transient database disconnect');
        return false;
      } }), unexpected ? /LOCAL_DISPATCH_UNCERTAIN/ : /LOCAL_PAUSED/);
    await service.onModuleDestroy();
    assert.equal(runs, 1); assert.equal(receipts, 1);
    for (const saved of [await store.task('alice', taskId), await new LocalAgentStore(directory).task('alice', taskId)]) {
      assert.equal(saved.runtimeEntered, true);
      assert.equal(saved.state, unexpected ? 'failed' : 'cancelled');
      assert.equal(saved.error, unexpected ? 'LOCAL_DISPATCH_UNCERTAIN' : 'LOCAL_CANCELLED');
    }
  } finally {
    await service.onModuleDestroy();
    if (origin === undefined) delete process.env.SQUABBLE_DESKTOP_ORIGIN; else process.env.SQUABBLE_DESKTOP_ORIGIN = origin;
    await rm(directory, { recursive: true, force: true });
  }
});

for (const native of [false, true]) test(`${native ? 'native runtime' : 'companion command'} revalidates after activation before actual handoff`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'squabble-handoff-'));
  const origin = process.env.SQUABBLE_DESKTOP_ORIGIN, mode = process.env.LOCAL_AGENTS_MODE;
  if (native) process.env.SQUABBLE_DESKTOP_ORIGIN = 'http://127.0.0.1:43199';
  else { delete process.env.SQUABBLE_DESKTOP_ORIGIN; process.env.LOCAL_AGENTS_MODE = 'companion'; }
  const agents = [{ ...providerCatalog.codex, state: 'ready' as const }];
  let live = true, runs = 0, receipts = 0, commands = 0;
  const store = new LocalAgentStore(directory);
  const service = new LocalAgentsService({ detectNativeAgents: async () => agents, openNativeLogin: async () => {},
    runNativeAgent: async () => { runs++; return { text: 'Fictional result', usageTokens: null }; } }, store);
  try {
    const paired = native ? undefined : await store.pair((await service.pairing('alice')).code, 'Fixture');
    if (paired) await store.poll(paired.token, { agents, updates: [] });
    const agentId = `${native ? 'native' : 'companion'}-codex`;
    await service.connect('alice', agentId);
    const take = store.takeNative.bind(store);
    if (native) store.takeNative = async (...args) => { const taken = await take(...args); live = false; return taken; };
    await assert.rejects(service.execute('alice', { agentId, messageId: 'revoked', prompt: 'Fictional pinned version',
      onTask: async () => {}, onProgress: async () => {}, onSubmitted: async () => { receipts++; },
      onDispatch: async () => { if (!live) throw new Error('MEMORY_CONTEXT_CHANGED'); },
      shouldContinue: async () => {
        if (native) return true;
        live = false;
        const poll = await store.poll(paired!.token, { agents, updates: [] });
        commands += poll.commands.length;
        for (const command of poll.commands) await store.poll(paired!.token, { agents,
          updates: [{ id: command.id, state: 'completed', text: 'Old command must not be sent' }] });
        return true;
      } }), /MEMORY_CONTEXT_CHANGED/);
    assert.equal(commands, 0); assert.equal(runs, 0); assert.equal(receipts, 0);
  } finally {
    await service.onModuleDestroy();
    if (origin === undefined) delete process.env.SQUABBLE_DESKTOP_ORIGIN; else process.env.SQUABBLE_DESKTOP_ORIGIN = origin;
    if (mode === undefined) delete process.env.LOCAL_AGENTS_MODE; else process.env.LOCAL_AGENTS_MODE = mode;
    await rm(directory, { recursive: true, force: true });
  }
});

for (const failure of ['handoff', 'receipt']) test(`native ${failure} failure after runtime entry remains uncertain and is never replayed`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'squabble-handoff-fault-'));
  const origin = process.env.SQUABBLE_DESKTOP_ORIGIN;
  process.env.SQUABBLE_DESKTOP_ORIGIN = 'http://127.0.0.1:43199';
  let runs = 0, receipts = 0, taskId = '';
  const service = new LocalAgentsService({ detectNativeAgents: async () => [{ ...providerCatalog.codex, state: 'ready' }],
    openNativeLogin: async () => {}, runNativeAgent: async () => { runs++; return { text: 'Already entered', usageTokens: null }; } },
  new LocalAgentStore(directory));
  const request = { agentId: 'native-codex', messageId: `fault-${failure}`, prompt: 'Fictional memory',
    onTask: async (ref: { taskId: string }) => { taskId = ref.taskId; }, onProgress: async () => {}, shouldContinue: async () => true,
    withHandoff: async (emit: () => Promise<void>) => { await emit(); if (failure === 'handoff') throw new Error('Commit fixture failure'); },
    onSubmitted: async () => { receipts++; if (failure === 'receipt') throw new Error('Receipt fixture failure'); } };
  try {
    await service.connect('alice', 'native-codex');
    await assert.rejects(service.execute('alice', request), /LOCAL_DISPATCH_UNCERTAIN/);
    assert.equal(runs, 1); assert.equal(receipts, 1);
    assert.equal((await service.store.task('alice', taskId)).runtimeEntered, true);
    await assert.rejects(service.execute('alice', { ...request, onSubmitted: async () => {} }), /LOCAL_DISPATCH_UNCERTAIN/);
    assert.equal(runs, 1);
  } finally {
    await service.onModuleDestroy();
    if (origin === undefined) delete process.env.SQUABBLE_DESKTOP_ORIGIN; else process.env.SQUABBLE_DESKTOP_ORIGIN = origin;
    await rm(directory, { recursive: true, force: true });
  }
});

test('queued memory cannot survive restart; emitted companion evidence survives a later handoff failure', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'squabble-handoff-journal-'));
  const agents = [{ ...providerCatalog.codex, state: 'ready' as const }], store = new LocalAgentStore(directory);
  try {
    const paired = await store.pair((await store.createPairing('alice')).code, 'Fixture');
    await store.poll(paired.token, { agents, updates: [] }); await store.connectCompanion('alice', 'codex');
    const task = await store.stage('alice', 'companion-codex', 'codex', 'queued', 'Fictional memory');
    store.registerHandoff('alice', task.id, async emit => emit());
    await store.activate('alice', task.id);
    const restarted = new LocalAgentStore(directory);
    assert.equal((await restarted.poll(paired.token, { agents, updates: [] })).commands.length, 0);
    assert.equal((await restarted.task('alice', task.id)).error, 'LOCAL_INTERRUPTED');
    const emitted = await restarted.stage('alice', 'companion-codex', 'codex', 'emitted', 'Fictional memory');
    restarted.registerHandoff('alice', emitted.id, async emit => { await emit(); throw new Error('Post-emission fixture failure'); });
    await restarted.activate('alice', emitted.id);
    const poll = await restarted.poll(paired.token, { agents, updates: [] });
    assert.equal(poll.commands.length, 1);
    assert.equal((await restarted.task('alice', emitted.id)).commandEmitted, true);
    assert.equal((await restarted.task('alice', emitted.id)).error, 'LOCAL_DISPATCH_UNCERTAIN');
    assert.equal((await restarted.poll(paired.token, { agents, updates: [] })).commands.length, 0);
    await assert.rejects(restarted.task('bob', emitted.id), /LOCAL_TASK_NOT_FOUND/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('resuming a queued prompt cannot replace its prepared memory allowlist with a fresh empty selection', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'squabble-handoff-resume-'));
  const mode = process.env.LOCAL_AGENTS_MODE, origin = process.env.SQUABBLE_DESKTOP_ORIGIN;
  delete process.env.SQUABBLE_DESKTOP_ORIGIN; process.env.LOCAL_AGENTS_MODE = 'companion';
  const service = new LocalAgentsService(undefined, new LocalAgentStore(directory)), store = service.store;
  const agents = [{ ...providerCatalog.codex, state: 'ready' as const }];
  try {
    const paired = await store.pair((await service.pairing('alice')).code, 'Fixture');
    await store.poll(paired.token, { agents, updates: [] }); await service.connect('alice', 'companion-codex');
    const scope = { sessionId: 'session', revision: 1, memberId: 'member', memberName: 'Fixture', turn: 0, ticker: 'TEST',
      language: 'en' as const, webResearch: false, expiresAt: Date.now() + 10000,
      memoryReferences: [{ kind: 'thesis' as const, id: 'pin', version: 1 }] };
    const task = await store.stage('alice', 'companion-codex', 'codex', 'resume', 'Stored old memory', 'run', undefined,
      { scope, bundle: { descriptors: [], snapshot: '' } });
    await store.activate('alice', task.id);
    await assert.rejects(service.execute('alice', { agentId: 'companion-codex', messageId: 'resume', remoteTaskId: task.id,
      prompt: 'Fresh prompt with memory removed', researchScope: { ...scope, memoryReferences: [] },
      onTask: async () => {}, onProgress: async () => {}, shouldContinue: async () => {
        const poll = await store.poll(paired.token, { agents, updates: [] });
        for (const command of poll.commands) await store.poll(paired.token, { agents,
          updates: [{ id: command.id, state: 'completed', text: 'Must not send' }] });
        return true;
      } }), /MEMORY_CONTEXT_CHANGED/);
    assert.equal((await store.task('alice', task.id)).commandEmitted, undefined);
  } finally {
    await service.onModuleDestroy();
    if (origin === undefined) delete process.env.SQUABBLE_DESKTOP_ORIGIN; else process.env.SQUABBLE_DESKTOP_ORIGIN = origin;
    if (mode === undefined) delete process.env.LOCAL_AGENTS_MODE; else process.env.LOCAL_AGENTS_MODE = mode;
    await rm(directory, { recursive: true, force: true });
  }
});
