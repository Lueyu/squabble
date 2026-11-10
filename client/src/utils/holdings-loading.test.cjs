const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLFormElement', 'HTMLInputElement', 'Element', 'Node', 'Event', 'MutationObserver', 'DocumentFragment']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key], writable: true });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
const React = require('react');
const { createRoot } = require('react-dom/client');
const { MemoryRouter } = require('react-router-dom');
const fixture = require('./simple-test-loader.cjs');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const holding = ticker => ({ id: ticker, ticker, company: `${ticker} saved company`, shares: '2', buyPrice: '10', currentPrice: '12',
  market: 'US', currency: 'USD', groupId: null, rating: null, action: null, updatedAt: '2026-11-10T00:00:00Z' });
const overview = { totalMv: '24', totalPl: '4', baseCurrency: 'USD' };

async function mount(setup, run) {
  const f = fixture(), api = f.load('api/index.ts'), subscriptions = [];
  Object.assign(api, { fetchHoldings: async () => [holding('FICT')], fetchGroups: async () => [],
    fetchCashAccounts: async () => [], fetchDashboard: async () => overview });
  f.load('hooks/use-market-quotes.ts').useMarketQuotes = tickers => {
    subscriptions.push([...tickers]);
    return { quotes: {}, marketStatus: { US: 'closed', HK: 'closed', CN: 'closed' }, marketErrors: {}, lastUpdated: null, refresh() {} };
  };
  setup(api);
  const Page = f.load('pages/Holdings/HoldingsPage.tsx').default;
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  try {
    const started = performance.now();
    await React.act(async () => root.render(React.createElement(MemoryRouter, null, React.createElement(Page))));
    await run({ host, subscriptions, firstRenderMs: performance.now() - started,
      update: async () => React.act(async () => window.dispatchEvent(new Event('portfolio-updated'))),
      refresh: async () => React.act(async () => [...host.querySelectorAll('button')].find(button => button.textContent === 'ui.tx.refresh').click()) });
  } finally { await React.act(async () => root.unmount()); host.remove(); }
}

test('saved holdings render and subscribe to quotes while all supplemental requests remain pending', async t => {
  const groups = deferred(), cash = deferred(), dashboard = deferred();
  await mount(api => Object.assign(api, { fetchGroups: () => groups.promise, fetchCashAccounts: () => cash.promise,
    fetchDashboard: () => dashboard.promise }), async ({ host, subscriptions, firstRenderMs }) => {
    assert.match(host.textContent, /FICT saved company/, 'saved rows must not wait for dashboard quote/FX work');
    assert.ok(subscriptions.some(tickers => tickers.includes('FICT')), 'background quotes begin as soon as holdings arrive');
    assert.doesNotMatch(host.textContent, /\$0\.00/, 'a pending aggregate is unknown, not a zero portfolio');
    t.diagnostic(`Saved row present after ${Math.round(firstRenderMs)} ms of React rendering with dashboard, cash and groups still unresolved (fictional fixture; excludes module loading).`);
    await React.act(async () => { groups.resolve([]); cash.resolve([]); dashboard.resolve(overview); });
    assert.match(host.textContent, /FICT saved company/);
  });
});

test('a failed background aggregate refresh retains the previous total and visible positions', async () => {
  let calls = 0;
  await mount(api => { api.fetchDashboard = () => ++calls === 1 ? Promise.resolve(overview) : Promise.reject(new Error('Fictional FX timeout')); }, async ({ host, refresh }) => {
    assert.match(host.textContent, /\$24\.00 · ui\.holdings\.floatingPl \$4\.00/);
    await refresh();
    assert.match(host.textContent, /FICT saved company/);
    assert.match(host.textContent, /\$24\.00 · ui\.holdings\.floatingPl \$4\.00/);
    assert.equal(host.querySelector('[role="alert"]'), null, 'background aggregate failure must not mark the holdings request as failed');
  });
});

test('refresh keeps visible holdings while loading and after a failed holdings request', async () => {
  const refresh = deferred(); let calls = 0;
  await mount(api => { api.fetchHoldings = () => ++calls === 1 ? Promise.resolve([holding('KEPT')]) : refresh.promise; }, async ({ host, refresh: click }) => {
    assert.match(host.textContent, /KEPT saved company/);
    await click();
    assert.match(host.textContent, /KEPT saved company/, 'refresh must not replace existing rows with skeletons');
    await React.act(async () => refresh.reject(new Error('Fictional unavailable ledger')));
    assert.match(host.textContent, /KEPT saved company/, 'a failed refresh must retain the saved result');
    assert.ok(host.querySelector('[role="alert"]'), 'the refresh failure stays visible alongside the rows');
  });
});

test('a late older request cannot replace holdings from a newer portfolio update', async () => {
  const older = deferred(); let calls = 0;
  await mount(api => { api.fetchHoldings = () => ++calls === 1 ? older.promise : Promise.resolve([holding('LATEST')]); }, async ({ host, update }) => {
    await update();
    assert.match(host.textContent, /LATEST saved company/);
    await React.act(async () => older.resolve([holding('OLD')]));
    assert.match(host.textContent, /LATEST saved company/);
    assert.doesNotMatch(host.textContent, /OLD saved company/);
  });
});
