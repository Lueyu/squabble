const assert = require('node:assert/strict');
const { test } = require('node:test');
const { JSDOM } = require('jsdom');
const React = require('react');
const { createRoot } = require('react-dom/client');
const { QueryClient, QueryClientProvider } = require('@tanstack/react-query');
const fixture = require('./simple-test-loader.cjs');

const runPath = '/api/research-runtime';
const approvalPath = '/api/tool-actions';
const savedRun = { id: 'run', state: 'waiting_approval', steps: [], tools: [] };
const preview = {
  id: 'preview', runId: 'run', revision: 1, descriptor: { name: 'Review draft note' },
  state: 'pending', accountId: 'fictional', target: 'Draft', args: {},
  costLimit: { maxAmount: null }, expiresAt: '2099-01-01T00:00:00Z', attachments: [],
};
const secondPreview = {
  ...preview, id: 'second-preview', runId: 'second-run', descriptor: { name: 'Review second draft' },
};

async function waitFor(select, message) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = select();
    if (result) return result;
    await React.act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  }
  assert.fail(String(message));
}

async function withPanel({ waitingForApproval, secondApproval, failedPath, readOnly }, check) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' });
  const { document } = dom.window;
  Object.assign(globalThis, { window: dom.window, document, IS_REACT_ACT_ENVIRONMENT: true });
  const { state, load } = fixture({ realQuery: true });
  load('api/http.ts').default.get = async (path, options) => {
    state.requests.push({ method: 'get', args: [path, options] });
    assert.equal(path, runPath);
    if (path === failedPath) throw new Error('Fixture unavailable');
    return { data: [savedRun] };
  };
  state.responses = {
    get(path) {
      assert.equal(path, approvalPath);
      const { runId } = state.requests.at(-1).args[1].params;
      if (path === failedPath || runId === failedPath) throw new Error('Fixture unavailable');
      return [runId === secondPreview.runId ? secondPreview : preview];
    },
  };
  const Panel = load('features/research-workspace/ResearchToolActivity.tsx').ResearchToolActivity;
  const root = createRoot(document.getElementById('root'));
  const client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity }, mutations: { gcTime: Infinity } } });
  const session = {
    id: 'session', status: 'paused', revision: 1,
    runtimePending: [
      ...(waitingForApproval ? [{ runId: 'run', memberId: 'member', state: 'waiting_approval' }] : []),
      ...(secondApproval ? [{ runId: secondPreview.runId, memberId: 'second-member', state: 'waiting_approval' }] : []),
    ],
  };
  const requests = () => state.requests.map(({ method, args: [path, options] }) => [method, path, structuredClone(options?.params)]);
  try {
    await React.act(async () => root.render(React.createElement(QueryClientProvider, { client },
      React.createElement(Panel, { session, readOnly }))));
    await check({ document, requests, recover() { failedPath = null; } });
  } finally {
    await React.act(async () => root.unmount());
    client.clear();
    dom.window.close();
    for (const key of ['window', 'document', 'IS_REACT_ACT_ENVIRONMENT']) delete globalThis[key];
  }
}

const runsGet = ['get', runPath, { sessionId: 'session' }];
const approvalsGet = ['get', approvalPath, { runId: 'run' }];

async function retry({ document, recover }, message, label) {
  const alert = await waitFor(() => document.querySelector('[role="alert"]'), message);
  assert.match(alert.textContent, message);
  const button = [...document.querySelectorAll('button')].find(node => node.textContent === label);
  assert.ok(button, label);
  recover();
  await React.act(async () => button.click());
}

test('an archived session with no pending work can retry its failed run list', async () => {
  await withPanel({ failedPath: runPath, readOnly: true }, async context => {
    await retry(context, /Could not load saved runs/, 'Retry saved runs');
    await waitFor(() => context.document.querySelector('summary'), 'saved run returns after retry');
    assert.match(context.document.querySelector('summary').textContent, /Saved run/);
    assert.equal(context.document.querySelector('[role="alert"]'), null);
    assert.deepEqual(context.requests(), [runsGet, runsGet]);
  });
});

test('retrying approval previews preserves saved runs and only repeats the preview GET', async () => {
  await withPanel({ waitingForApproval: true, failedPath: approvalPath }, async context => {
    const saved = await waitFor(() => context.document.querySelector('details'), 'existing saved run appears');
    saved.open = true;
    await retry(context, /Could not load approval previews/, 'Retry approval previews');
    await waitFor(() => context.document.body.textContent.includes('Review draft note'), 'approval preview returns after retry');
    assert.equal(context.document.querySelector('details'), saved);
    assert.equal(saved.open, true);
    assert.equal(context.document.querySelector('[role="alert"]'), null);
    assert.deepEqual(context.requests().slice(0, 2).map(request => request[1]).sort(), [runPath, approvalPath].sort());
    assert.deepEqual(context.requests().slice(2), [approvalsGet]);
  });
});

test('retrying one of two approval previews keeps the successful preview and only repeats the failed GET', async () => {
  await withPanel({ waitingForApproval: true, secondApproval: true, failedPath: secondPreview.runId }, async context => {
    const { document, requests } = context;
    const findPreview = ({ descriptor }) => [...document.querySelectorAll('h3')].find(node => node.textContent === descriptor.name);
    const saved = await waitFor(() => document.querySelector('details'), 'saved run appears');
    saved.open = true;
    await waitFor(() => document.querySelector('[role="alert"]'), 'failed preview is reported');
    const visiblePreview = findPreview(preview);
    assert.equal(findPreview(secondPreview), undefined);
    const initialRequests = requests();
    const secondGet = ['get', approvalPath, { runId: secondPreview.runId }];
    assert.deepEqual(initialRequests.filter(([, path]) => path === runPath), [runsGet]);
    assert.deepEqual(initialRequests.filter(([, path]) => path === approvalPath), [approvalsGet, secondGet]);

    await retry(context, /Could not load approval previews/, 'Retry approval previews');
    await waitFor(() => findPreview(secondPreview), 'failed preview returns after retry');
    assert.deepEqual(requests().slice(initialRequests.length), [secondGet]);
    assert.ok(visiblePreview, 'the successful preview was visible before retry');
    assert.equal(findPreview(preview), visiblePreview);
    assert.equal(document.querySelector('details'), saved);
    assert.equal(saved.open, true);
    assert.equal(document.querySelector('[role="alert"]'), null);
  });
});
