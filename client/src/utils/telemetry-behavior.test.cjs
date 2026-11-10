const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/telemetry' });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLFormElement', 'FormData', 'Element', 'Node', 'Event', 'MutationObserver', 'getComputedStyle']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key], writable: true });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = require('react');
const { createRoot } = require('react-dom/client');
const { MemoryRouter, Routes, Route, useLocation } = require('react-router-dom');
const { QueryClient, QueryClientProvider } = require('@tanstack/react-query');
const fixture = require('./simple-test-loader.cjs');

const integration = { enabled: false, configured: false, status: 'disabled', baseUrl: null, projectUrl: null, captureContent: false };
function run(id = 'research:fixture/1') {
  return { id, source: 'research', sourceId: 'fixture-source', sessionId: 'fixture-session', revision: 3,
    title: 'Fictional saved research', scene: 'research', startedAt: '2026-11-11T08:00:00Z', completedAt: '2026-11-11T08:00:20Z', lastActivityAt: '2026-11-11T08:00:20Z',
    status: 'completed', durationMs: 20000, agentCount: 1, inputTokens: null, outputTokens: null, totalTokens: null, estimatedCostUsd: null,
    usageKnown: false, eventsTruncated: true, accepted: true, reportVersionId: 'fixture-version', adopted: null, traceId: null };
}
function workspace(filters) {
  const items = filters.offset ? [run('research:second')] : [run()];
  return { generatedAt: '2026-11-11T08:00:20Z', range: { from: '2026-11-05T00:00:00Z', to: '2026-11-11T08:00:20Z' }, total: 25,
    overview: { totalRuns: 25, completedRuns: 20, failedRuns: 3, cancelledRuns: 1, runningRuns: 1, unknownRuns: 0,
      completionRate: 20 / 23, p95DurationMs: 20000, totalTokens: null, estimatedCostUsd: null, knownUsageRuns: 0, tokenCoverageRate: 0, trends: [] },
    agents: [{ id: 'fixture-member', name: 'Fictional member', role: 'value', provider: null, model: null, executionMode: 'native',
      executions: 1, completed: 1, failed: 0, accepted: 1, acceptanceKnown: 1, completionRate: 1, p95DurationMs: 20000, totalTokens: null, estimatedCostUsd: null, knownUsageExecutions: 0 }], runs: items,
    quality: { completeDelivery: { numerator: 1, denominator: 1, value: 1 }, traceableEvidence: { numerator: 0, denominator: 0, value: null },
      reverseCheck: { numerator: 0, denominator: 0, value: null }, adoption: { numerator: 0, denominator: 0, value: null }, evaluationAvailable: false, feedback: { positive: 0, negative: 0 } },
    integration, limitations: ['Historical events are partial.'] };
}
function detail(feedback = null) {
  const base = { parentId: null, agentId: 'fixture-member', agentName: 'Fictional member', provider: null, model: null, executionMode: 'native', startedAt: '2026-11-11T08:00:00Z', completedAt: '2026-11-11T08:00:20Z', inputTokens: null, outputTokens: null, totalTokens: null, estimatedCostUsd: null, attempt: 1, traceId: null };
  return { run: run(), spans: [
    { ...base, id: 'agent-span', kind: 'agent', name: 'Recorded analysis', status: 'completed', durationMs: 20000, errorCode: null },
    { ...base, id: 'tool-span', parentId: 'agent-span', kind: 'tool', name: 'Recorded tool attempt', status: 'failed', durationMs: 5000, errorCode: 'FIXTURE_TIMEOUT' },
  ], feedback, integration, limitations: ['Only saved events.'] };
}

async function scenario(path, testBody) {
  const f = fixture({ realQuery: true });
  const calls = { workspace: [], detail: [], feedback: [], failFeedback: false, saved: null };
  const api = f.load('api/telemetry.ts');
  api.fetchTelemetryWorkspace = async filters => {
    calls.workspace.push(filters);
    if (calls.failWorkspace) throw new Error('Fixture read failure');
    const data = workspace(filters);
    return calls.emptyWorkspace ? { ...data, total: 0, runs: [], agents: [], overview: {
      ...data.overview, totalRuns: 0, completedRuns: 0, failedRuns: 0, cancelledRuns: 0, runningRuns: 0,
      completionRate: null, p95DurationMs: null, totalTokens: null, estimatedCostUsd: null, knownUsageRuns: 0, tokenCoverageRate: null, trends: [],
    } } : data;
  };
  api.fetchTelemetryRun = async id => {
    calls.detail.push(id);
    return calls.deferredDetail ?? detail(calls.saved);
  };
  api.saveTelemetryFeedback = async (id, input) => {
    calls.feedback.push({ id, input });
    if (calls.failFeedback) throw new Error('Fixture save failure');
    calls.saved = { ...input, updatedAt: '2026-11-11T08:01:00Z' };
    return calls.saved;
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false, gcTime: 0 } } });
  const Page = f.load('features/telemetry/TelemetryPage.tsx').default;
  const Detail = f.load('features/telemetry/TelemetryRunPage.tsx').default;
  function Location() { const location = useLocation(); return React.createElement('output', null, location.pathname + location.search); }
  const root = createRoot(document.getElementById('root'));
  const flush = () => React.act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
  const click = async text => {
    const element = [...document.querySelectorAll('button,a')].find(item => item.textContent === text);
    assert.ok(element, `Missing action: ${text}`);
    assert.notEqual(element.disabled, true);
    await React.act(async () => element.click());
    await flush();
  };
  const change = async (selector, value) => {
    const element = document.querySelector(selector);
    assert.ok(element, selector);
    const prototype = element.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : element.tagName === 'SELECT' ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value);
    await React.act(async () => element.dispatchEvent(new window.Event(element.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })));
    await flush();
  };
  try {
    await React.act(async () => root.render(React.createElement(QueryClientProvider, { client },
      React.createElement(MemoryRouter, { initialEntries: [path] }, React.createElement(Routes, null,
        React.createElement(Route, { path: '/telemetry', element: React.createElement(Page) }),
        React.createElement(Route, { path: '/telemetry/runs/:id', element: React.createElement(Detail) })), React.createElement(Location)))));
    await flush();
    await testBody({ calls, click, change, flush, client, location: () => document.querySelector('output').textContent, text: () => document.body.textContent });
  } finally {
    await React.act(async () => root.unmount());
    client.clear();
  }
}

test('run filtering resets the page, pagination reaches the API, and deep links preserve filters', async () => {
  await scenario('/telemetry?view=runs&status=failed&offset=12', async ({ calls, click, change, location, flush }) => {
    assert.equal(calls.workspace.at(-1).offset, 12);
    await change('select[aria-label="Execution mode"]', 'native');
    assert.equal(calls.workspace.at(-1).offset, 0);
    assert.equal(calls.workspace.at(-1).status, 'failed');
    assert.equal(calls.workspace.at(-1).executionMode, 'native');
    await click('Next');
    assert.equal(calls.workspace.at(-1).offset, 12);
    await click('Previous');
    await change('input[aria-label="Search run ID, title or member"]', 'Fictional');
    await React.act(async () => document.querySelector('.telemetry-search-row form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
    await flush();
    await click('Fictional saved research');
    assert.equal(calls.detail.at(-1), 'research:fixture/1');
    assert.match(location(), /status=failed/);
    assert.match(location(), /search=Fictional/);
    await click('Back to runs');
    assert.match(location(), /^\/telemetry\?/);
    assert.match(location(), /executionMode=native/);
  });
});

test('detail selects real steps, filters exceptions, and preserves failed feedback for one explicit retry', async () => {
  await scenario('/telemetry/runs/research%3Afixture%2F1?view=runs', async ({ calls, click, change, text }) => {
    assert.match(text(), /Usage|Input/);
    assert.match(text(), /Unknown|unknown/);
    assert.match(text(), /FIXTURE_TIMEOUT/);
    await click('Exceptions');
    assert.equal(document.querySelectorAll('.telemetry-timeline li').length, 1);
    await click('All events');
    const first = document.querySelector('.telemetry-timeline button');
    await React.act(async () => first.click());
    assert.match(document.querySelector('.telemetry-trace-layout > :last-child').textContent, /Recorded analysis/);
    assert.doesNotMatch(document.querySelector('.telemetry-trace-layout > :last-child').textContent, /FIXTURE_TIMEOUT/);
    await click('Needs improvement');
    await change('textarea[aria-label="Feedback comment"]', 'Please retain the source date.');
    calls.failFeedback = true;
    await click('Save feedback');
    assert.equal(calls.feedback.length, 1, 'failed mutation must not retry automatically');
    assert.match(text(), /Your text is retained/);
    assert.equal(document.querySelector('textarea').value, 'Please retain the source date.');
    calls.failFeedback = false;
    await click('Save feedback');
    assert.equal(calls.feedback.length, 2);
    assert.equal(calls.feedback[1].input.rating, 'negative');
    assert.equal(calls.feedback[1].input.comment, 'Please retain the source date.');
    assert.match(text(), /Feedback saved/);
    assert.equal(calls.workspace.length, 0, 'detail reads never initiate workspace work');
  });
});

test('quality exposes unavailable evidence and adoption without inventing evaluation scores', async () => {
  await scenario('/telemetry?view=quality', async ({ text }) => {
    assert.match(text(), /No standardized evaluation scores available/);
    assert.match(text(), /full window is not verified/);
    assert.match(text(), /no coverage/);
    assert.match(text(), /Current adoption pointers are not 7-day adoption/);
    assert.doesNotMatch(text(), /90\.3%|92\.2%|55\.4%|model-a|RUN-1126/);
  });
});

test('a delayed detail refresh after saving cannot remount the form and erase a new feedback draft', async () => {
  await scenario('/telemetry/runs/research%3Afixture%2F1', async ({ calls, click, change, client, flush, text }) => {
    await click('Helpful');
    await change('textarea', 'Saved comment A');
    await click('Save feedback');
    assert.equal(client.getQueryData(['telemetry-run', 'research:fixture/1']).feedback.comment, 'Saved comment A');
    let resolveRead;
    calls.deferredDetail = new Promise(resolve => { resolveRead = resolve; });
    await React.act(async () => { void client.refetchQueries({ queryKey: ['telemetry-run', 'research:fixture/1'] }); });
    await flush();
    await change('textarea', 'Unsaved comment B');
    await click('Needs improvement');
    await React.act(async () => resolveRead(detail({ rating: 'positive', comment: 'Saved comment A', updatedAt: '2026-11-11T08:02:00Z' })));
    await flush();
    assert.equal(document.querySelector('textarea').value, 'Unsaved comment B');
    assert.equal([...document.querySelectorAll('button')].find(button => button.textContent === 'Needs improvement').getAttribute('aria-pressed'), 'true');
    assert.doesNotMatch(text(), /Feedback saved/);
    assert.equal(calls.feedback.length, 1, 'a draft is never automatically submitted');
  });
});

test('workspace errors can be retried and empty filtered results never retain a previous run', async () => {
  await scenario('/telemetry?view=runs', async ({ calls, change, click, text }) => {
    calls.failWorkspace = true;
    await change('input[list="telemetry-scenes"]', 'fixture-failure');
    assert.match(text(), /Telemetry is unavailable/);
    assert.doesNotMatch(text(), /Fictional saved research/);
    calls.failWorkspace = false;
    await click('Retry');
    assert.match(text(), /Fictional saved research/);
    calls.emptyWorkspace = true;
    await change('input[list="telemetry-scenes"]', 'fixture-empty');
    assert.match(text(), /No runs match these filters/);
    assert.doesNotMatch(text(), /Fictional saved research/);
    assert.match(text(), /Showing 0–0 \/ 0 runs/);
    assert.equal(calls.feedback.length, 0);
  });
});
