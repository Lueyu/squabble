const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLFormElement', 'FormData', 'Element', 'Node', 'Event']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key], writable: true });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = require('react');
const { createRoot } = require('react-dom/client');
const { MemoryRouter, Routes, Route, useLocation, useNavigate } = require('react-router-dom');
const fixture = require('./simple-test-loader.cjs');

async function scenario(page, path, setup, run) {
  const f = fixture();
  const dialog = f.load('components/ui/dialog.tsx');
  dialog.Dialog = ({ open, onOpenChange, children }) => open ? React.createElement('section', { role: 'dialog' }, children, React.createElement('button', { onClick: () => onOpenChange(false) }, 'Close layer')) : null;
  for (const key of ['DialogContent', 'DialogHeader', 'DialogTitle', 'DialogDescription']) dialog[key] = ({ children }) => React.createElement('div', null, children);
  const sheet = f.load('components/ui/sheet.tsx');
  sheet.Sheet = ({ open, children }) => open ? React.createElement('div', null, children) : null;
  for (const key of ['SheetContent', 'SheetHeader', 'SheetTitle', 'SheetDescription']) sheet[key] = ({ children }) => React.createElement('div', null, children);
  setup(f);
  const Page = f.load(page).default;
  const Council = f.load('pages/Council/SimpleCouncilPage.tsx').default;
  let navigate;
  function Location() { navigate = useNavigate(); const value = useLocation(); return React.createElement('output', null, value.pathname + value.search); }
  const root = createRoot(document.getElementById('root'));
  const click = async text => {
    const button = [...document.querySelectorAll('button')].find(item => item.textContent === text);
    assert.ok(button, 'Missing button: ' + text);
    assert.equal(button.disabled, false);
    await React.act(async () => button.click());
  };
  const type = async value => React.act(async () => {
    const field = document.querySelector('textarea');
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(field, value);
    field.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  try {
    await React.act(async () => root.render(React.createElement(MemoryRouter, { initialEntries: [path] }, React.createElement(Routes, null,
      React.createElement(Route, { path: '/council', element: React.createElement(Council) }),
      React.createElement(Route, { path: '*', element: React.createElement(Page) })), React.createElement(Location))));
    await run({ f, click, type, location: () => document.querySelector('output').textContent, go: async value => React.act(async () => navigate(value)) });
  } finally { await React.act(async () => root.unmount()); }
}

test('trading daily and exact research layers close back to the selected report date', async () => {
  await scenario('pages/Analysis/DailyReportPage.tsx', '/daily?date=2026-11-09', f => {
    f.state.queries.set('daily-workspace', { data: { date: '2026-11-09', readAt: '2026-11-10T00:00:00Z', accounts: [{
      id: 'fictional', name: 'Fictional account', status: 'paused', dailyPnlUsd: null, equityUsd: 100, cashUsd: 20, openingEquityUsd: null, gaps: ['DAILY_BASELINE_MISSING'], notExecuted: [],
      trades: [{ id: 'fill', ticker: 'FICT', side: 'buy', quantity: 2, price: 30, fee: 1, currency: 'HKD', feeCurrency: 'USD', executedAt: '2026-11-09T05:00:00Z' }],
    }], personal: { returnBasis: { pnlUsd: null, endSnapshot: null }, transactions: [], gaps: [] }, reports: { initial: { documentId: 'frozen-version', summary: 'Saved original view' } } } });
    f.state.queries.set(JSON.stringify(['research-document', 'frozen-version']), { data: { version: { title: 'Exact original version', version: 4, createdAt: '2026-11-09T00:00:00Z', status: 'published', sections: [{ id: 'summary', title: 'Finding', content: 'Original evidence preserved' }], snapshot: { source: 'fictional evidence' } } } });
  }, async ({ click, location }) => {
    await click('Read trading daily');
    assert.match(document.querySelector('[role="dialog"]').textContent, /30 HKD/);
    assert.match(document.querySelector('[role="dialog"]').textContent, /1 USD/);
    assert.match(document.querySelector('[role="dialog"]').textContent, /prior-day valuation is missing/);
    await click('Close layer');
    await click('Read research and evidence');
    assert.match(document.querySelector('[role="dialog"]').textContent, /Exact original version/);
    await click('Close layer');
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.equal(location(), '/daily?date=2026-11-09');
    assert.equal(document.querySelector('input[type="date"]').value, '2026-11-09');
  });
});

test('data processing details retain their list and health reads stored gaps', async () => {
  await scenario('pages/Workspace/DataCenterPage.tsx', '/data', f => {
    f.state.queries.set('integration-settings', { data: { financial: { available: true, provider: 'fixture' } } });
    f.state.queries.set('daily-workspace', { data: { personal: { gaps: ['Fictional missing valuation'], marketSessions: [] } } });
    f.state.queries.set('import-batches', { data: [{ id: 'batch', status: 'paused', revision: 2, updatedAt: '2026-11-10T00:00:00Z', images: [{ id: 'image', filename: 'fictional-input.png', status: 'recognized' }], rows: [{ id: 'row', ticker: 'FICT', sourceImageIds: ['image'], issues: [{ field: 'quantity', code: 'missing' }] }], receipts: [] }] });
    f.state.queries.set('data-archive-jobs', { data: { counts: { failed: 0 }, jobs: [] } });
    f.state.queries.set('model-connections', { data: [] });
  }, async ({ click }) => {
    await click('Processing records');
    await click('Inspect');
    assert.match(document.querySelector('[role="dialog"]').textContent, /fictional-input.png/);
    assert.match(document.querySelector('[role="dialog"]').textContent, /quantity: missing/);
    await click('Close layer');
    assert.equal(document.querySelector('[role="tab"][aria-selected="true"]').textContent, 'Processing records');
    await click('Health');
    assert.match(document.body.textContent, /Fictional missing valuation/);
    assert.doesNotMatch(document.body.textContent, /No gaps found/);
  });
});

test('memory preferences and submission records show real scope without inventing usage', async () => {
  await scenario('pages/Workspace/MemoryWorkspacePage.tsx', '/memory', f => {
    f.state.queries.set('memory-inventory', { data: { total: 0, memories: [], theses: [] } });
    f.state.queries.set('channel-memory', { data: { items: [{ id: 'pref', kind: 'user_stated_preference', exactUserQuote: 'Fictional preference quote', recordedAt: '2026-11-10T00:00:00Z' }] } });
    f.state.queries.set('memory-usage-sessions', { data: [{ id: 'saved-task', title: 'Fictional research', createdAt: '2026-11-10T00:00:00Z' }] });
    f.state.queries.set(JSON.stringify(['memory-usage-session', 'saved-task']), { data: { messages: [] } });
  }, async ({ click }) => {
    await click('Preferences and strategy scope');
    assert.match(document.body.textContent, /Fictional preference quote/);
    assert.match(document.body.textContent, /does not yet support version edits or exclusion/);
    await click('Memory submission records');
    await React.act(async () => {
      const select = document.querySelector('select'); select.value = 'saved-task';
      select.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
    assert.match(document.body.textContent, /No memory submission inventory was recorded/);
    assert.match(document.body.textContent, /not proof of model use/);
  });
});

test('legacy channel question links do not send and preserve an unsent channel draft', async () => {
  await scenario('pages/Analysis/ResearchWorkspacePage.tsx', '/council?question=Check%20concentration%20%26%20sources', () => {}, async ({ f, type, go, location }) => {
    assert.equal(location(), '/council?question=Check%20concentration%20%26%20sources');
    assert.equal(document.querySelector('#channel-question').value, 'Check concentration & sources');
    assert.equal(f.state.requests.length, 0, 'prefilling cannot dispatch a model or channel message');
    await type('My unsent revision');
    await go('/council?question=Another%20question');
    assert.equal(document.querySelector('#channel-question').value, 'My unsent revision');
    await type('');
    await go('/council?question=Third%20question');
    assert.equal(document.querySelector('#channel-question').value, 'Third question');
    assert.equal(f.state.requests.length, 0);
  });
});

test('overall research requires an explicit click and a failed request retries the same date and receipt', async () => {
  const calls = [];
  await scenario('pages/Analysis/DailyReportPage.tsx', '/daily?date=2026-11-09', f => {
    f.state.queries.set('daily-workspace', { data: { date: '2026-11-09', readAt: '2026-11-10T00:00:00Z', accounts: [],
      personal: { returnBasis: { pnlUsd: null, endSnapshot: null }, transactions: [], gaps: [] },
      reports: { initial: { documentId: 'original-personal', summary: 'Original personal research remains' } } } });
    f.state.queries.set('overall-daily-research', { data: { date: '2026-11-09', timezone: 'Asia/Shanghai', latest: null, reports: [] } });
    f.state.mutationFactory = options => {
      const [state, setState] = React.useState({ isPending: false, isError: false });
      return { ...state, mutate() {
        setState({ isPending: true, isError: false });
        void options.mutationFn().then(async result => {
          await options.onSuccess?.(result); setState({ isPending: false, isError: false });
        }).catch(error => setState({ isPending: false, isError: true, error }));
      } };
    };
    f.load('api/workspace.ts').startOverallDailyResearch = async input => {
      calls.push(structuredClone(input));
      if (calls.length === 1) throw Error('Uncertain response');
      const view = { date: input.date, timezone: 'Asia/Shanghai', latest: { sessionId: 'overall-session', status: 'completed', stage: 'completed', readAt: '2026-11-10T01:00:00Z', factsHash: 'frozen' },
        reports: [{ versionId: 'overall-version', sessionId: 'overall-session', title: 'Overall', createdAt: '2026-11-10T01:01:00Z', readAt: '2026-11-10T01:00:00Z', factsHash: 'frozen', content: 'All account outcomes are separately explained' }] };
      f.state.queries.set('overall-daily-research', { data: view, refetch: async () => ({ data: view }) }); return view;
    };
  }, async ({ click, location }) => {
    assert.equal(calls.length, 0);
    await click('Generate overall daily report');
    assert.match(document.body.textContent, /request is unconfirmed/);
    await click('Generate overall daily report');
    assert.deepEqual(calls[0], calls[1]); assert.equal(calls[0].date, '2026-11-09');
    assert.match(document.body.textContent, /All account outcomes are separately explained/);
    assert.match(document.body.textContent, /Original personal research remains/);
    assert.equal(location(), '/daily?date=2026-11-09');
    await click('Inspect progress and recovery');
    assert.equal(location(), '/daily?date=2026-11-09&session=overall-session');
    assert.equal(document.querySelector('#quick-question'), null, 'a fixed overall task cannot mutate its frozen question');
    assert.equal([...document.querySelectorAll('button')].some(button => button.textContent === 'Recent discussions' || button.getAttribute('aria-label') === 'New discussion'), false);
    await click('Close layer');
    assert.equal(location(), '/daily?date=2026-11-09');
  });
});

test('idle, failed and paused overall tasks expose explicit recovery with stable retry and preserved report date', async () => {
  for (const status of ['idle', 'failed', 'paused']) {
    const calls = [];
    await scenario('pages/Analysis/DailyReportPage.tsx', '/daily?date=2026-11-09', f => {
      f.state.queries.set('daily-workspace', { data: { date: '2026-11-09', readAt: '2026-11-10T00:00:00Z', accounts: [],
        personal: { returnBasis: { pnlUsd: null, endSnapshot: null }, transactions: [], gaps: [] }, reports: {} } });
      const view = { date: '2026-11-09', timezone: 'Asia/Shanghai', reports: [], latest: {
        sessionId: `saved-${status}`, status, stage: status === 'paused' ? 'waiting' : 'independent', readAt: '2026-11-10T00:00:00Z', factsHash: 'original-frozen' } };
      f.state.queries.set('overall-daily-research', { data: view });
      f.state.mutationFactory = options => {
        const [state, setState] = React.useState({ isPending: false, isError: false });
        return { ...state, mutate() {
          setState({ isPending: true, isError: false });
          void options.mutationFn().then(async result => {
            await options.onSuccess?.(result); setState({ isPending: false, isError: false });
          }).catch(error => setState({ isPending: false, isError: true, error }));
        } };
      };
      const api = f.load('api/research-conversations.ts');
      api.fetchResearchConversation = async id => { assert.equal(id, view.latest.sessionId); return { revision: 8 }; };
      api.resumeDailyReport = async (id, input) => {
        calls.push({ id, input: structuredClone(input) });
        if (calls.length === 1) throw Error('Fictional unconfirmed continuation');
        f.state.queries.set('overall-daily-research', { data: { ...view, latest: { ...view.latest, status: 'running' } } });
        return { id, revision: 9 };
      };
    }, async ({ click, location, go }) => {
      assert.equal(calls.length, 0, 'mounting recovery never dispatches');
      assert.match(document.body.textContent, /same task budget/);
      await click('Complete saved daily report');
      assert.match(document.body.textContent, /Could not resume/);
      await click('Complete saved daily report');
      assert.deepEqual(calls[0], calls[1]); assert.equal(calls[0].input.expectedRevision, 8);
      assert.equal(location(), '/daily?date=2026-11-09');
      await go(location()); // The static query fixture needs a render after its saved read changes.
      assert.match(document.body.textContent, /Overall research in progress/);
      assert.equal([...document.querySelectorAll('button')].some(button => button.textContent === 'Complete saved daily report'), false);
    });
  }
});
