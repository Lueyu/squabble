const test = require('node:test');
const assert = require('node:assert/strict');
const fixture = require('./simple-test-loader.cjs');

test('chart uses real timestamps and null gaps without smoothing missing account history', () => {
  const { load } = fixture();
  const { comparisonLineData, accountColor } = load('features/portfolio-comparison/comparison-chart-options.ts');
  const series = { accountId: 'example', points: [
    { timestamp: '2026-11-01T16:00:00Z', equityUsd: 100, returnPct: 0 },
    { timestamp: '2026-11-02T16:00:00Z', equityUsd: null, returnPct: null },
    { timestamp: '2026-11-06T16:00:00Z', equityUsd: 105, returnPct: null },
  ] };
  const values = comparisonLineData(series, 'equity');
  assert.equal(values[1][1], null);
  assert.equal(values[2][0] - values[1][0], 4 * 86400000);
  assert.equal(comparisonLineData(series, 'return')[2][1], null);
  assert.equal(accountColor('example'), accountColor(series.accountId));
  assert.notEqual(accountColor('real'), accountColor('example'));
});

test('comparison API explicitly scopes selected account IDs and uses only GET', async () => {
  const { load, state } = fixture();
  const { fetchPortfolioComparison } = load('api/portfolio-comparison.ts');
  await fetchPortfolioComparison('3M', ['real', 'account-a']);
  assert.equal(state.requests[0].method, 'get');
  assert.equal(state.requests[0].args[1].params.accountIds, 'real,account-a');
  assert.equal(state.requests[0].args[1].params.period, '3M');
});

test('one saved observation has one timestamp, while null gaps retain their real time span', () => {
  const { comparisonTimeWindow } = fixture().load('features/portfolio-comparison/comparison-chart-options.ts');
  const timestamp = '2026-11-10T05:12:00Z';
  const one = [{ points: [{ timestamp, equityUsd: 10000, returnPct: null }] }];
  assert.equal(comparisonTimeWindow(one).first, Date.parse(timestamp));
  assert.equal(comparisonTimeWindow(one).last, Date.parse(timestamp));
  one[0].points.push({ timestamp: '2026-11-11T05:12:00Z', equityUsd: null, returnPct: null });
  assert.equal(comparisonTimeWindow(one).last - comparisonTimeWindow(one).first, 86400000);
  assert.equal(comparisonTimeWindow([]), null);
});

test('an account comparison link selects its starting account while keeping other accounts available', async () => {
  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { MemoryRouter } = require('react-router-dom');
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' });
  const previous = { window: global.window, document: global.document, act: global.IS_REACT_ACT_ENVIRONMENT };
  global.window = dom.window; global.document = dom.window.document; global.IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(document.getElementById('root'));
  try {
    const f = fixture();
    f.state.queries.set('portfolio-comparison', { data: { series: ['real', 'account-a', 'account-b'].map((id, index) => ({
      accountId: id, name: id, kind: index ? 'simulation' : 'real', colorIndex: index - 1,
      status: index ? 'paused' : 'real', equityUsd: 100, returnPct: null, strategyCount: 0, points: [], gaps: [],
    })) } });
    f.load('features/portfolio-comparison/PortfolioComparisonChart.tsx').default = ({ series }) => React.createElement('output', null, series.map(item => item.accountId).join(','));
    const Page = f.load('pages/Overview/PortfolioOverviewPage.tsx').default;
    await React.act(async () => root.render(React.createElement(MemoryRouter, { initialEntries: ['/?accountIds=account-a'] }, React.createElement(Page))));
    assert.equal(document.querySelector('output').textContent, 'real,account-a');
    const other = [...document.querySelectorAll('button')].find(button => button.textContent.includes('account-b'));
    assert.ok(other, 'the second simulation stays available to add');
    assert.equal(other.getAttribute('aria-pressed'), 'false');
    await React.act(async () => other.click());
    assert.equal(document.querySelector('output').textContent, 'real,account-a,account-b');
  } finally {
    await React.act(async () => root.unmount()); dom.window.close();
    global.window = previous.window; global.document = previous.document; global.IS_REACT_ACT_ENVIRONMENT = previous.act;
  }
});

test('overview chart choices survive a detail visit and browser back through the URL', async () => {
  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { MemoryRouter, Routes, Route, useLocation, useNavigate } = require('react-router-dom');
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' });
  const previous = { window: global.window, document: global.document, act: global.IS_REACT_ACT_ENVIRONMENT };
  global.window = dom.window; global.document = dom.window.document; global.IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(document.getElementById('root'));
  try {
    const f = fixture();
    f.state.queries.set('portfolio-comparison', { data: { series: ['real', 'account-a', 'account-b'].map((id, index) => ({
      accountId: id, name: id, kind: index ? 'simulation' : 'real', colorIndex: index - 1,
      status: index ? 'paused' : 'real', equityUsd: 100, returnPct: null, strategyCount: 0, points: [], gaps: [],
    })) } });
    f.load('features/portfolio-comparison/PortfolioComparisonChart.tsx').default = ({ series, metric }) =>
      React.createElement('output', { 'data-chart': true }, `${metric}:${series.map(item => item.accountId).join(',')}`);
    const Page = f.load('pages/Overview/PortfolioOverviewPage.tsx').default;
    function Location() { return React.createElement('output', { 'data-url': true }, useLocation().search); }
    function Detail() { const navigate = useNavigate(); return React.createElement('button', { onClick: () => navigate(-1) }, 'Back'); }
    await React.act(async () => root.render(React.createElement(MemoryRouter, { initialEntries: ['/?period=3M&metric=return&accountIds=real,account-a'] },
      React.createElement(Location), React.createElement(Routes, null,
        React.createElement(Route, { path: '/', element: React.createElement(Page) }),
        React.createElement(Route, { path: '/paper/:accountId', element: React.createElement(Detail) })))));
    assert.equal(document.querySelector('[data-chart]').textContent, 'return:real,account-a');
    const week = [...document.querySelectorAll('button')].find(button => button.textContent === '1W');
    await React.act(async () => week.click());
    assert.match(document.querySelector('[data-url]').textContent, /period=1W/);
    const account = [...document.querySelectorAll('a')].find(link => link.pathname === '/paper/account-a');
    await React.act(async () => account.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })));
    await React.act(async () => [...document.querySelectorAll('button')].find(button => button.textContent === 'Back').click());
    assert.equal(document.querySelector('[data-chart]').textContent, 'return:real,account-a');
    assert.equal([...document.querySelectorAll('button')].find(button => button.textContent === '1W').getAttribute('aria-pressed'), 'true');
  } finally {
    await React.act(async () => root.unmount()); dom.window.close();
    global.window = previous.window; global.document = previous.document; global.IS_REACT_ACT_ENVIRONMENT = previous.act;
  }
});
