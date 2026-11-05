import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LocalAgentsService } from './local-agents.service';
import { LocalAgentStore } from './local-agents.store';
import { providerCatalog } from './local-agents.requests';
import type { LocalAgentExecution } from './local-agents.types';

const options = (messageId: string): LocalAgentExecution => ({ agentId: 'native-codex', messageId, prompt: 'Workspace research',
  onTask: async () => undefined, onProgress: async () => undefined, shouldContinue: async () => true });

async function fixture(mode: 'local' | 'account', run: (root: string, legacy: LocalAgentStore) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'squabble-local-workspace-agents-'));
  const keys = ['AUTH_MODE', 'LOCAL_AGENTS_MODE', 'LOCAL_AGENTS_DATA_DIR', 'SERVER_HOST', 'SQUABBLE_DESKTOP_ORIGIN'];
  const previous = keys.map(key => process.env[key]);
  process.env.AUTH_MODE = mode; process.env.LOCAL_AGENTS_MODE = 'native';
  process.env.LOCAL_AGENTS_DATA_DIR = root; process.env.SERVER_HOST = '127.0.0.1';
  delete process.env.SQUABBLE_DESKTOP_ORIGIN;
  try { await run(root, new LocalAgentStore(root)); }
  finally {
    keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; });
    await rm(root, { recursive: true, force: true });
  }
}

test('local auth default store reuses legacy providers for workspace login, connection and execution', async () => fixture('local', async (root, legacy) => {
  await legacy.connectNative('alice', 'codex');
  await legacy.connectNative('alice', 'opencode');
  const oldTask = await legacy.stage('alice', 'native-codex', 'codex', 'same-message', 'Private prompt');
  await legacy.update('alice', oldTask.id, { state: 'completed', text: 'Private report' });
  const logins: string[] = [];
  const prompts: string[] = [];
  const service = new LocalAgentsService({
    detectNativeAgents: async () => ['codex', 'opencode', 'gemini'].map(provider => ({ ...providerCatalog[provider], state: 'ready' as const })),
    openNativeLogin: async provider => { logins.push(provider); },
    runNativeAgent: async (_provider, prompt) => { prompts.push(prompt); return { text: 'Workspace report', usageTokens: 0 }; },
  });
  try {
    assert.deepEqual((await service.list('workspace')).map(item => item.provider), ['codex', 'opencode']);
    await service.login('workspace', 'native-codex');
    await service.connect('workspace', 'native-gemini');
    assert.deepEqual(logins, ['codex']);
    assert.equal((await service.execute('workspace', options('same-message'))).text, 'Workspace report');
    assert.deepEqual(prompts, ['Workspace research']);
    const ownTask = await service.store.findMessage('workspace', 'same-message');
    assert.ok(ownTask); assert.notEqual(ownTask.id, oldTask.id);
    await assert.rejects(service.execute('workspace', { ...options('same-message'), remoteTaskId: oldTask.id }), /LOCAL_TASK_NOT_FOUND/);
    await assert.rejects(service.store.task('workspace', oldTask.id), /LOCAL_TASK_NOT_FOUND/);
    assert.equal(JSON.parse(await readFile(join(root, 'connections.json'), 'utf8')).nativeOwner, 'alice');
    const account = new LocalAgentStore(root);
    assert.equal(await account.nativeClaimedByOther('workspace'), true);
    assert.equal((await account.task('alice', oldTask.id)).text, 'Private report');
  } finally { await service.onModuleDestroy(); }
}));

test('account auth default store retains native login and connection ownership', async () => fixture('account', async (_root, legacy) => {
  await legacy.connectNative('alice', 'codex');
  let logins = 0;
  const service = new LocalAgentsService({
    detectNativeAgents: async () => [{ ...providerCatalog.codex, state: 'ready' }],
    openNativeLogin: async () => { logins++; },
    runNativeAgent: async () => { throw new Error('Unexpected execution'); },
  });
  try {
    assert.deepEqual(await service.list('workspace'), []);
    await assert.rejects(service.login('workspace', 'native-codex'), /LOCAL_AGENT_OWNED/);
    await assert.rejects(service.connect('workspace', 'native-codex'), /LOCAL_AGENT_OWNED/);
    await assert.rejects(service.disconnect('workspace', 'native-codex'), /LOCAL_AGENT_OWNED/);
    assert.equal(logins, 0);
  } finally { await service.onModuleDestroy(); }
}));

test('shared native disconnect aborts another owner runtime and holds its slot until exit', async () => fixture('local', async (_root, legacy) => {
  await legacy.connectNative('alice', 'codex');
  let signal: AbortSignal | undefined;
  let release: () => void = () => undefined;
  let markStarted: () => void = () => undefined;
  const started = new Promise<void>(resolve => { markStarted = resolve; });
  const service = new LocalAgentsService({
    detectNativeAgents: async () => [{ ...providerCatalog.codex, state: 'ready' }], openNativeLogin: async () => undefined,
    runNativeAgent: async (_provider, _prompt, run) => {
      signal = run.signal;
      await new Promise<void>(resolve => { release = resolve; markStarted(); });
      return { text: 'Late private report', usageTokens: 0 };
    },
  });
  const pending = service.execute('alice', options('legacy-running'));
  void pending.catch(() => undefined);
  try {
    await Promise.race([started, pending]);
    const task = await service.store.findMessage('alice', 'legacy-running');
    assert.ok(task);
    await service.disconnect('workspace', 'native-codex');
    assert.equal(signal?.aborted, true);
    assert.equal((await service.store.task('alice', task.id)).state, 'cancelling');
    await assert.rejects(service.store.task('workspace', task.id), /LOCAL_TASK_NOT_FOUND/);
    await service.connect('workspace', 'native-codex');
    assert.equal((await service.status('workspace')).items.find(item => item.provider === 'codex')?.busy, true);
    await assert.rejects(service.execute('workspace', options('workspace-running')), /LOCAL_BUSY/);
    release();
    await assert.rejects(pending, /LOCAL_CANCELLED/);
    assert.equal((await service.store.task('alice', task.id)).text, undefined);
    assert.equal(await service.store.busy('workspace', 'native-codex'), false);
  } finally { release(); await service.onModuleDestroy(); await pending.catch(() => undefined); }
}));
