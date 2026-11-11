const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/telemetry/runs/fixture' });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'Event', 'MutationObserver', 'getComputedStyle']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key], writable: true });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = require('react');
const { createRoot } = require('react-dom/client');
const { MemoryRouter } = require('react-router-dom');
const { QueryClient, QueryClientProvider } = require('@tanstack/react-query');
const fixture = require('./simple-test-loader.cjs');

function task(overrides = {}) {
  return { taskId: 'task-failed', memberId: 'member-one', memberName: 'Fictional analyst', provider: 'codex', transport: 'native', retained: true,
    attempt: 1, state: 'failed', configuredModel: 'configured-fixture', observedModel: null,
    createdAt: '2026-11-11T08:00:00Z', updatedAt: '2026-11-11T08:08:00Z', lastActivityAt: '2026-11-11T08:00:05Z', heartbeatAt: null,
    processState: 'exited', acceptance: 'rejected', activityCapability: 'tools', modelRequestsVisible: false, eventsTruncated: true,
    failure: { code: 'LOCAL_TASK_FAILED', stage: 'runtime', exitCode: 7, outputBytes: 25, terminalEvent: false, recoveries: ['check_existing'] },
    events: [
      { id: 'dispatch', taskId: 'task-failed', sequence: 1, kind: 'stage', stage: 'dispatch', status: 'succeeded', at: '2026-11-11T08:00:01Z', summary: 'Process spawned' },
      { id: 'tool', taskId: 'task-failed', sequence: 2, kind: 'tool', stage: 'execution', status: 'running', at: '2026-11-11T08:00:02Z', summary: 'Public tool started', toolName: 'read_source' },
      { id: 'failure', taskId: 'task-failed', sequence: 3, kind: 'stage', stage: 'execution', status: 'failed', at: '2026-11-11T08:00:05Z', summary: 'Process failed', code: 'LOCAL_TASK_FAILED' },
    ], ...overrides };
}
function diagnostics(tasks = [task()]) {
  return { generatedAt: '2026-11-11T08:08:00Z', cursor: 'snapshot-one', coverage: 'partial', publication: 'unknown', tasks };
}

test('diagnostic evidence uses retained stages and keeps silence separate from process failure', () => {
  const { load } = fixture();
  const { diagnosticEvidence } = load('features/telemetry/telemetry-diagnostics-state.ts');
  const evidence = diagnosticEvidence(task());
  assert.equal(evidence.stage, 'execution');
  assert.equal(evidence.lastSuccess.id, 'dispatch');
  assert.equal(evidence.latestEvent.id, 'failure');
  const quiet = diagnosticEvidence(task({ state: 'running', processState: 'unknown', events: [], failure: null }));
  assert.equal(quiet.stage, null);
  assert.equal(quiet.lastSuccess, null);
  assert.equal(quiet.latestEvent, null);
});

test('failure explanations name recorded causes and keep generic failures explicitly unknown', () => {
  const { load } = fixture();
  const { diagnosticFailureExplanation, diagnosticFailureStageLabel, diagnosticRecoveryLabel } = load('features/telemetry/telemetry-copy.ts');
  assert.match(diagnosticFailureExplanation({ code: 'LOCAL_NETWORK_UNAVAILABLE', stage: 'runtime' }, true), /网络或传输失败/);
  assert.match(diagnosticFailureExplanation({ code: 'LOCAL_TIMEOUT', stage: 'runtime' }, false), /time limit/);
  assert.match(diagnosticFailureExplanation({ code: 'LOCAL_PROTOCOL_INCOMPLETE', stage: 'runtime' }, true), /完整的最终结果/);
  assert.match(diagnosticFailureExplanation({ code: 'LOCAL_INVALID_RESULT', stage: 'parse' }, true), /内容已返回.*验收未通过/);
  assert.match(diagnosticFailureExplanation({ code: 'LOCAL_TASK_FAILED', stage: 'runtime' }, false), /does not establish a more specific cause/);
  assert.equal(diagnosticFailureStageLabel('runtime', true), '执行过程');
  assert.match(diagnosticRecoveryLabel('reparse_existing', true), /已有结果/);
  assert.match(diagnosticRecoveryLabel('check_existing', false), /original task/);
});

test('live reads retain snapshots through transient errors, clear revoked cache and abort on unmount', async () => {
  const f = fixture({ realQuery: true });
  const api = f.load('api/telemetry.ts');
  const snapshot = diagnostics([task({ state: 'completed', failure: null, acceptance: 'pending' })]);
  api.fetchTelemetryDiagnostics = async () => snapshot;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const Component = f.load('features/telemetry/TelemetryDiagnostics.tsx').default;
  const hooks = f.load('features/telemetry/use-telemetry.ts');
  api.fetchTelemetryRun = async () => ({ run: { title: 'Original private source' }, spans: [] });
  function ObservedDetail() { hooks.useTelemetryRun('research:live'); return React.createElement(Component, { id: 'research:live', sessionId: null, active: false }); }
  const root = createRoot(document.getElementById('root'));
  const key = ['telemetry-diagnostics', 'research:live'];
  const flush = () => React.act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
  let unmounted = false;
  try {
    await React.act(async () => root.render(React.createElement(QueryClientProvider, { client }, React.createElement(MemoryRouter, null,
      React.createElement(ObservedDetail)))));
    await flush();
    const query = client.getQueryCache().find({ queryKey: key });
    assert.equal(query.options.refetchInterval(query), 2000, 'completed CLI still waits for local acceptance');
    await React.act(async () => client.setQueryData(key, { ...snapshot, tasks: [task({ acceptance: 'accepted' })], publication: 'pending' }));
    assert.equal(query.options.refetchInterval(query), 2000, 'publication can remain pending after acceptance');
    await React.act(async () => client.setQueryData(key, { ...snapshot, tasks: [task({ acceptance: 'accepted' })], publication: 'unknown' }));
    assert.equal(query.options.refetchInterval(query), 2000, 'a publisher may not have persisted its outcome after completed accepted execution');
    await React.act(async () => client.setQueryData(key, { ...snapshot, tasks: [task({ acceptance: 'accepted' })], publication: 'published' }));
    assert.equal(query.options.refetchInterval(query), false);
    api.fetchTelemetryDiagnostics = async () => { throw new Error('fixture disconnect'); };
    await React.act(async () => client.refetchQueries({ queryKey: key }));
    await flush();
    assert.equal(client.getQueryData(key).tasks[0].memberName, 'Fictional analyst');
    assert.match(document.body.textContent, /Reconnecting/);
    let resolveLateDetail;
    api.fetchTelemetryRun = () => new Promise(resolve => { resolveLateDetail = resolve; });
    let lateRead;
    await React.act(async () => { lateRead = client.refetchQueries({ queryKey: ['telemetry-run', 'research:live'] }); });
    assert.equal(typeof resolveLateDetail, 'function');
    api.fetchTelemetryDiagnostics = async () => { throw { response: { status: 404 } }; };
    await React.act(async () => client.refetchQueries({ queryKey: key }));
    await flush();
    assert.equal(client.getQueryData(key), null, 'revoked source evidence must not remain downloadable in cache');
    assert.equal(client.getQueryData(['telemetry-run', 'research:live']), null, 'a diagnostic denial must also remove surrounding source details and controls');
    resolveLateDetail({ run: { title: 'Late revoked private source' }, spans: [{ name: 'Late revoked tool' }] });
    await lateRead; await flush();
    assert.equal(client.getQueryData(['telemetry-run', 'research:live']), null, 'a late detail read must not restore revoked evidence');
    assert.doesNotMatch(document.body.textContent, /Fictional analyst/);
    let pendingSignal;
    api.fetchTelemetryDiagnostics = (_id, signal) => new Promise((_resolve, reject) => {
      pendingSignal = signal;
      signal.addEventListener('abort', () => reject(new Error('fixture aborted')), { once: true });
    });
    await React.act(async () => { void client.refetchQueries({ queryKey: key }); });
    assert.equal(pendingSignal.aborted, false);
    await React.act(async () => root.unmount());
    unmounted = true;
    assert.equal(pendingSignal.aborted, true);
  } finally {
    if (!unmounted) await React.act(async () => root.unmount());
    client.clear();
  }
});

test('diagnostic packs whitelist public metadata and do not copy unexpected private properties', () => {
  const { load } = fixture();
  const { diagnosticPack } = load('features/telemetry/telemetry-diagnostics-state.ts');
  const payload = diagnostics([task({ prompt: 'PRIVATE PROMPT', stderr: 'PRIVATE STDERR', events: [{ ...task().events[0], arguments: 'PRIVATE ARGUMENTS' }] })]);
  const json = diagnosticPack('research:fixture', payload);
  assert.equal(JSON.parse(json).diagnostics.tasks[0].failure.exitCode, 7);
  assert.equal(JSON.parse(json).diagnostics.tasks[0].events[0].summary, 'Process spawned');
  assert.doesNotMatch(json, /PRIVATE|arguments|stderr"|prompt/);
});

test('diagnostic HTTP reads encode run identities and pass cancellation to authenticated requests', async () => {
  const { load, state } = fixture();
  const api = load('api/telemetry.ts');
  const signal = new AbortController().signal;
  await api.fetchTelemetryDiagnostics('research:a/b', signal);
  assert.equal(state.requests[0].method, 'get');
  assert.equal(state.requests[0].args[0], '/api/telemetry/runs/research%3Aa%2Fb/diagnostics');
  assert.equal(state.requests[0].args[1].signal, signal);
});

test('diagnostics select tasks, filter actual tool events, pause follow and preserve prior data during reconnect', async () => {
  const f = fixture();
  const payload = diagnostics([task(), task({ taskId: 'task-quiet', memberName: 'Fictional quiet agent', state: 'running', processState: 'unknown', failure: null, acceptance: 'pending', events: [], activityCapability: 'none', eventsTruncated: false })]);
  const query = { data: payload, isPending: false, isError: false, refetch() {} };
  f.state.queries.set('telemetry-diagnostics', query);
  const Component = f.load('features/telemetry/TelemetryDiagnostics.tsx').default;
  const root = createRoot(document.getElementById('root'));
  const render = () => React.createElement(MemoryRouter, null, React.createElement(Component, { id: 'research:fixture', sessionId: 'fixture/session', active: true }));
  const click = async text => {
    const button = [...document.querySelectorAll('button')].find(element => element.textContent.includes(text));
    assert.ok(button, `missing button ${text}`);
    await React.act(async () => button.click());
  };
  try {
    await React.act(async () => root.render(render()));
    assert.match(document.body.textContent, /LOCAL_TASK_FAILED/);
    assert.match(document.body.textContent, /Last successful step/);
    assert.match(document.body.textContent, /Exit code7/);
    assert.equal(document.querySelector('a[href="/research?session=fixture%2Fsession"]').textContent, 'Open recovery controls');
    await click('Fictional quiet agent');
    const selected = document.querySelector('[aria-label="Selected task diagnostics"]');
    assert.match(selected.textContent, /Unknown/);
    assert.match(selected.textContent, /Silence alone does not establish a stall/);
    assert.doesNotMatch(selected.textContent, /LOCAL_TASK_FAILED|deadlock|%/);
    await click('Tools only');
    const records = document.querySelector('[aria-label="Diagnostic event records"]');
    assert.match(records.textContent, /read_source/);
    assert.doesNotMatch(records.textContent, /Process spawned/);
    await click('Pause follow');
    assert.equal([...document.querySelectorAll('button')].find(element => element.textContent.includes('Resume follow')).getAttribute('aria-pressed'), 'false');
    query.isError = true;
    await React.act(async () => root.render(render()));
    assert.match(document.body.textContent, /Reconnecting/);
    assert.match(document.body.textContent, /Fictional quiet agent/);
    query.error = { response: { status: 403 } };
    await React.act(async () => root.render(render()));
    assert.doesNotMatch(document.body.textContent, /Fictional quiet agent|LOCAL_TASK_FAILED/);
  } finally {
    await React.act(async () => root.unmount());
  }
});


test('fixed adapter stages translate without changing recorded public evidence', () => {
  const copy = fixture().load('features/telemetry/telemetry-copy.ts');
  assert.equal(copy.diagnosticEventSummary('Task handed off; subprocess launch not yet established', true), '任务已交接，尚需进程启动证据确认');
  assert.equal(copy.diagnosticEventSummary('Native process started', true), '本地 Agent 进程已启动');
  assert.equal(copy.diagnosticEventSummary('Application rejected the returned result', true), '应用未接受返回结果');
  assert.equal(copy.diagnosticEventSummary('A retained public source activity', true), 'A retained public source activity');
  assert.equal(copy.diagnosticEventSummary('Native process started', false), 'Native process started');
});
