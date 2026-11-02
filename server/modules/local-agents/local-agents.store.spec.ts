import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalAgentStore } from './local-agents.store';

const ready = [{ provider: 'codex' as const, state: 'ready' as const, name: 'Codex', loginCommand: 'codex login', installUrl: 'https://developers.openai.com/codex/cli/' }];
async function fixture(run: (store: LocalAgentStore, root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'squabble-native-store-'));
  try { await run(new LocalAgentStore(root), root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test('pairing is single-use, expiring, owner-bound, and replaces old tokens', async () => fixture(async (store) => {
  const request = await store.createPairing('alice');
  const attempts = await Promise.allSettled([store.pair(request.code, 'Laptop'), store.pair(request.code, 'Other')]);
  assert.equal(attempts.filter((item) => item.status === 'fulfilled').length, 1);
  const paired = attempts.find((item) => item.status === 'fulfilled');
  assert.ok(paired?.status === 'fulfilled');
  await store.poll(paired.value.token, { agents: ready, updates: [] });
  assert.equal((await store.deviceFor('alice'))?.name, 'Laptop');
  assert.equal(await store.deviceFor('bob'), undefined);
  const replacement = await store.pair((await store.createPairing('alice')).code, 'New laptop');
  await assert.rejects(store.poll(paired.value.token, { agents: ready, updates: [] }), /LOCAL_COMPANION_UNAUTHORIZED/);
  await store.poll(replacement.token, { agents: ready, updates: [] });
  await store.revoke('alice');
  await assert.rejects(store.poll(replacement.token, { agents: ready, updates: [] }), /LOCAL_COMPANION_UNAUTHORIZED/);
  const expired = await store.createPairing('bob', 0);
  await assert.rejects(store.pair(expired.code, 'Too late'), /LOCAL_PAIRING_EXPIRED/);
}));

test('native connection ownership cannot be claimed or released by another account', async () => fixture(async (store) => {
  await store.connectNative('alice', 'codex');
  await assert.rejects(store.connectNative('bob', 'codex'), /LOCAL_AGENT_OWNED/);
  await assert.rejects(store.disconnectNative('bob', 'codex'), /LOCAL_AGENT_OWNED/);
  assert.deepEqual(await store.nativeProviders('bob'), []);
  assert.deepEqual(await store.nativeProviders('alice'), ['codex']);
}));

test('an older companion never receives login commands for providers it cannot recognize', async () => fixture(async (store) => {
  const paired = await store.pair((await store.createPairing('alice')).code, 'Older companion');
  await store.poll(paired.token, { agents: ready, updates: [] });
  await assert.rejects(store.stage('alice', 'companion-gemini', 'gemini', 'login-gemini', '', 'login'), /LOCAL_VERSION_UNSUPPORTED/);
  assert.equal(await store.findMessage('alice', 'login-gemini'), undefined);
  assert.deepEqual((await store.poll(paired.token, { agents: ready, updates: [] })).commands, []);
  const login = await store.stage('alice', 'companion-codex', 'codex', 'login-codex', '', 'login');
  await store.activate('alice', login.id);
  assert.equal((await store.poll(paired.token, { agents: ready, updates: [] })).commands[0].provider, 'codex');
  await store.poll(paired.token, { agents: [...ready, { ...ready[0], provider: 'gemini' }], updates: [] });
  const newer = await store.stage('alice', 'companion-gemini', 'gemini', 'login-newer', '', 'login');
  await store.activate('alice', newer.id);
  assert.deepEqual((await store.poll(paired.token, { agents: ready, updates: [] })).commands, []);
  assert.equal((await store.task('alice', newer.id)).error, 'LOCAL_VERSION_UNSUPPORTED');
}));

test('companion work dispatches once, results are idempotent, and task IDs cannot cross owners', async () => fixture(async (store) => {
  const paired = await store.pair((await store.createPairing('alice')).code, 'Laptop');
  await store.poll(paired.token, { agents: ready, updates: [] });
  await store.connectCompanion('alice', 'codex');
  const task = await store.stage('alice', 'companion-codex', 'codex', 'message-1', 'Research prompt');
  assert.equal((await store.poll(paired.token, { agents: ready, updates: [] })).commands.length, 0);
  await store.activate('alice', task.id);
  const first = await store.poll(paired.token, { agents: ready, updates: [] });
  assert.equal(first.commands[0].id, task.id);
  assert.equal((await store.poll(paired.token, { agents: ready, updates: [] })).commands.length, 0);
  await assert.rejects(store.task('bob', task.id), /LOCAL_TASK_NOT_FOUND/);
  await assert.rejects(store.cancel('bob', task.id), /LOCAL_TASK_NOT_FOUND/);
  const update = { id: task.id, state: 'completed' as const, text: 'Report', usageTokens: 42 };
  await store.poll(paired.token, { agents: ready, updates: [update] });
  await store.poll(paired.token, { agents: ready, updates: [{ ...update, text: 'Duplicate replacement' }] });
  assert.equal((await store.task('alice', task.id)).text, 'Report');
  assert.equal((await store.findMessage('alice', 'message-1'))?.id, task.id);
}));

test('companion commands carry durable model settings and reject a capability downgrade', async () => fixture(async (store, root) => {
  const paired = await store.pair((await store.createPairing('alice')).code, 'Laptop');
  const agents = [{ ...ready[0], models: [], reasoningEfforts: ['low', 'high'] }];
  await store.poll(paired.token, { agents, updates: [] });
  await store.connectCompanion('alice', 'codex');
  const settings = { model: 'fixture/model', reasoningEffort: 'high' };
  const task = await store.stage('alice', 'companion-codex', 'codex', 'configured', 'Research', 'run', settings);
  settings.model = 'mutated';
  await store.activate('alice', task.id);
  const first = await store.poll(paired.token, { agents, updates: [] });
  assert.deepEqual(first.commands[0].agentSettings, { model: 'fixture/model', reasoningEffort: 'high' });
  await store.poll(paired.token, { agents, updates: [{ id: task.id, state: 'completed', text: 'Report' }] });
  assert.deepEqual((await new LocalAgentStore(root).task('alice', task.id)).agentSettings, first.commands[0].agentSettings);
  const queued = await store.stage('alice', 'companion-codex', 'codex', 'downgraded', 'Research', 'run', { model: 'fixture/model' });
  await store.activate('alice', queued.id);
  assert.deepEqual((await store.poll(paired.token, { agents: ready, updates: [] })).commands, []);
  assert.equal((await store.task('alice', queued.id)).error, 'LOCAL_CONFIGURATION_UNSUPPORTED');
}));

test('companion cancellation awaits acknowledgment and preserves an uncertain upstream stop', async () => fixture(async (store) => {
  const paired = await store.pair((await store.createPairing('alice')).code, 'Laptop');
  await store.poll(paired.token, { agents: ready, updates: [] });
  await store.connectCompanion('alice', 'codex');
  const task = await store.stage('alice', 'companion-codex', 'codex', 'cancel-message', 'Research');
  await store.activate('alice', task.id);
  await store.poll(paired.token, { agents: ready, updates: [] });
  await store.cancel('alice', task.id);
  assert.equal((await store.task('alice', task.id)).state, 'cancelling');
  assert.equal(await store.busy('alice', 'companion-codex'), true);
  const poll = await store.poll(paired.token, { agents: ready, updates: [] });
  assert.ok(poll.cancelTaskIds.includes(task.id));
  await store.poll(paired.token, { agents: ready, updates: [{ id: task.id, state: 'failed', error: 'LOCAL_DISPATCH_UNCERTAIN' }] });
  assert.equal((await store.task('alice', task.id)).state, 'failed');
  assert.equal((await store.task('alice', task.id)).error, 'LOCAL_DISPATCH_UNCERTAIN');
  assert.equal((await store.stage('alice', 'companion-codex', 'codex', 'cancel-message', 'Research')).id, task.id);
}));

test('restart preserves reports and interrupts work without replay', async () => fixture(async (store, root) => {
  await store.connectNative('alice', 'codex');
  const task = await store.stage('alice', 'native-codex', 'codex', 'message-1', 'Prompt');
  await store.activate('alice', task.id);
  await store.takeNative('alice', task.id);
  const resumed = new LocalAgentStore(root);
  assert.equal((await resumed.task('alice', task.id)).state, 'failed');
  assert.equal((await resumed.task('alice', task.id)).error, 'LOCAL_INTERRUPTED');
  assert.equal(await resumed.takeNative('alice', task.id), false);
}));

test('a late native uncertainty report enriches interruption without reviving terminal tasks', async () => fixture(async (store) => {
  await store.connectNative('alice', 'doubao');
  const task = await store.stage('alice', 'native-doubao', 'doubao', 'native-timeout', 'Prompt');
  await store.activate('alice', task.id); await store.takeNative('alice', task.id);
  await store.update('alice', task.id, { state: 'failed', error: 'LOCAL_INTERRUPTED' });
  await store.update('alice', task.id, { state: 'completed', text: 'Late report' });
  assert.equal((await store.task('alice', task.id)).error, 'LOCAL_INTERRUPTED');
  await store.update('alice', task.id, { state: 'failed', error: 'LOCAL_DISPATCH_UNCERTAIN', text: 'Do not persist' });
  const uncertain = await store.task('alice', task.id);
  assert.equal(uncertain.state, 'failed'); assert.equal(uncertain.error, 'LOCAL_DISPATCH_UNCERTAIN');
  assert.equal(uncertain.text, undefined);
  assert.equal(await store.takeNative('alice', task.id), false);
  await store.update('alice', task.id, { state: 'completed', text: 'Replacement' });
  assert.deepEqual(await store.task('alice', task.id), uncertain);
}));

test('a late companion uncertainty report enriches only its own interrupted task', async () => fixture(async (store) => {
  const paired = await store.pair((await store.createPairing('alice')).code, 'Laptop');
  await store.poll(paired.token, { agents: ready, updates: [] });
  await store.connectCompanion('alice', 'codex');
  const task = await store.stage('alice', 'companion-codex', 'codex', 'companion-timeout', 'Prompt');
  await store.activate('alice', task.id); await store.poll(paired.token, { agents: ready, updates: [] });
  await store.update('alice', task.id, { state: 'failed', error: 'LOCAL_INTERRUPTED' });
  await store.poll(paired.token, { agents: ready, updates: [{ id: task.id, state: 'completed', text: 'Late report' }] });
  assert.equal((await store.task('alice', task.id)).error, 'LOCAL_INTERRUPTED');
  await store.poll(paired.token, { agents: ready, updates: [{ id: task.id, state: 'failed', error: 'LOCAL_DISPATCH_UNCERTAIN', text: 'Do not persist' }] });
  assert.equal((await store.task('alice', task.id)).error, 'LOCAL_DISPATCH_UNCERTAIN');
  assert.equal((await store.task('alice', task.id)).text, undefined);
  assert.equal((await store.stage('alice', 'companion-codex', 'codex', 'companion-timeout', 'Prompt')).id, task.id);
}));

test('disconnect cancels provider jobs and revokes queued dispatch', async () => fixture(async (store) => {
  const paired = await store.pair((await store.createPairing('alice')).code, 'Laptop');
  await store.poll(paired.token, { agents: ready, updates: [] });
  await store.connectCompanion('alice', 'codex');
  const task = await store.stage('alice', 'companion-codex', 'codex', 'message-1', 'Prompt');
  await store.activate('alice', task.id);
  await store.disconnectCompanion('alice', 'codex');
  const poll = await store.poll(paired.token, { agents: ready, updates: [] });
  assert.equal(poll.commands.length, 0);
  assert.ok(poll.cancelTaskIds.includes(task.id));
}));

test('companion cancellation payload stays bounded after a long task history', async () => fixture(async (store, root) => {
  const paired = await store.pair((await store.createPairing('alice')).code, 'Laptop');
  await store.poll(paired.token, { agents: ready, updates: [] });
  await store.connectCompanion('alice', 'codex');
  const template = await store.stage('alice', 'companion-codex', 'codex', 'message-1', 'Prompt');
  await store.cancel('alice', template.id);
  const now = Date.now();
  const oldId = randomUUID();
  const recentIds = Array.from({ length: 1001 }, () => randomUUID());
  await Promise.all([oldId, ...recentIds].map((id) => writeFile(join(root, 'tasks', `${id}.json`), JSON.stringify({
    ...template, id, messageId: id, state: 'cancelled', updatedAt: id === oldId ? now - 700_000 : now,
  }))));
  const restarted = new LocalAgentStore(root);
  const poll = await restarted.poll(paired.token, { agents: ready, updates: [] });
  assert.equal(poll.commands.length, 0);
  assert.equal(poll.cancelTaskIds.length, 1000);
  assert.equal(new Set(poll.cancelTaskIds).size, 1000);
  assert.ok(!poll.cancelTaskIds.includes(oldId));
}));
