import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { LocalAgentStore } from './local-agents.store';
import { LocalAgentsService } from './local-agents.service';
import { parseCompanionPoll } from './local-agents.requests';
import { NativeEventCollector } from '../../local-agents/events';
import type { ResearchActivity } from '../../../shared/research-events.interface';

test('retained diagnostics are owner scoped, bounded, exact-context and metadata only', async () => {
  const root = await mkdtemp(join(tmpdir(), 'squabble-task-diagnostics-'));
  const store = new LocalAgentStore(root);
  const context = { sessionId: randomUUID(), revision: 3, cycleId: 'cycle-fixture', attempt: 2, memberId: 'analyst', memberName: 'Analyst', turn: 1, language: 'en' };
  const service = new LocalAgentsService({ detectNativeAgents: async () => { throw new Error('No provider discovery'); },
    openNativeLogin: async () => { throw new Error('No login'); }, runNativeAgent: async () => { throw new Error('No dispatch'); } }, store);
  try {
    await store.connectNative('alice', 'claude');
    const task = await store.stage('alice', 'native-claude', 'claude', randomUUID(), 'PRIVATE_PROMPT', 'run', { model: 'fixture-model' }, undefined, undefined, undefined, false, context);
    await store.activate('alice', task.id); await store.takeNative('alice', task.id); await store.markNativeEntry('alice', task.id);
    for (let batch = 0; batch < 160; batch += 32) await store.appendDiagnostics('alice', task.id, Array.from({ length: 32 }, (_, i) => ({
      id: `diagnostic-${batch + i}`, stage: 'output' as const, status: 'running' as const, at: new Date().toISOString(), outputBytes: batch + i,
    })));
    const failure = { code: 'LOCAL_PROTOCOL_INCOMPLETE', stage: 'runtime' as const, exitCode: 0, outputBytes: 42,
      stderrBytes: 8, terminalEvent: false, recoveries: ['retry_member' as const] };
    await store.update('alice', task.id, { state: 'failed', text: 'PRIVATE_REPORT', error: failure.code, failure });
    const metadata = await service.getTaskDiagnostics('alice', task.id);
    assert.equal(metadata.runtimeEntered, true); assert.deepEqual(metadata.activityContext, context);
    assert.equal(metadata.configuredModel, 'fixture-model'); assert.equal(metadata.observedModel, null);
    assert.equal(metadata.activityCapability, 'tools');
    assert.deepEqual(metadata.failure, failure); assert.ok(metadata.diagnostics.length <= 128); assert.equal(metadata.diagnosticsTruncated, true);
    assert.doesNotMatch(JSON.stringify(metadata), /PRIVATE|"(?:prompt|text|researchBundle|researchScope)"/);
    await assert.rejects(service.getTaskDiagnostics('bob', task.id), /LOCAL_TASK_NOT_FOUND/);
    assert.equal((await service.listTaskDiagnostics('alice', { sessionId: context.sessionId, revision: 3, cycleId: 'wrong' })).length, 0);
    assert.equal((await service.listTaskDiagnostics('alice', context)).length, 1);
    assert.deepEqual((await new LocalAgentStore(root).taskDiagnostics('alice', task.id)).failure, failure);
  } finally { await service.onModuleDestroy(); await rm(root, { recursive: true, force: true }); }
});

test('Companion validation accepts safe diagnostics/failures and rejects raw diagnostic fields', () => {
  const update = { id: randomUUID(), state: 'failed', error: 'LOCAL_NETWORK_UNAVAILABLE',
    diagnostics: [{ id: 'process-result', stage: 'process', status: 'failed', at: new Date().toISOString(), exitCode: 3, outputBytes: 0, stderrBytes: 12 }],
    failure: { code: 'LOCAL_NETWORK_UNAVAILABLE', stage: 'runtime', exitCode: 3, outputBytes: 0, stderrBytes: 12, terminalEvent: false, recoveries: ['retry_member'] } };
  assert.deepEqual(parseCompanionPoll({ agents: [], updates: [update] }).updates[0], update);
  for (const privateField of [{ stderr: 'PRIVATE' }, { prompt: 'PRIVATE' }, { args: ['PRIVATE'] }]) {
    assert.throws(() => parseCompanionPoll({ agents: [], updates: [{ ...update, diagnostics: [{ ...update.diagnostics[0], ...privateField }] }] }));
    assert.throws(() => parseCompanionPoll({ agents: [], updates: [{ ...update, failure: { ...update.failure, ...privateField } }] }));
  }
  assert.doesNotThrow(() => parseCompanionPoll({ agents: [], updates: [{ id: update.id, state: 'failed' }] }));
});

test('native collector emits an explicit bounded truncation marker and isolates observers', () => {
  const events: ResearchActivity[] = [];
  const collector = new NativeEventCollector('codex', () => { throw new Error('observer'); }, event => events.push(event));
  for (let i = 0; i < 300; i++) collector.read(JSON.stringify({ type: 'item.started', item: { id: `call-${i}`, type: 'web_search' } }));
  assert.equal(events.length, 256);
  assert.equal(events.at(-1)?.id, 'codex-activity-truncated');
  assert.equal(events.at(-1)?.status, 'unavailable');
});

test('cold diagnostic reads never recover active work or create an absent journal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'squabble-cold-diagnostics-'));
  try {
    const store = new LocalAgentStore(root); await store.connectNative('alice', 'claude');
    const task = await store.stage('alice', 'native-claude', 'claude', randomUUID(), 'PRIVATE', 'run');
    await store.activate('alice', task.id); await store.takeNative('alice', task.id);
    const path = join(root, 'tasks', `${task.id}.json`); const before = await readFile(path, 'utf8');
    const cold = new LocalAgentStore(root);
    assert.equal((await cold.taskDiagnostics('alice', task.id)).state, 'running');
    assert.equal(await readFile(path, 'utf8'), before);
    const absent = join(root, 'absent');
    assert.deepEqual(await new LocalAgentStore(absent).listTaskDiagnostics('alice', { sessionId: randomUUID(), revision: 1 }), []);
    await assert.rejects(stat(absent), { code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('asynchronous observation persistence failures cannot fail successful native work or replay it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'squabble-observer-diagnostics-'));
  const store = new LocalAgentStore(root); let runs = 0;
  const service = new LocalAgentsService({ detectNativeAgents: async () => [{ provider: 'claude', state: 'ready', name: 'Claude', loginCommand: '', installUrl: '' }],
    openNativeLogin: async () => undefined, runNativeAgent: async (_provider, _prompt, run) => {
      runs++; run.onDiagnostic?.({ id: 'spawn', stage: 'process', status: 'running', at: new Date().toISOString() });
      run.onEvent?.({ id: 'event', kind: 'summary', status: 'running', at: new Date().toISOString(), summary: 'Public stage' });
      run.onProgress('Public progress'); return { text: 'report', usageTokens: null };
    } }, store);
  Object.defineProperty(service, 'mode', { get: () => 'native' });
  try {
    await store.connectNative('alice', 'claude');
    store.appendDiagnostics = async () => { throw new Error('Fixture journal unavailable'); };
    store.appendEvents = async () => { throw new Error('Fixture journal unavailable'); };
    const result = await service.execute('alice', { agentId: 'native-claude', messageId: randomUUID(), prompt: 'Research',
      onTask: async () => undefined, onProgress: async () => undefined, shouldContinue: async () => true });
    assert.equal(result.text, 'report'); assert.equal(runs, 1);
    const retained = await service.getTaskDiagnostics('alice', result.taskId!);
    assert.equal(retained.diagnosticsTruncated, true); assert.equal(retained.eventsTruncated, true);
  } finally { await service.onModuleDestroy(); await rm(root, { recursive: true, force: true }); }
});

test('Companion persists structured terminal diagnostics and old peers keep unknown coverage', async () => {
  const root = await mkdtemp(join(tmpdir(), 'squabble-companion-journal-'));
  const store = new LocalAgentStore(root);
  try {
    const paired = await store.pair((await store.createPairing('alice')).code, 'Fixture');
    const agents = [{ provider: 'claude' as const, state: 'ready' as const, name: 'Claude', loginCommand: '', installUrl: '' }];
    await store.poll(paired.token, { agents, updates: [] }); await store.connectCompanion('alice', 'claude');
    const task = await store.stage('alice', 'companion-claude', 'claude', randomUUID(), 'PRIVATE');
    await store.activate('alice', task.id); await store.poll(paired.token, { agents, updates: [] });
    assert.equal((await store.taskDiagnostics('alice', task.id)).activityCapability, undefined);
    const failure = { code: 'LOCAL_NETWORK_UNAVAILABLE', stage: 'runtime' as const, exitCode: 3, stderrBytes: 8, terminalEvent: false, recoveries: ['retry_member' as const] };
    await store.poll(paired.token, { agents, updates: [{ id: task.id, state: 'failed', error: 'LOCAL_NETWORK_UNAVAILABLE', failure,
      activityCapability: 'tools', diagnosticsTruncated: true, diagnostics: [{ id: 'first-process', stage: 'process', status: 'failed',
        at: new Date().toISOString(), exitCode: 3, stderrBytes: 8 }] }] });
    const metadata = await new LocalAgentStore(root).taskDiagnostics('alice', task.id);
    assert.deepEqual(metadata.failure, failure); assert.equal(metadata.activityCapability, 'tools');
    assert.equal(metadata.runtimeEntered, true); assert.equal(metadata.diagnostics[0].exitCode, 3);
    assert.equal(metadata.diagnosticsTruncated, true); assert.ok(metadata.companionLastSeenAt);
  } finally { await rm(root, { recursive: true, force: true }); }
});
