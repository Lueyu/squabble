const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLFormElement', 'HTMLTextAreaElement', 'Element', 'Node', 'NodeFilter', 'CustomEvent', 'Event', 'MutationObserver', 'getComputedStyle']) {
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: dom.window[key] });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = require('react');
const { createRoot } = require('react-dom/client');
const { MemoryRouter, useLocation } = require('react-router-dom');
const { QueryClient, QueryClientProvider } = require('@tanstack/react-query');
const fixture = require('./simple-test-loader.cjs');
const flush = () => React.act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
async function waitFor(predicate, label) {
  const end = Date.now() + 2500;
  while (!predicate() && Date.now() < end) await flush();
  assert.ok(predicate(), label);
}
const accounts = [{ id: 'account-a', name: 'Alpha account', status: 'running' }, { id: 'account-b', name: 'Beta account', status: 'paused' }];
function projection(id) {
  return { runtime: { accounts, accountId: id ?? null, accountName: accounts.find(item => item.id === id)?.name ?? null,
    selectionRequired: !id, accountKind: 'paper', revision: 1, confirmedAt: '2026-11-09T00:00:00Z',
    monitoringStatus: id === 'account-b' ? 'paused' : 'running', monitoringReason: id ? null : 'ACCOUNT_SELECTION_REQUIRED',
    current: { strategyId: id ? `${id}-strategy` : null, strategyRevision: id ? 1 : null,
      rules: id ? [{ id: `${id}-rule`, label: `${id} rule`, value: '5%', status: 'active', effective: id === 'account-a', effectiveReason: id === 'account-b' ? 'paused' : null }] : [],
      positions: [], cash: [], valuationAsOf: null }, proposals: [], executions: [] },
    vibe: 'deskmate', pinned: null, pendingCount: 0, episodes: [], visibleTaps: [], progress: { runningCount: 0, gapCount: 0 },
    report: null, deferredQuestions: [], sourcesAvailable: false, userMessages: [], notifications: [] };
}
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
test('channel account selection isolates queries and ignores a late response from the previously chosen account', async () => {
  const f = fixture({ realQuery: true });
  const requests = [], alpha = deferred();
  const api = f.load('api/channel.ts');
  api.fetchChannel = async id => { requests.push(id); return id === 'account-a' ? alpha.promise : projection(id); };
  const select = f.load('components/ui/select.tsx');
  select.Select = ({ value, onValueChange, children }) => React.createElement('select', { value, onChange: event => onValueChange(event.target.value), 'aria-label': 'Simulation account' }, children);
  select.SelectTrigger = () => null;
  select.SelectValue = () => null;
  select.SelectContent = ({ children }) => React.createElement(React.Fragment, null, children);
  select.SelectItem = ({ children, value, disabled }) => React.createElement('option', { value, disabled }, children);
  const sheet = f.load('components/ui/sheet.tsx');
  sheet.Sheet = ({ children, open }) => open ? React.createElement('div', null, children) : null;
  for (const name of ['SheetContent', 'SheetHeader', 'SheetTitle', 'SheetDescription']) sheet[name] = ({ children }) => React.createElement('div', null, children);
  const Page = f.load('pages/Council/SimpleCouncilPage.tsx').default;
  function Location() { return React.createElement('output', null, useLocation().search); }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } } });
  const root = createRoot(document.getElementById('root'));
  try {
    await React.act(async () => root.render(React.createElement(QueryClientProvider, { client }, React.createElement(MemoryRouter,
      { initialEntries: ['/council?decisionId=kept-context'] }, React.createElement(Page), React.createElement(Location)))));
    await waitFor(() => document.querySelector('select[aria-label="Simulation account"]'), 'account selector renders');
    assert.match(document.body.textContent, /Choose a simulation account/);
    const choose = async id => React.act(async () => {
      const selector = document.querySelector('select[aria-label="Simulation account"]');
      selector.value = id; selector.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
    await choose('account-a');
    await waitFor(() => requests.includes('account-a'), 'Alpha request starts');
    await choose('account-b');
    await waitFor(() => requests.includes('account-b') && document.querySelector('[data-runtime-cell="current"]')?.textContent.includes('Paused'), 'Beta runtime renders');
    await React.act(async () => alpha.resolve(projection('account-a')));
    await flush();
    assert.match(document.querySelector('[data-runtime-cell="current"]').textContent, /Paused/);
    assert.doesNotMatch(document.querySelector('[data-runtime-cell="current"]').textContent, /account-a rule/);
    assert.equal(client.getQueryData(['channel', 'account-a']).runtime.accountId, 'account-a');
    assert.equal(client.getQueryData(['channel', 'account-b']).runtime.accountId, 'account-b');
    assert.match(document.querySelector('output').textContent, /accountId=account-b/);
    assert.match(document.querySelector('output').textContent, /decisionId=kept-context/);
    assert.equal(f.state.requests.length, 0, 'changing account does not submit any mutation or research');
  } finally {
    await React.act(async () => root.unmount());
    client.clear();
  }
});
