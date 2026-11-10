const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'Event', 'MouseEvent']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key], writable: true });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = require('react');
const { createRoot } = require('react-dom/client');
const { MemoryRouter, Routes, Route, useLocation, useParams } = require('react-router-dom');
const { QueryClient, QueryClientProvider } = require('@tanstack/react-query');
const fixture = require('./simple-test-loader.cjs');

function setup(options) {
  const f = fixture(options);
  const dialog = f.load('components/ui/dialog.tsx');
  dialog.Dialog = ({ open, children }) => open ? React.createElement('section', { role: 'dialog' }, children) : null;
  for (const name of ['DialogContent', 'DialogHeader', 'DialogTitle', 'DialogDescription']) dialog[name] = ({ children }) => React.createElement('div', null, children);
  f.state.mutationFactory = options => {
    const [state, setState] = React.useState({ isPending: false, isError: false });
    return { ...state, mutate() {
      setState({ isPending: true, isError: false });
      void options.mutationFn().then(async result => { await options.onSuccess?.(result); setState({ isPending: false, isError: false }); })
        .catch(error => { options.onError?.(error); setState({ isPending: false, isError: true, error }); });
    } };
  };
  return f;
}
async function click(text) {
  const button = [...document.querySelectorAll('button')].find(item => item.textContent.trim() === text || item.getAttribute('aria-label') === text);
  assert.ok(button, 'Missing button: ' + text);
  await React.act(async () => button.click());
}
async function follow(link) {
  await React.act(async () => link.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })));
}
function Location() { const value = useLocation(); return React.createElement('output', null, value.pathname + value.search); }

test('a card deletion needs one confirmation, supports legacy revisions, and stays on the list with retained history', async () => {
  for (const revision of [3, null]) {
    const f = setup({ realQuery: true }); const calls = [];
    const account = { id: 'fixture-account', name: 'Fictional companion', policyRevision: revision, status: 'paused', strategyCount: 0, equityUsd: '10000', createdAt: '2026-11-10T00:00:00Z' };
    let rows = [account];
    const api = f.load('api/portfolio-workspace.ts').portfolioWorkspaceApi;
    api.accounts = async () => rows;
    api.archive = async (id, input) => {
      calls.push({ id, input });
      if (revision === 3 && calls.length === 1) throw new Error('Fictional network interruption');
      rows = [{ ...account, status: 'archived' }];
      return { accountId: id, status: 'archived', policyRevision: revision == null ? null : revision + 1 };
    };
    const Page = f.load('pages/Paper/SimulationAccountsPage.tsx').default;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity }, mutations: { retry: false, gcTime: Infinity } } });
    client.setQueryData(['portfolio-accounts'], rows);
    const root = createRoot(document.getElementById('root'));
    try {
      await React.act(async () => root.render(React.createElement(QueryClientProvider, { client }, React.createElement(MemoryRouter, { initialEntries: ['/paper'] }, React.createElement(Page), React.createElement(Location)))));
      await click('Delete Fictional companion');
      assert.match(document.querySelector('[role="dialog"]').textContent, /ledger and report history/);
      assert.equal(calls.length, 0);
      await click('Cancel'); assert.equal(document.querySelector('[role="dialog"]'), null);
      await click('Delete Fictional companion'); await click('Confirm deletion');
      await React.act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
      if (revision === 3) {
        assert.match(document.querySelector('[role="alert"]').textContent, /unconfirmed/);
        assert.equal(document.querySelectorAll('.companion-account-card').length, 1, 'a failure keeps the account visible');
        await click('Confirm deletion');
        await React.act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
        assert.deepEqual(calls[0], calls[1], 'retry keeps the original account and receipt key');
      }
      assert.equal(calls.length, revision === 3 ? 2 : 1); assert.equal(calls[0].id, account.id); assert.equal(calls[0].input.expectedPolicyRevision, revision);
      assert.equal(document.querySelector('output').textContent, '/paper');
      assert.equal(document.querySelectorAll('.companion-account-card').length, 0);
      const archived = [...document.querySelectorAll('button')].find(button => button.textContent.startsWith('Archived'));
      await React.act(async () => archived.click());
      assert.match(document.querySelector('.companion-account-card').textContent, /Fictional companion/);
      assert.equal(document.querySelector('button[aria-label="Delete Fictional companion"]'), null);
    } finally { await React.act(async () => root.unmount()); client.clear(); }
  }
});

test('history is a concise immutable-version list and returns to its original date and source', async () => {
  const f = setup();
  f.state.queries.set('report-history', { data: { items: [{ id: 'original-version', title: 'Saved original report', version: 2, kind: 'council', category: 'daily', source: { type: 'council', id: 'old-session' }, createdAt: '2026-11-09T00:00:00Z' }], total: 1 }, isPending: false });
  f.state.queries.set(JSON.stringify(['research-document', 'original-version']), { data: { version: { id: 'original-version', title: 'Saved original report', createdAt: '2026-11-09T00:00:00Z', sections: [{ id: 'summary', title: 'Original finding', content: 'This is the exact old version.' }], content: 'This is the exact old version.' } } });
  const Page = f.load('pages/Analysis/ReportHistoryPage.tsx').default;
  const Reader = f.load('pages/Analysis/SimpleReportReader.tsx').default;
  function Read() { return React.createElement(Reader, { versionId: useParams().versionId }); }
  const root = createRoot(document.getElementById('root'));
  const original = '/analysis?date=2026-11-09&source=council';
  try {
    await React.act(async () => root.render(React.createElement(MemoryRouter, { initialEntries: [original] }, React.createElement(Routes, null,
      React.createElement(Route, { path: '/analysis', element: React.createElement(Page) }),
      React.createElement(Route, { path: '/analysis/reports/:versionId', element: React.createElement(Read) })), React.createElement(Location))));
    assert.equal(document.querySelectorAll('select').length, 0);
    assert.equal(document.querySelectorAll('.workspace-v4-stats').length, 0);
    assert.doesNotMatch(document.body.textContent, /Update analysis|Generate overall|Continue discussion/);
    await follow([...document.querySelectorAll('a')].find(link => link.textContent.includes('Saved original report')));
    assert.match(document.querySelector('output').textContent, /^\/analysis\/reports\/original-version\?/);
    assert.match(document.body.textContent, /This is the exact old version/);
    await follow(document.querySelector('.report-back-link'));
    assert.equal(document.querySelector('output').textContent, original);
  } finally { await React.act(async () => root.unmount()); }
});

test('the daily overview has neither embedded generic history nor older overall report versions', () => {
  const f = setup();
  f.state.queries.set('daily-workspace', { data: { date: '2026-11-09', accounts: [], personal: { returnBasis: { pnlUsd: null, endSnapshot: null }, transactions: [], gaps: [] }, reports: {} } });
  f.state.queries.set('overall-daily-research', { data: { reports: [{ versionId: 'latest', title: 'Latest report', content: 'Current published finding' }, { versionId: 'older', title: 'Earlier overall report', content: 'Old finding' }] } });
  const Page = f.load('pages/Analysis/DailyReportPage.tsx').default;
  const html = f.render(Page);
  assert.doesNotMatch(html, /id="report-history"|Earlier overall report|Overall report history for this day/);
});
