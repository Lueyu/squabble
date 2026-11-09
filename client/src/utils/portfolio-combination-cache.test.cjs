const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLFormElement', 'Element', 'Node', 'NodeFilter', 'CustomEvent', 'Event', 'MutationObserver', 'getComputedStyle']) {
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: dom.window[key] });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
const React = require('react');
const { createRoot } = require('react-dom/client');
const { MemoryRouter, Routes, Route } = require('react-router-dom');
const { QueryClient, QueryClientProvider } = require('@tanstack/react-query');
const fixture = require('./simple-test-loader.cjs');
const key = ['portfolio-account', 'account-a'];
const button = label => [...document.querySelectorAll('button')].find(node => node.textContent === label);
const budget = () => document.querySelector('input[type="number"]');
const flush = () => React.act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
async function waitFor(predicate, message) {
  const deadline = Date.now() + 2000;
  while (!predicate() && Date.now() < deadline) await flush();
  assert.ok(predicate(), message);
}
async function fillBudget(value) {
  await React.act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(budget(), value);
    budget().dispatchEvent(new window.Event('input', { bubbles: true }));
  });
}
async function scenario(run) {
  const f = fixture({ realQuery: true });
  const strategy = { id: 'strategy-a', revision: 2, status: 'confirmed', content: { title: 'Reviewed idea', entries: [] }, sources: [], preview: { canConfirm: true } };
  const allocation = { strategyId: strategy.id, strategyRevision: 2, allocationPct: 60, enabled: true, snapshot: strategy };
  let server = { id: 'account-a', name: 'Chosen account', status: 'running', policyRevision: 7,
    investment: { account: { id: 'account-a' }, policy: { baseConfig: { timezone: 'Asia/Shanghai' } }, limits: { maxPositionPct: 20 } },
    combination: { accountId: 'account-a', policyRevision: 7, cashFloorPct: 15, allocations: [allocation], draft: null } };
  const api = f.load('api/portfolio-workspace.ts').portfolioWorkspaceApi;
  const strategies = f.load('api/investment-strategies.ts').investmentStrategiesApi;
  api.account = async () => structuredClone(server);
  strategies.workspace = async () => ({ current: strategy, history: [], drafts: [] });
  strategies.get = async () => strategy;
  const writes = [];
  api.saveDraft = async (_id, input) => {
    writes.push(input);
    const draft = { allocations: input.allocations, expectedPolicyRevision: input.expectedPolicyRevision, updatedAt: new Date().toISOString() };
    server = { ...server, combination: { ...server.combination, draft } };
    return structuredClone(draft);
  };
  const dialog = f.load('components/ui/dialog.tsx');
  dialog.Dialog = ({ children, open }) => open ? React.createElement('div', null, children) : null;
  for (const name of ['DialogContent', 'DialogDescription', 'DialogHeader', 'DialogTitle']) dialog[name] = ({ children }) => React.createElement('div', null, children);
  const Page = f.load('features/investment-strategies/AccountStrategyCombinationPage.tsx').default;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity }, mutations: { retry: false, gcTime: Infinity } } });
  client.setQueryData(key, structuredClone(server));
  let root = createRoot(document.getElementById('root'));
  const mount = () => React.act(async () => root.render(React.createElement(QueryClientProvider, { client }, React.createElement(MemoryRouter,
    { initialEntries: ['/paper/account-a/strategies'] }, React.createElement(Routes, null, React.createElement(Route,
      { path: '/paper/:accountId/strategies', element: React.createElement(Page) }))))));
  const refresh = async () => {
    await React.act(async () => client.refetchQueries({ queryKey: key }));
    await flush();
  };
  const remoteDraft = (value, revision = 7) => {
    server = { ...server, policyRevision: revision, combination: { ...server.combination, policyRevision: revision,
      draft: { allocations: [{ ...allocation, allocationPct: value }], expectedPolicyRevision: revision, updatedAt: new Date().toISOString() } } };
  };
  try {
    await mount();
    await waitFor(() => budget()?.value === '60', 'initial budget renders');
    await run({ client, writes, remoteDraft, refresh, async reopen() {
      await React.act(async () => root.unmount());
      root = createRoot(document.getElementById('root'));
      await mount();
      await flush();
    } });
  } finally {
    await React.act(async () => root.unmount());
    client.clear();
  }
}

test('a saved combination is available when the editor reopens from the account cache', () => scenario(async ({ client, writes, reopen }) => {
  await fillBudget('40');
  await React.act(async () => button('Save draft').click());
  await waitFor(() => document.body.textContent.includes('Combination draft saved'), 'save acknowledged');
  assert.equal(writes.length, 1);
  assert.equal(client.getQueryData(key).combination.draft?.allocations[0].allocationPct, 40);
  await reopen();
  assert.equal(budget().value, '40');
  assert.match(document.body.textContent, /Combination saved/);
}));

test('a clean mounted editor adopts a newer saved draft at the same policy revision', () => scenario(async ({ remoteDraft, refresh }) => {
  remoteDraft(40);
  await refresh();
  assert.equal(budget().value, '40');
  assert.match(document.body.textContent, /Combination saved/);
}));

test('refetching another saved draft preserves dirty local allocations', () => scenario(async ({ remoteDraft, refresh }) => {
  await fillBudget('35');
  const input = budget();
  remoteDraft(40);
  await refresh();
  assert.equal(budget(), input);
  assert.equal(budget().value, '35');
  assert.match(document.body.textContent, /Unsaved changes/);
}));

test('a policy revision change still requires explicit reload instead of replacing local edits', () => scenario(async ({ remoteDraft, refresh }) => {
  await fillBudget('35');
  remoteDraft(40, 8);
  await refresh();
  assert.equal(budget().value, '35');
  assert.ok(button('Save draft').disabled);
  assert.match(document.body.textContent, /This account policy changed/);
}));
