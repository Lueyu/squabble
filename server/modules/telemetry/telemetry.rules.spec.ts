import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildTelemetry, normalizeTelemetryFilters, telemetryExecutions, validateFeedback, type TelemetryFacts } from './telemetry.rules';

const at = '2026-11-11T01:00:00.000Z';
function facts(): TelemetryFacts {
  return { sessions: [{ id: 'session', title: 'Research', scene: 'stock', status: 'completed', revision: 2,
    cycleId: 'cycle-two', createdAt: new Date(at), updatedAt: new Date('2026-11-11T01:02:00Z'), members: [] }],
  attempts: [], tasks: [], messages: [], reports: [], captured: [], feedback: [] };
}
const filters = () => normalizeTelemetryFilters({ from: '2026-11-11', to: '2026-11-11' });
const capture = (id: string, values: Partial<TelemetryFacts['captured'][number]> = {}): TelemetryFacts['captured'][number] => ({
  id, runId: 'model:call', sourceId: 'call', scene: 'analysis', title: 'Model call', parentId: null, kind: 'model', name: 'model',
  status: 'completed', agentId: null, agentName: null, provider: 'provider', model: 'model', executionMode: 'api', startedAt: at,
  completedAt: '2026-11-11T01:00:01.000Z', durationMs: 1000, inputTokens: 3, outputTokens: 7, totalTokens: 10,
  estimatedCostUsd: null, errorCode: null, attempt: 1, traceId: null, ...values });

test('a measured model with unmetered tool spans keeps known usage and avoids parent double-counting', () => {
  const input = facts(); input.sessions = [];
  input.captured = [capture('root', { kind: 'task', totalTokens: 10 }), capture('model', { parentId: 'root' }),
    capture('tool', { kind: 'tool', parentId: 'root', inputTokens: null, outputTokens: null, totalTokens: null })];
  const [result] = buildTelemetry(input, filters());
  assert.equal(result.run.totalTokens, 10); assert.equal(result.run.usageKnown, true);
});

test('authoritative successful root preserves recovered failed attempts as children', () => {
  const input = facts(); input.sessions = [];
  input.captured = [capture('root', { kind: 'task', inputTokens: null, outputTokens: null, totalTokens: null }),
    capture('first', { parentId: 'root', status: 'failed', attempt: 1, totalTokens: null }), capture('retry', { parentId: 'root', attempt: 2 })];
  const [result] = buildTelemetry(input, filters());
  assert.equal(result.run.status, 'completed'); assert.equal(result.spans.filter(span => span.status === 'failed').length, 1);
  assert.equal(result.run.totalTokens, 10); assert.equal(result.run.usageKnown, false);
});

test('idle conversation with no cycle or observed execution is not a run', () => {
  const input = facts(); input.sessions[0].cycleId = null; input.sessions[0].status = 'idle';
  input.messages.push({ id: 'user-message', sessionId: 'session', revision: 2, cycleId: null, memberId: null, memberName: 'user', createdAt: new Date(at), event: null });
  assert.equal(buildTelemetry(input, filters()).length, 0);
});

test('captured native receipt replaces the same historical dispatch without double-counting', () => {
  const input = facts(), runId = 'research:session:2:cycle-two';
  input.attempts.push({ id: 'attempt', taskId: 'native-task', sessionId: 'session', cycleId: 'cycle-two', revision: 2,
    memberId: 'member', attempt: 1, status: 'completed', resultAcceptance: 'accepted', resourceKey: 'local:provider',
    createdAt: new Date(at), updatedAt: new Date(at), startedAt: new Date(at), completedAt: new Date(at), tokensUsed: 10, failure: null });
  input.captured = [capture('native:native-task', { runId, kind: 'agent', sourceId: 'native-task', agentId: 'member', executionMode: 'native' })];
  const [result] = buildTelemetry(input, filters());
  assert.equal(result.spans.length, 1); assert.equal(result.run.totalTokens, 10); assert.equal(result.run.accepted, true);
});

function twoMembers(): TelemetryFacts {
  const input = facts();
  input.attempts = ['one', 'two'].map(memberId => ({ id: memberId, taskId: `task-${memberId}`, sessionId: 'session', cycleId: 'cycle-two', revision: 2,
    memberId, attempt: 1, status: 'completed', resultAcceptance: 'accepted', resourceKey: 'local:provider',
    createdAt: new Date(at), updatedAt: new Date(at), startedAt: new Date(at), completedAt: new Date(at), tokensUsed: 0, failure: null }));
  return input;
}

test('a measured captured member cannot hide another unmetered member from run coverage', () => {
  const input = twoMembers();
  input.captured = [capture('native:one', { runId: 'research:session:2:cycle-two', kind: 'agent', sourceId: 'task-one', agentId: 'one', executionMode: 'native' })];
  const [result] = buildTelemetry(input, filters());
  assert.equal(result.run.totalTokens, 10); assert.equal(result.run.usageKnown, false);
});

test('run acceptance remains unknown until all final member results have an acceptance decision', () => {
  const input = twoMembers(); input.sessions[0].status = 'running';
  input.attempts[1].status = 'running'; input.attempts[1].resultAcceptance = 'pending';
  assert.equal(buildTelemetry(input, filters())[0].run.accepted, null);
});

test('explicit model-call parent links preserve one accepted measured agent execution including retries', () => {
  const input = twoMembers(); input.attempts.pop();
  const runId = 'research:session:2:cycle-two';
  input.captured = [capture('call', { runId, kind: 'task', parentId: 'attempt:one', agentId: 'one', inputTokens: null, outputTokens: null, totalTokens: null }),
    capture('first', { runId, parentId: 'call', agentId: 'one', status: 'failed', totalTokens: null, attempt: 1 }),
    capture('retry', { runId, parentId: 'call', agentId: 'one', attempt: 2 })];
  const [projection] = buildTelemetry(input, filters());
  const executions = telemetryExecutions(projection, input);
  assert.equal(executions.length, 1); assert.equal(executions[0].acceptance, true);
  assert.equal(executions[0].span.model, 'model'); assert.equal(executions[0].span.provider, 'provider');
  assert.equal(executions[0].span.totalTokens, 10); assert.equal(executions[0].usageKnown, false);
  assert.equal(executions[0].span.status, 'completed'); assert.equal(projection.run.usageKnown, false);
  assert.equal(projection.spans.filter(span => span.status === 'failed').length, 1);
  input.captured.splice(1, 1);
  assert.equal(buildTelemetry(input, filters())[0].run.usageKnown, true);
});

test('different workflow tasks by one member retain their own outcomes regardless of database row order', () => {
  const input = facts();
  input.tasks = ['failed', 'accepted'].map((state, index) => ({ id: `task-${index}`, sessionId: 'session', cycleId: 'old-cycle', revision: 1,
    memberId: 'member', key: index === 0 ? 'financials' : 'summary', state, updatedAt: new Date(at),
    attempts: [{ id: `workflow-attempt-${index}`, state: index === 0 ? 'failed' : 'succeeded', startedAt: at, finishedAt: at }] }));
  assert.equal(buildTelemetry(input, filters())[0].run.status, 'failed');
  input.tasks.reverse();
  assert.equal(buildTelemetry(input, filters())[0].run.status, 'failed');
});

test('a batched manager review is one execution, and its mirror cannot create unknown worker usage', () => {
  const input = facts(); input.sessions[0].members = [{ id: 'manager', name: 'Manager', role: 'manager' }, { id: 'worker', name: 'Worker', role: 'researcher' }];
  input.tasks = ['primary', 'mirror'].map((id, index) => ({ id: `task-${index}`, sessionId: 'session', cycleId: 'cycle-two', revision: 2,
    memberId: 'worker', key: index ? 'business' : 'financials', state: 'accepted', updatedAt: new Date(at),
    attempts: [{ id, kind: 'review', reviewGroupId: 'primary', state: 'succeeded', startedAt: at, finishedAt: at }] }));
  const runId = 'research:session:2:cycle-two';
  input.captured = [capture('call', { runId, kind: 'task', parentId: 'workflow:primary', agentId: 'manager', totalTokens: null }),
    capture('generation', { runId, parentId: 'call', agentId: 'manager' })];
  const [projection] = buildTelemetry(input, filters()), executions = telemetryExecutions(projection, input);
  assert.equal(executions.length, 1); assert.equal(executions[0].span.agentId, 'manager');
  assert.equal(executions[0].acceptance, null); assert.equal(projection.run.usageKnown, true);
  assert.ok(!projection.spans.some(span => span.id === 'workflow:mirror'));
  input.tasks.reverse();
  assert.equal(telemetryExecutions(buildTelemetry(input, filters())[0], input).length, 1);
});

test('workflow rebasing preserves the original attempt revision and does not mark the old run running', () => {
  const input = facts(); input.sessions[0].status = 'running';
  input.tasks = [{ id: 'task', sessionId: 'session', cycleId: 'cycle-two', revision: 2, memberId: 'worker', key: 'financials',
    state: 'running', updatedAt: new Date(at), attempts: [
      { id: 'old', revision: 1, kind: 'work', state: 'failed', startedAt: at, finishedAt: at },
      { id: 'new', revision: 2, kind: 'work', state: 'running', startedAt: at },
    ] }];
  const runs = buildTelemetry(input, filters());
  assert.equal(runs.length, 2);
  assert.equal(runs.find(item => item.run.revision === 1)?.run.status, 'failed');
  assert.equal(runs.find(item => item.run.revision === 2)?.run.status, 'running');
});

test('historical activity lifecycle messages cannot override a terminal execution receipt', () => {
  const input = twoMembers(); input.attempts = [input.attempts[0]];
  Object.assign(input.attempts[0], { revision: 1, cycleId: 'old-cycle', status: 'failed', resultAcceptance: 'rejected' });
  input.messages = ['queued', 'running', 'failed'].map((status, index) => ({ id: `message-${index}`, sessionId: 'session', revision: 1,
    cycleId: 'old-cycle', memberId: null, memberName: 'Worker', createdAt: new Date(at),
    event: { id: `event-${index}`, kind: 'task', status, at } }));
  assert.equal(buildTelemetry(input, filters())[0].run.status, 'failed');
});

test('each revision and cycle has its own run; report totals are never copied across cycles', () => {
  const input = facts();
  input.attempts.push(...[1, 2].map(revision => ({ id: `a${revision}`, sessionId: 'session', cycleId: `cycle-${revision}`, revision,
    memberId: 'member', attempt: 1, status: 'completed', resultAcceptance: 'accepted', resourceKey: 'local:provider',
    createdAt: new Date(at), updatedAt: new Date(at), startedAt: new Date(at), completedAt: new Date(at), tokensUsed: 0, failure: null })));
  const result = buildTelemetry(input, filters());
  assert.equal(result.length, 2);
  assert.equal(new Set(result.map(item => item.run.id)).size, 2);
  assert.ok(result.every(item => item.run.totalTokens === null && !item.run.usageKnown));
  assert.ok(result.every(item => item.spans.every(span => span.totalTokens === null)));
});

test('retry failures remain visible but the final accepted attempt determines completion', () => {
  const input = facts();
  input.attempts.push(...[1, 2].map(attempt => ({ id: `a${attempt}`, sessionId: 'session', cycleId: 'cycle-two', revision: 2,
    memberId: 'member', attempt, status: attempt === 1 ? 'failed' : 'completed', resultAcceptance: attempt === 1 ? 'rejected' : 'accepted',
    resourceKey: 'local:provider', createdAt: new Date(at), updatedAt: new Date(at), startedAt: new Date(at), completedAt: new Date(at),
    tokensUsed: 0, failure: attempt === 1 ? { code: 'LOCAL_RESULT_INVALID' } : null })));
  const [result] = buildTelemetry(input, filters());
  assert.equal(result.run.status, 'completed');
  assert.equal(result.run.accepted, true);
  assert.equal(result.spans.filter(span => span.status === 'failed').length, 1);
});

test('unknown report coverage is excluded from quality denominators and known false is retained', () => {
  const input = facts();
  input.reports.push({ id: 'report', sessionId: 'session', revision: 2, cycleId: 'cycle-two', createdAt: new Date(at),
    publicationOutcome: 'succeeded', complete: false, evidenceCount: 0, reverseCheck: null, reportVersionId: null, adopted: null, hidden: false });
  const [result] = buildTelemetry(input, filters());
  assert.equal(result.quality.completeDelivery, false);
  assert.equal(result.quality.reverseCheck, null);
  assert.equal(result.quality.adoption, null);
});

test('report-only historical revisions use the recorded publication activity, with unknown start duration', () => {
  const input = facts(); input.sessions[0].createdAt = new Date('2026-10-01T00:00:00Z');
  input.reports.push({ id: 'report', sessionId: 'session', revision: 2, cycleId: 'cycle-two', createdAt: new Date(at),
    publicationOutcome: 'succeeded', complete: null, evidenceCount: 0, reverseCheck: null, reportVersionId: null, adopted: null, hidden: false });
  const [result] = buildTelemetry(input, filters());
  assert.ok(result); assert.equal(result.run.startedAt, at); assert.equal(result.run.durationMs, null);
});

test('hidden report source hides its matching projected run and its captured spans', () => {
  const input = facts();
  input.reports.push({ id: 'report', sessionId: 'session', revision: 2, cycleId: 'cycle-two', createdAt: new Date(at),
    publicationOutcome: 'succeeded', complete: true, evidenceCount: 1, reverseCheck: true, reportVersionId: 'version', adopted: false, hidden: true });
  assert.equal(buildTelemetry(input, filters()).length, 0);
});

test('default filters and reset represent the promised rolling seven days', () => {
  const end = new Date('2026-11-11T08:00:00.000Z');
  const selected = normalizeTelemetryFilters({}, end);
  assert.equal(Date.parse(selected.to) - Date.parse(selected.from), 7 * 86400000);
});

test('filters bound dates and paging, reject invalid states, and feedback is bounded', () => {
  assert.equal(normalizeTelemetryFilters({ limit: 2000, offset: 4 }).limit, 100);
  assert.throws(() => normalizeTelemetryFilters({ status: 'invented' }), /TELEMETRY_STATUS_INVALID/);
  assert.throws(() => normalizeTelemetryFilters({ from: 'not-a-date' }), /TELEMETRY_DATE_INVALID/);
  assert.throws(() => validateFeedback({ rating: 'positive', comment: 'x'.repeat(2001) }), /TELEMETRY_FEEDBACK_INVALID/);
  assert.deepEqual(validateFeedback({ rating: 'negative', comment: '  Useful feedback  ' }), { rating: 'negative', comment: 'Useful feedback' });
});
