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
