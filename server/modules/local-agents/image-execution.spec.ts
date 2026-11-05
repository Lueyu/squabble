import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LocalAgentsService } from './local-agents.service';
import { LocalAgentStore } from './local-agents.store';
import { parseCompanionPoll, providerCatalog } from './local-agents.requests';
import type { NativeAgentImage } from '../../../shared/native-image.interface';

const image: NativeAgentImage = { mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOBsAAAAASUVORK5CYII=' };
const ready = [{ ...providerCatalog.codex, state: 'ready' as const, imageInput: true }];
async function fixture(run: (store: LocalAgentStore, root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'squabble-image-store-'));
  try { await run(new LocalAgentStore(root), root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test('image tasks retain an owner-bound transient attachment without serializing bytes', async () => fixture(async (store, root) => {
  await store.connectNative('alice', 'codex');
  const task = await store.stage('alice', 'native-codex', 'codex', 'screenshot', 'Extract image', 'run', undefined, undefined, image);
  assert.equal(task.hasImage, true);
  assert.deepEqual(await store.imageFor('alice', task.id), image);
  await assert.rejects(store.imageFor('bob', task.id), /LOCAL_TASK_NOT_FOUND/);
  const saved = await readFile(join(root, 'tasks', `${task.id}.json`), 'utf8');
  assert.equal(saved.includes(image.data), false);
  assert.equal(JSON.parse(saved).image, undefined);
  await store.cancel('alice', task.id);
  await assert.rejects(store.imageFor('alice', task.id), /LOCAL_INVALID_INPUT/);
  const restarted = new LocalAgentStore(root);
  await assert.rejects(restarted.imageFor('alice', task.id), /LOCAL_INVALID_INPUT/);
}));

test('companion transports image only to its owner and current capable runtime', async () => fixture(async (store, root) => {
  const alice = await store.pair((await store.createPairing('alice')).code, 'Alice');
  const bob = await store.pair((await store.createPairing('bob')).code, 'Bob');
  await store.poll(alice.token, { agents: ready, updates: [] });
  await store.connectCompanion('alice', 'codex');
  const task = await store.stage('alice', 'companion-codex', 'codex', 'screenshot', 'Extract', 'run', undefined, undefined, image);
  await store.activate('alice', task.id);
  assert.deepEqual((await store.poll(bob.token, { agents: ready, updates: [] })).commands, []);
  const commands = (await store.poll(alice.token, { agents: ready, updates: [] })).commands;
  assert.deepEqual(commands[0].image, image);
  assert.equal(commands[0].hasImage, true);
  assert.equal((await readFile(join(root, 'tasks', `${task.id}.json`), 'utf8')).includes(image.data), false);
  await store.update('alice', task.id, { state: 'completed', text: '[]' });
  const next = await store.stage('alice', 'companion-codex', 'codex', 'downgraded', 'Extract', 'run', undefined, undefined, image);
  await store.activate('alice', next.id);
  assert.deepEqual((await store.poll(alice.token, { agents: ready.map(({ imageInput: _imageInput, ...agent }) => agent), updates: [] })).commands, []);
  assert.equal((await store.task('alice', next.id)).error, 'LOCAL_IMAGE_UNSUPPORTED');
}));

test('status parser advertises image support only for verified runtime families', () => {
  assert.equal(parseCompanionPoll({ agents: ready, updates: [] }).agents[0].imageInput, true);
  assert.equal(parseCompanionPoll({ agents: [{ ...providerCatalog.claude, state: 'ready', imageInput: true }], updates: [] }).agents[0].imageInput, false);
});

test('image companion updates cannot persist image bytes as progress, events or results', async () => fixture(async (store, root) => {
  const paired = await store.pair((await store.createPairing('alice')).code, 'Alice');
  await store.poll(paired.token, { agents: ready, updates: [] }); await store.connectCompanion('alice', 'codex');
  const task = await store.stage('alice', 'companion-codex', 'codex', 'image-output', 'Extract', 'run', undefined, undefined, image);
  await store.activate('alice', task.id); await store.poll(paired.token, { agents: ready, updates: [] });
  await store.poll(paired.token, { agents: ready, updates: [{ id: task.id, state: 'running', text: image.data, progress: image.data }] });
  assert.equal((await readFile(join(root, 'tasks', `${task.id}.json`), 'utf8')).includes(image.data), false);
  await store.poll(paired.token, { agents: ready, updates: [{ id: task.id, state: 'completed', text: image.data, progress: image.data,
    events: [{ id: 'unsafe', at: new Date().toISOString(), kind: 'summary', status: 'succeeded', summary: image.data }] }] });
  assert.equal((await store.task('alice', task.id)).error, 'LOCAL_INVALID_RESULT');
  assert.equal((await readFile(join(root, 'tasks', `${task.id}.json`), 'utf8')).includes(image.data), false);
}));

test('native service requires advertised image capability and forwards transient attachment', async () => fixture(async (store, root) => {
  const prior = process.env.SQUABBLE_DESKTOP_ORIGIN;
  process.env.SQUABBLE_DESKTOP_ORIGIN = 'http://127.0.0.1:43199';
  let capable = false; let runs = 0;
  const service = new LocalAgentsService({ detectNativeAgents: async () => [{ ...ready[0], imageInput: capable }],
    openNativeLogin: async () => undefined, runNativeAgent: async (_provider, _prompt, run) => {
      runs++; assert.deepEqual(run.image, image);
      run.onProgress(image.data); run.onEvent?.({ id: 'unsafe', at: new Date().toISOString(), kind: 'summary', status: 'succeeded', summary: image.data });
      return { text: '{"holdings":[]}', usageTokens: null };
    } }, store);
  const options = { agentId: 'native-codex', messageId: 'image', prompt: 'Extract', image,
    onTask: async () => undefined, onProgress: async () => undefined, shouldContinue: async () => true };
  try {
    await service.connect('alice', 'native-codex');
    await assert.rejects(service.execute('alice', options), /LOCAL_IMAGE_UNSUPPORTED/);
    assert.equal(runs, 0); capable = true;
    // A new service models refreshed native capability metadata without timers.
    const capableService = new LocalAgentsService({ detectNativeAgents: async () => ready, openNativeLogin: async () => undefined,
      runNativeAgent: (_provider, _prompt, run) => { runs++; assert.deepEqual(run.image, image); run.onProgress(image.data);
        run.onEvent?.({ id: 'unsafe', at: new Date().toISOString(), kind: 'summary', status: 'succeeded', summary: image.data });
        return Promise.resolve({ text: '{"holdings":[]}', usageTokens: null }); } }, store);
    try {
      assert.equal((await capableService.execute('alice', options)).text, '{"holdings":[]}');
      const task = (await store.findMessage('alice', 'image'))!;
      assert.equal((await readFile(join(root, 'tasks', `${task.id}.json`), 'utf8')).includes(image.data), false);
      await assert.rejects(store.imageFor('alice', task.id), /LOCAL_INVALID_INPUT/);
    } finally { await capableService.onModuleDestroy(); }
  } finally { await service.onModuleDestroy();
    if (prior === undefined) delete process.env.SQUABBLE_DESKTOP_ORIGIN; else process.env.SQUABBLE_DESKTOP_ORIGIN = prior; }
}));

for (const boundary of ['activate', 'takeNative', 'imageFor'] as const) {
  test(`image cancellation during ${boundary} prevents native dispatch and replay`, async () => fixture(async (store) => {
    const prior = process.env.SQUABBLE_DESKTOP_ORIGIN;
    process.env.SQUABBLE_DESKTOP_ORIGIN = 'http://127.0.0.1:43199';
    const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
    const pause = async () => { entered.resolve(); await release.promise; };
    if (boundary === 'activate') { const original = store.activate.bind(store);
      store.activate = async (owner, id) => { await pause(); return original(owner, id); }; }
    if (boundary === 'takeNative') { const original = store.takeNative.bind(store);
      store.takeNative = async (owner, id) => { await pause(); return original(owner, id); }; }
    if (boundary === 'imageFor') { const original = store.imageFor.bind(store);
      store.imageFor = async (owner, id) => { await pause(); return original(owner, id); }; }
    let allowed = true; let runs = 0;
    const service = new LocalAgentsService({ detectNativeAgents: async () => ready, openNativeLogin: async () => undefined,
      runNativeAgent: async () => { runs++; return { text: '[]', usageTokens: null }; } }, store);
    const options = { agentId: 'native-codex', messageId: `cancel-${boundary}`, prompt: 'Extract', image,
      onTask: async () => undefined, onProgress: async () => undefined, shouldContinue: async () => allowed };
    try {
      await service.connect('alice', 'native-codex');
      const execution = service.execute('alice', options);
      const rejected = assert.rejects(execution, /LOCAL_CANCELLED/);
      await entered.promise; allowed = false; release.resolve();
      await rejected;
      assert.equal(runs, 0);
      const task = (await store.findMessage('alice', options.messageId))!;
      assert.equal(task.state, 'cancelled');
      await assert.rejects(store.imageFor('alice', task.id), /LOCAL_INVALID_INPUT/);
      allowed = true;
      await assert.rejects(service.execute('alice', { ...options, remoteTaskId: task.id }), /LOCAL_CANCELLED/);
      assert.equal(runs, 0);
    } finally { release.resolve(); await service.onModuleDestroy();
      if (prior === undefined) delete process.env.SQUABBLE_DESKTOP_ORIGIN; else process.env.SQUABBLE_DESKTOP_ORIGIN = prior; }
  }));
}

test('an aborted queued companion image cannot be dispatched even before execute observes cancellation', async () => fixture(async store => {
  const paired = await store.pair((await store.createPairing('alice')).code, 'Alice');
  await store.poll(paired.token, { agents: ready, updates: [] }); await store.connectCompanion('alice', 'codex');
  const controller = new AbortController();
  const task = await store.stage('alice', 'companion-codex', 'codex', 'queued-cancel', 'Extract', 'run', undefined, undefined, image, controller.signal);
  await store.activate('alice', task.id); controller.abort();
  assert.deepEqual((await store.poll(paired.token, { agents: ready, updates: [] })).commands, []);
  assert.equal((await store.task('alice', task.id)).state, 'cancelled');
  await assert.rejects(store.imageFor('alice', task.id), /LOCAL_INVALID_INPUT/);
}));

test('companion image cancellation during its dispatch journal write removes the unsent command', async () => fixture(async store => {
  const paired = await store.pair((await store.createPairing('alice')).code, 'Alice');
  await store.poll(paired.token, { agents: ready, updates: [] }); await store.connectCompanion('alice', 'codex');
  const controller = new AbortController();
  const task = await store.stage('alice', 'companion-codex', 'codex', 'persist-cancel', 'Extract', 'run', undefined, undefined, image, controller.signal);
  await store.activate('alice', task.id);
  const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
  // Pause the real private writer before committing the claimed dispatch state.
  const writer = store as unknown as { atomic(path: string, value: { id?: string; state?: string }): Promise<void> };
  const atomic = writer.atomic.bind(store);
  writer.atomic = async (path, value) => {
    if (value.id === task.id && value.state === 'running') { entered.resolve(); await release.promise; }
    return atomic(path, value);
  };
  const polling = store.poll(paired.token, { agents: ready, updates: [] });
  try {
    await entered.promise; controller.abort(); release.resolve();
    assert.deepEqual((await polling).commands, []);
    assert.equal((await store.task('alice', task.id)).state, 'cancelled');
  } finally { release.resolve(); await polling; }
}));
