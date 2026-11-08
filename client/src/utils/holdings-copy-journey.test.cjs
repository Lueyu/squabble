const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key], writable: true });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const { MemoryRouter, useLocation, useNavigate } = require('react-router-dom');
const fixture = require('./simple-test-loader.cjs');

const preview = { id: 'fictional-preview', expiresAt: '2099-01-01T00:00:00Z', seed: {
  capturedAt: '2026-11-08T00:00:00Z', positions: [{ ticker: 'FICT', shares: '2', currency: 'USD' }],
  cash: [], gaps: [], initialEquityUsd: '100',
} };
const account = id => ({ account: id ? { id } : null, policy: id ? { status: 'observing', revision: 1 } : null,
  currentStrategy: null, limits: {}, budget: {}, cycles: [], legacyAccounts: [], actions: [], holdings: [], constraints: [], waitingReasons: [] });
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function mount(options, run) {
  const f = fixture(), calls = [], host = document.createElement('div'); document.body.append(host);
  let location, navigate;
  const query = { data: options.loading ? undefined : account(options.accountId), isPending: !!options.loading, refetch: async () => {} };
  f.state.queries.set('ai-investment', query);
  f.state.queries.set('investment-strategies', { data: { current: null, drafts: [], history: [] } });
  const api = f.load('api/ai-investment.ts');
  for (const name of ['previewAiInvestment', 'startAiInvestment', 'restartAiInvestment', 'applyInvestmentStrategy']) {
    api[name] = async input => { calls.push({ name, input }); return options[name] ? options[name](input) : name === 'previewAiInvestment' ? preview : {}; };
  }
  const Page = f.load('pages/Paper/AiInvestmentPage.tsx').default;
  function Route() { location = useLocation(); navigate = useNavigate(); return React.createElement(Page); }
  const root = createRoot(host);
  const tree = () => React.createElement(options.strict ? React.StrictMode : React.Fragment, null,
    React.createElement(MemoryRouter, { initialEntries: [options.path ?? '/paper?seedReal=1&investmentStrategyId=draft-one&from=holdings#investment-strategy'] }, React.createElement(Route)));
  const button = text => [...host.querySelectorAll('button')].find(node => node.textContent === text);
  const click = async text => { const node = button(text); assert.ok(node, `button ${text} exists`); await act(async () => node.click()); };
  try {
    await act(async () => root.render(tree()));
    await run({ calls, query, host, button, click, location: () => location, navigate: async path => act(async () => navigate(path)),
      refresh: async () => act(async () => root.render(tree())) });
  } finally { await act(async () => root.unmount()); host.remove(); }
}

test('holdings link waits for the account, previews once under StrictMode, and only creates after confirmation', async () => {
  const waiting = deferred();
  await mount({ loading: true, strict: true, previewAiInvestment: () => waiting.promise }, async f => {
    assert.equal(f.calls.length, 0);
    f.query.isPending = false; f.query.data = account(null); await f.refresh();
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0].name, 'previewAiInvestment');
    assert.equal(f.calls[0].input.origin, 'holdings');
    assert.match(f.host.textContent, /Preparing your holdings preview/);
    await act(async () => waiting.resolve(preview));
    assert.match(f.host.textContent, /Confirm the simulation starting point/);
    assert.equal(f.calls.length, 1, 'navigation never creates or applies a strategy');
    await f.click('Copy and observe');
    assert.equal(f.calls[1].name, 'startAiInvestment');
    assert.equal(new URLSearchParams(f.location().search).get('seedReal'), null);
    assert.equal(new URLSearchParams(f.location().search).get('investmentStrategyId'), 'draft-one');
    assert.equal(new URLSearchParams(f.location().search).get('from'), 'holdings');
    assert.equal(f.location().hash, '#investment-strategy');
  });
});

test('existing simulations reveal replacement confirmation and retain the account captured before a polling switch', async () => {
  const waiting = deferred();
  await mount({ accountId: 'account-original', previewAiInvestment: () => waiting.promise }, async f => {
    assert.equal(f.calls.length, 1);
    f.query.data = account('account-newer'); await f.refresh();
    await act(async () => waiting.resolve(preview));
    assert.match(f.host.textContent, /archived with its trades preserved/);
    assert.equal(f.calls.length, 1);
    await f.click('Copy and observe');
    assert.equal(f.calls[1].name, 'restartAiInvestment');
    assert.equal(f.calls[1].input.expectedAccountId, 'account-original');
  });
});

test('preview failures remain visible with an explicit retry and preserve the navigation intent', async () => {
  let attempt = 0;
  await mount({ accountId: 'account-original', previewAiInvestment: async () => { if (++attempt === 1) throw new Error('Timeout'); return preview; } }, async f => {
    assert.match(f.host.querySelector('[role="alert"]').textContent, /holdings preview/);
    assert.equal(new URLSearchParams(f.location().search).get('seedReal'), '1');
    await f.refresh(); assert.equal(f.calls.length, 1, 'polling does not retry by itself');
    await f.click('Retry preview');
    assert.match(f.host.textContent, /Confirm the simulation starting point/);
    assert.equal(f.calls.length, 2); assert.equal(f.calls[0].input.requestKey, f.calls[1].input.requestKey);
    assert.equal(f.host.querySelector('[role="alert"]'), null);
    await f.click('Cancel copy');
    assert.doesNotMatch(f.host.textContent, /Confirm the simulation starting point/);
    assert.equal(new URLSearchParams(f.location().search).get('seedReal'), null);
    assert.equal(new URLSearchParams(f.location().search).get('investmentStrategyId'), 'draft-one');
    assert.equal(f.calls.length, 2);
  });
});

test('canceling an unfinished preview ignores its late result and preserves unrelated URL state', async () => {
  const waiting = deferred();
  await mount({ accountId: 'account-original', previewAiInvestment: () => waiting.promise }, async f => {
    assert.equal(f.calls.length, 1);
    await f.click('Cancel copy');
    await act(async () => waiting.resolve(preview));
    assert.doesNotMatch(f.host.textContent, /Confirm the simulation starting point|Preparing your holdings preview/);
    assert.equal(new URLSearchParams(f.location().search).get('seedReal'), null);
    assert.equal(new URLSearchParams(f.location().search).get('from'), 'holdings');
    assert.equal(f.location().hash, '#investment-strategy');
    assert.equal(f.calls.length, 1);
  });
});

test('a mounted account honors a later holdings navigation without previewing ordinary visits', async () => {
  await mount({ accountId: 'account-original', path: '/paper?from=channel' }, async f => {
    assert.equal(f.calls.length, 0);
    await f.navigate('/paper?seedReal=1&from=holdings');
    assert.equal(f.calls.length, 1);
    assert.match(f.host.textContent, /Confirm the simulation starting point/);
  });
});

test('StrictMode effect replay on an already loaded account starts only one pending preview', async () => {
  const waiting = deferred();
  await mount({ strict: true, accountId: 'account-original', previewAiInvestment: () => waiting.promise }, async f => {
    assert.equal(f.calls.length, 1);
    await act(async () => waiting.resolve(preview));
    assert.match(f.host.textContent, /Confirm the simulation starting point/);
    assert.equal(f.calls.length, 1);
  });
});

test('an unconfirmed replacement keeps the preview and URL intent until a successful explicit retry', async () => {
  const waiting = deferred(); let attempts = 0;
  await mount({ accountId: 'account-original', restartAiInvestment: () => ++attempts === 1 ? waiting.promise : {} }, async f => {
    await f.click('Copy and observe');
    assert.equal(f.button('Cancel copy').disabled, true, 'confirmation cannot be canceled while its write is pending');
    await act(async () => waiting.reject(new Error('Unconfirmed response')));
    assert.match(f.host.textContent, /Creation is unconfirmed/);
    assert.equal(new URLSearchParams(f.location().search).get('seedReal'), '1');
    await f.click('Copy and observe');
    assert.equal(f.calls.length, 3);
    assert.equal(f.calls[1].input.requestKey, f.calls[2].input.requestKey);
    assert.equal(new URLSearchParams(f.location().search).get('seedReal'), null);
    assert.equal(new URLSearchParams(f.location().search).get('investmentStrategyId'), 'draft-one');
  });
});

test('only holdings preview requests allow extra time for multi-position quotes', async () => {
  const f = fixture(), api = f.load('api/ai-investment.ts');
  await api.previewAiInvestment({ origin: 'holdings', requestKey: 'holdings' });
  await api.previewAiInvestment({ origin: 'cash', cash: { amount: 100, currency: 'USD' }, requestKey: 'cash' });
  assert.equal(f.state.requests[0].args[2]?.timeout, 60000);
  assert.equal(f.state.requests[1].args[2]?.timeout, undefined);
});
