const { test } = require('node:test');
const assert = require('node:assert/strict');
const React = require('react');
const { createRoot } = require('react-dom/client');
const { MemoryRouter, Routes, Route, useLocation } = require('react-router-dom');
const { JSDOM } = require('jsdom');
const fixture = require('./simple-test-loader.cjs');

test('saved home report and strategy links reach their original content without mounting the overview', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' });
  const previous = { window: global.window, document: global.document, act: global.IS_REACT_ACT_ENVIRONMENT };
  global.window = dom.window;
  global.document = dom.window.document;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  try {
    for (const [entry, expected] of [
      ['/?investmentStrategyId=saved%2Fdraft&accountId=account-a#investment-strategy', '/paper?investmentStrategyId=saved%2Fdraft&accountId=account-a#investment-strategy'],
      ['/?reportId=archived-version#sources', '/analysis/reports/archived-version#sources'],
    ]) {
      const f = fixture();
      let overviewMounts = 0;
      f.load('features/portfolio-comparison/PortfolioComparisonPanel.tsx').default = () => {
        overviewMounts += 1;
        return React.createElement('div', null, 'Overview');
      };
      const Page = f.load('pages/Overview/PortfolioOverviewPage.tsx').default;
      function Location() {
        const location = useLocation();
        return React.createElement('output', null, location.pathname + location.search + location.hash);
      }
      const root = createRoot(document.getElementById('root'));
      try {
        await React.act(async () => root.render(React.createElement(MemoryRouter, { initialEntries: [entry] },
          React.createElement(Routes, null,
            React.createElement(Route, { path: '/', element: React.createElement(Page) }),
            React.createElement(Route, { path: '*', element: React.createElement('p', null, 'Destination') })),
          React.createElement(Location))));
        assert.equal(document.querySelector('output').textContent, expected);
        assert.equal(overviewMounts, 0, 'the compatibility route must not mount data readers or research');
        assert.equal(f.state.requests.length, 0);
      } finally {
        await React.act(async () => root.unmount());
      }
    }
  } finally {
    dom.window.close();
    global.window = previous.window;
    global.document = previous.document;
    global.IS_REACT_ACT_ENVIRONMENT = previous.act;
  }
});

test('channel proposal details keep the selected account and use account selection only when none is selected', () => {
  const f = fixture();
  const sheet = f.load('components/ui/sheet.tsx');
  for (const name of ['Sheet', 'SheetContent', 'SheetHeader', 'SheetTitle', 'SheetDescription']) {
    sheet[name] = ({ children }) => React.createElement('div', null, children);
  }
  const Board = f.load('pages/Channel/ChannelWorkbench.tsx').RuntimeBoard;
  const snapshot = {
    accountId: 'account/a', accountName: 'Selected account', confirmedAt: '2026-11-09T00:00:00Z',
    monitoringStatus: 'observing', current: { strategyId: null, rules: [] }, executions: [],
    proposals: [{ id: 'draft/b', status: 'proposed', before: 'Saved', after: 'Draft' }],
  };
  assert.match(f.render(Board, { snapshot, language: 'en' }), /href="\/paper\/account%2Fa\/strategies\?investmentStrategyId=draft%2Fb"/);
  assert.match(f.render(Board, { snapshot: { ...snapshot, accountId: null }, language: 'en' }), /href="\/paper\?investmentStrategyId=draft%2Fb"/);
});
