const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');

const filename = path.join(__dirname, 'research-events.ts');
const exportsForTest = {};
if (fs.existsSync(filename)) vm.runInNewContext(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports: exportsForTest, URL });
const event = (sequence, overrides = {}) => ({ id: `e${sequence}`, sequence, sessionId: 's1', taskId: 't1',
  revision: 2, memberId: 'm1', memberName: 'Morgan', turn: 0, kind: 'task', status: 'running',
  at: new Date(1700000000000 + sequence * 1000).toISOString(), summary: `Activity ${sequence}`, ...overrides });
const session = (events, overrides = {}) => ({ id: 's1', revision: 2, status: 'running',
  messages: [], researchEvents: events, ...overrides });
const reduce = (...args) => exportsForTest.researchTimeline?.(...args);

test('task timeline deduplicates stable IDs, orders per-task sequences and reconciles tool calls', () => {
  const start = event(2, { kind: 'tool', toolName: 'research_quote', callId: 'call-1' });
  const done = event(3, { kind: 'tool', toolName: 'research_quote', callId: 'call-1', status: 'succeeded',
    durationMs: 1234, sources: [{ title: 'Market data', url: 'https://example.com', fetchedAt: '2026-11-03' }] });
  const timeline = reduce(session([done, start, event(1, { status: 'queued' }), done]));
  assert.equal(timeline?.tasks.length, 1);
  const task = timeline.tasks[0];
  assert.equal(task.activities.length, 1);
  assert.equal(task.activities[0].status, 'succeeded');
  assert.equal(task.activities[0].startedAt, start.at);
  assert.equal(task.activities[0].durationMs, 1234);
  assert.equal(task.sourceCount, 1);
  assert.equal(task.status, 'running');
});

test('terminal tasks never keep tool spinners and a late summary cannot revive them', () => {
  for (const status of ['succeeded', 'failed', 'cancelled', 'interrupted', 'unavailable']) {
    const task = reduce(session([event(1), event(2, { kind: 'tool', callId: 'a' }),
      event(3, { status }), event(4, { kind: 'summary', status: 'running' })]))?.tasks[0];
    assert.equal(task?.status, status);
    assert.ok(task.activities.filter(activity => activity.kind === 'tool').every(activity => !['running', 'queued'].includes(activity.status)));
    assert.equal(task.activities[0].status, status === 'cancelled' ? 'cancelled' : 'interrupted');
    assert.equal(task.activities[1].status, 'running', 'public observations must not acquire a fabricated outcome');
    assert.equal(task.durationMs, 2000);
  }
});

test('tool-only evidence tasks finish with stable elapsed time before and after a session refresh', () => {
  const events = [event(1, { kind: 'tool', callId: 'financials' }),
    event(2, { kind: 'tool', callId: 'news' }),
    event(4, { kind: 'tool', callId: 'financials', status: 'succeeded' }),
    event(6, { kind: 'tool', callId: 'news', status: 'succeeded' })];
  assert.equal(reduce(session(events.slice(0, -1))).tasks[0].status, 'running');
  for (const status of ['running', 'completed']) {
    const task = reduce(session(events, { status })).tasks[0];
    assert.equal(task.status, 'succeeded');
    assert.equal(task.durationMs, 5000);
    assert.deepEqual(Array.from(task.activities, activity => activity.durationMs), [3000, 4000]);
  }
});

test('tool-only tasks preserve unsuccessful outcomes and never complete while another tool is active', () => {
  for (const status of ['failed', 'cancelled', 'interrupted', 'unavailable']) {
    const events = [event(1, { kind: 'tool', callId: 'a' }),
      event(2, { kind: 'tool', callId: 'a', status }),
      event(3, { kind: 'tool', callId: 'b' })];
    assert.equal(reduce(session(events)).tasks[0].status, 'running');
    events.push(event(4, { kind: 'tool', callId: 'b', status: 'succeeded' }));
    assert.equal(reduce(session(events)).tasks[0].status, status);
  }
  const native = [event(1, { status: 'running' }), event(2, { kind: 'tool', callId: 'a', status: 'succeeded' })];
  assert.equal(reduce(session(native)).tasks[0].status, 'running', 'native lifecycle owns task completion');
});

test('tool-only waiting and repeated acquisitions use the current observed call timing', () => {
  assert.equal(reduce(session([event(1, { kind: 'tool', callId: 'a', status: 'queued' })])).tasks[0].status, 'queued');
  const events = [event(1, { kind: 'tool', callId: 'a' }),
    event(2, { kind: 'tool', callId: 'a', status: 'succeeded' }),
    event(5, { kind: 'tool', callId: 'a' })];
  assert.equal(reduce(session(events)).tasks[0].status, 'running');
  events.push(event(7, { kind: 'tool', callId: 'a', status: 'succeeded' }));
  assert.equal(reduce(session(events)).tasks[0].activities[0].durationMs, 2000);
});

test('capability observations never acquire a fabricated interruption when no availability result was provided', () => {
  for (const status of ['running', 'succeeded']) {
    const task = reduce(session([event(1, { kind: 'capability' }), event(2, { status })])).tasks[0];
    assert.equal(task.activities[0].status, 'unavailable');
  }
});

test('task-level failure details remain visible even when no tools ran', () => {
  const task = reduce(session([event(1), event(2, { status: 'failed', summary: 'The local agent disconnected.' })]))?.tasks[0];
  assert.equal(task?.summary, 'The local agent disconnected.');
});

test('old revisions and closed sessions stop pending activity without inventing success', () => {
  const older = reduce(session([event(1, { revision: 1 })]))?.tasks[0];
  assert.equal(older?.isStale, true);
  assert.equal(older.status, 'interrupted');
  for (const status of ['paused', 'failed', 'completed', 'idle']) {
    assert.equal(reduce(session([event(1)], { status }))?.tasks[0].status, 'interrupted');
  }
});

test('final replies correlate only by task and revision, preserving explicit failures', () => {
  const reply = { id: 'reply1', taskId: 't1', revision: 2, role: 'researcher', content: 'Done' };
  assert.equal(reduce(session([event(1)], { messages: [reply] }))?.tasks[0].status, 'succeeded');
  assert.equal(reduce(session([event(1)], { messages: [reply] }))?.tasks[0].replyMessageId, 'reply1');
  assert.equal(reduce(session([event(1, { status: 'failed' })], { messages: [reply] }))?.tasks[0].status, 'failed');
  assert.equal(reduce(session([event(1)], { messages: [{ ...reply, revision: 1 }] }))?.tasks[0].status, 'running');
});

test('task-local cursors update independently and foreign session events are excluded', () => {
  const first = event(100, { taskId: 'old', turn: 0 });
  const later = event(1, { taskId: 'new', turn: 1 });
  const before = reduce(session([first, later]));
  const after = reduce(session([first, later, event(2, { taskId: 'new', turn: 1 }), event(200, { sessionId: 'foreign' })]));
  assert.ok(before?.cursor);
  assert.notEqual(after?.cursor, before.cursor);
  assert.equal(after.tasks.length, 2);
  assert.deepEqual(Array.from(after.tasks, task => task.taskId), ['old', 'new']);
});

test('backing activity lists stay bounded and report truncation', () => {
  const timeline = reduce(session(Array.from({ length: 300 }, (_, i) => event(i, { kind: 'summary' }))));
  assert.equal(timeline?.tasks[0].activities.length, 256);
  assert.equal(timeline.tasks[0].truncated, true);
  assert.equal(reduce(session([event(1)], { researchEventsTruncated: true }))?.truncated, true);
});

test('source links allow only web URLs and source counts deduplicate references', () => {
  assert.equal(exportsForTest.researchSourceUrl?.('javascript:alert(1)'), null);
  assert.equal(exportsForTest.researchSourceUrl?.('file:///private'), null);
  assert.equal(exportsForTest.researchSourceUrl?.('https://example.com/source'), 'https://example.com/source');
  const source = { title: 'Source', url: 'https://example.com', fetchedAt: '2026-11-03' };
  const task = reduce(session([event(1, { kind: 'tool', sources: [source, source] }),
    event(2, { kind: 'tool', sources: [source] })]))?.tasks[0];
  assert.equal(task?.sourceCount, 1);
});
