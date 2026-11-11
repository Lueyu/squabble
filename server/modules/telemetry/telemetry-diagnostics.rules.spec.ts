import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { diagnosticFailure, diagnosticTask, workflowDiagnosticAcceptance, type DiagnosticTaskReference } from './telemetry-diagnostics.rules';
import type { LocalAgentTaskDiagnostics } from '../local-agents/local-agents.types';
import { LocalAgentStore } from '../local-agents/local-agents.store';

const at = '2026-11-11T01:00:00.000Z';
const reference: DiagnosticTaskReference = { id: 'receipt', remoteTaskId: 'task', sessionId: 'session', revision: 1,
  cycleId: 'cycle', memberId: 'member', memberName: 'Fixture member', attempt: 1, turn: 0,
  createdAt: at, updatedAt: at, acceptance: 'pending', failure: null };
function task(change: Partial<LocalAgentTaskDiagnostics> = {}): LocalAgentTaskDiagnostics {
  return { taskId: 'task', agentId: 'native-codex', provider: 'codex', executionMode: 'native', state: 'running',
    createdAt: at, updatedAt: at, commandEmitted: true, runtimeEntered: true, configuredModel: null, observedModel: null,
    companionLastSeenAt: null, activityContext: { sessionId: 'session', revision: 1, cycleId: 'cycle', memberId: 'member', memberName: 'Fixture member', attempt: 1, turn: 0, language: 'en' },
    diagnostics: [{ id: 'spawn', stage: 'process', status: 'running', at }], diagnosticsTruncated: false, events: [], eventsTruncated: false, ...change };
}
test('fixed non-local-prefixed safe failures remain structured while unknown private properties are dropped', () => {
  const failure = diagnosticFailure({ code: 'MEMORY_CONTEXT_CHANGED', stage: 'dispatch', stderrBytes: 20, recoveries: ['check_existing'],
    stderr: 'private text' } as any);
  assert.deepEqual(failure, { code: 'MEMORY_CONTEXT_CHANGED', stage: 'dispatch', stderrBytes: 20, recoveries: ['check_existing'] });
});
test('only an observed companion bridge heartbeat is exposed and it never establishes process liveness', () => {
  const active = diagnosticTask(reference, task({ executionMode: 'companion', companionLastSeenAt: at }));
  assert.equal(active.heartbeatAt, at);
  assert.equal(diagnosticTask(reference, task({ companionLastSeenAt: at })).heartbeatAt, null);
  for (const companionLastSeenAt of [null, '', 'invalid', '2026-11-11', '2026-02-30T00:00:00.000Z']) {
    assert.equal(diagnosticTask(reference, task({ executionMode: 'companion', companionLastSeenAt })).heartbeatAt, null);
  }
  const ended = diagnosticTask(reference, task({ state: 'failed' }));
  assert.equal(ended.processState, 'unknown'); assert.equal(ended.state, 'failed');
  const notLaunched = diagnosticTask(reference, task({ state: 'failed', diagnostics: [{ id: 'launch', stage: 'process', status: 'failed', at, exitCode: -1 }] }));
  assert.equal(notLaunched.processState, 'not_observed');
});
test('bridge heartbeat metadata is tied to the task device and owner without borrowing a foreign or missing device time', async () => {
  const root = await mkdtemp(join(tmpdir(), 'squabble-telemetry-heartbeat-')), taskId = randomUUID();
  try {
    await mkdir(join(root, 'tasks'));
    await writeFile(join(root, 'tasks', `${taskId}.json`), JSON.stringify({ id: taskId, owner: 'alice', agentId: 'companion-codex',
      provider: 'codex', deviceId: 'task-device', state: 'completed', createdAt: Date.parse(at), updatedAt: Date.parse(at),
      activityContext: task().activityContext }));
    const scoped = { ...reference, remoteTaskId: taskId };
    for (const devices of [
      [{ id: 'other-device', owner: 'alice', lastSeen: Date.parse(at) }],
      [{ id: 'task-device', owner: 'bob', lastSeen: Date.parse(at) }],
      [{ id: 'task-device', owner: 'alice', lastSeen: Date.parse(at) }],
    ]) {
      await writeFile(join(root, 'connections.json'), JSON.stringify({ nativeProviders: [], devices }));
      const saved = await new LocalAgentStore(root).taskDiagnostics('alice', taskId);
      const projected = diagnosticTask(scoped, saved);
      assert.equal(projected.heartbeatAt, devices[0].owner === 'alice' && devices[0].id === 'task-device' ? at : null);
    }
  } finally {
    assert.ok(resolve(root).startsWith(resolve(join(tmpdir(), 'squabble-telemetry-heartbeat-'))));
    await rm(root, { recursive: true, force: true });
  }
});
test('configured model identifiers preserve validated display text without claiming an observed model', () => {
  const result = diagnosticTask(reference, task({ configuredModel: 'provider/model@primary [fast]' }));
  assert.equal(result.configuredModel, 'provider/model@primary [fast]'); assert.equal(result.observedModel, null);
});
test('coincident cross-stream markers retain stage order without inventing finer timestamps', () => {
  const result = diagnosticTask(reference, task({ state: 'completed', diagnostics: [
    { id: 'preflight', stage: 'preflight', status: 'succeeded', at },
    { id: 'spawn', stage: 'process', status: 'running', at },
    { id: 'exit', stage: 'process', status: 'succeeded', at, exitCode: 0 },
    { id: 'result', stage: 'result', status: 'succeeded', at, terminalEvent: true },
  ], events: [{ id: 'tool-end', taskId: 'task', sessionId: 'session', revision: 1, cycleId: 'cycle', memberId: 'member',
    memberName: 'Fixture member', attempt: 1, turn: 0, sequence: 3, kind: 'tool', status: 'succeeded', at, summary: 'Tool finished' }] }));
  assert.deepEqual(result.events.map(event => event.id), ['native:preflight', 'native:spawn', 'native:exit', 'activity:tool-end', 'native:result']);
  assert.equal(result.events.at(-1)?.stage, 'result'); assert.ok(result.events.every(event => event.at === at));
});
test('a journal running handoff is dispatch evidence until an actual subprocess marker is recorded', () => {
  const result = diagnosticTask(reference, task({ diagnostics: [], events: [{ id: 'handoff', taskId: 'task', sessionId: 'session',
    revision: 1, cycleId: 'cycle', memberId: 'member', memberName: 'Fixture member', attempt: 1, turn: 0, sequence: 1,
    kind: 'task', status: 'running', at, summary: 'Research agent is working' }] }));
  assert.equal(result.processState, 'not_observed'); assert.equal(result.events[0].stage, 'dispatch');
  assert.equal(result.events[0].summary, 'Task handed off; subprocess launch not yet established');
});
test('saved positive review survives cleared current acceptance pointers and cancelled later review output', () => {
  const reviewedAt = '2026-11-11T01:00:05.000Z';
  const attempts = [
    { id: 'work', kind: 'work' as const, state: 'succeeded', finishedAt: at, reviewAccepted: null },
    { id: 'review', kind: 'review' as const, state: 'succeeded', finishedAt: reviewedAt, reviewAccepted: true },
    { id: 'late', kind: 'review' as const, state: 'cancelled', finishedAt: reviewedAt, reviewAccepted: false },
    { id: 'rework', kind: 'work' as const, state: 'running', reviewAccepted: null },
  ];
  assert.deepEqual(workflowDiagnosticAcceptance(attempts, 0, null), { acceptance: 'accepted', acceptanceAt: reviewedAt });
  assert.deepEqual(workflowDiagnosticAcceptance(attempts, 1, null), { acceptance: null });
  assert.deepEqual(workflowDiagnosticAcceptance(attempts, 3, null), { acceptance: 'pending' });
  assert.deepEqual(workflowDiagnosticAcceptance([attempts[0]], 0, 'work'), { acceptance: 'accepted', acceptanceAt: at });
});
test('terminal lifecycle failures keep the recorded preflight location and cancellation cannot invent process execution', () => {
  const end = '2026-11-11T01:00:01.000Z';
  const terminal = (status: 'failed' | 'cancelled') => ({ id: `task-${status}`, taskId: 'task', sessionId: 'session', revision: 1,
    cycleId: 'cycle', memberId: 'member', memberName: 'Fixture member', attempt: 1, turn: 0, sequence: 1,
    kind: 'task' as const, status, at: end, summary: 'Task ended' });
  const preflight = diagnosticTask(reference, task({ state: 'failed', failure: { code: 'LOCAL_TOOL_ISOLATION_FAILED', stage: 'preflight', recoveries: ['retry_member'] },
    diagnostics: [{ id: 'preflight', stage: 'preflight', status: 'failed', at, code: 'LOCAL_TOOL_ISOLATION_FAILED' }], events: [terminal('failed')] }));
  assert.equal(preflight.processState, 'not_observed'); assert.equal(preflight.events.at(-1)?.stage, 'preflight');
  const cancelled = diagnosticTask(reference, task({ state: 'cancelled', diagnostics: [], events: [terminal('cancelled')] }));
  assert.equal(cancelled.processState, 'not_observed'); assert.equal(cancelled.events.at(-1)?.stage, 'dispatch');
});
