const test = require('node:test');
const assert = require('node:assert/strict');
const fixture = require('./simple-test-loader.cjs');

test('current amounts show holdings value despite an incomplete saved total, without converting unknown into zero', () => {
  const { currentAccountValue, currentAccountBasis } = fixture().load('features/portfolio-comparison/comparison-display.ts');
  const series = { equityUsd: null, currentMark: { valueUsd: 240, basis: 'holdings_market_value' } };
  assert.equal(currentAccountValue(series), 240);
  assert.match(currentAccountBasis(series, true), /现金待核对/);
  assert.equal(currentAccountValue({ equityUsd: null }), null);
  assert.equal(currentAccountValue({ equityUsd: 100000, currentMark: { valueUsd: null, basis: 'known_assets' } }), null);
  assert.equal(currentAccountValue({ equityUsd: 20, currentMark: { valueUsd: 0, basis: 'total_assets' } }), 0);
});

test('history uses entire fixed-position reference lines and preserves gaps without inventing investment returns', () => {
  const { historicalReferenceSeries, shouldShowReference } = fixture().load('features/portfolio-comparison/comparison-display.ts');
  const accounts = [{ accountId: 'real', name: 'Real', points: [{ timestamp: '2026-11-10T10:00:00Z', equityUsd: 200, returnPct: null }] }];
  const history = { series: [{ accountId: 'real', coverage: { totalPositions: 2 }, points: [
    { date: '2026-11-06', valueUsd: 100, gaps: [] },
    { date: '2026-11-09', valueUsd: null, gaps: ['MISSING_PRICE'] },
    { date: '2026-11-10', valueUsd: 120, gaps: [] },
  ], gaps: ['MISSING_PRICE'] }] };
  assert.equal(shouldShowReference(accounts, history), true);
  const display = historicalReferenceSeries(accounts, history)[0];
  assert.equal(display.points.length, 3);
  assert.equal(display.points[1].equityUsd, null);
  assert.equal(display.points.every(p => p.returnPct === null), true);
  assert.equal(display.points.some(p => p.timestamp === accounts[0].points[0].timestamp), false);
  assert.equal(display.returnPct, null);
  assert.equal(accounts[0].points.length, 1);
});

test('reference dates and tooltip have a date without a fabricated observed-at time', () => {
  const { referenceDateLabel, referenceTooltip } = fixture().load('features/portfolio-comparison/comparison-chart-options.ts');
  const stamp = Date.parse('2026-11-10T12:00:00Z');
  assert.equal(referenceDateLabel(stamp, 'en-US'), '11/10');
  const text = referenceTooltip([{ data: [stamp, 240], seriesName: 'Reference' }], 'en-US');
  assert.match(text, /^2026-11-10\n/);
  assert.doesNotMatch(text, /12:00|20:00|Observed at/);
});

test('one unsupported holding does not hide a consistent covered subset, and a changing subset or price discontinuity breaks the partial line', () => {
  const { historicalReferenceSeries, partialReferenceCoverage } = fixture().load('features/portfolio-comparison/comparison-display.ts');
  const point = (date, ticker, value, gaps = []) => ({ date, valueUsd: null, knownValueUsd: value, coveredPositions: 1, totalPositions: 2,
    priceAsOf: [{ ticker, date, source: 'fixture:raw-close' }], fxAsOf: [], gaps });
  const partial = { accountId: 'real', coverage: { completePoints: 0 }, points: [
    point('2026-11-06', 'OTHER', 999), point('2026-11-07', 'FICT', 100),
    point('2026-11-08', 'FICT', 200, ['PRICE_DISCONTINUITY_UNVERIFIED:FICT']), point('2026-11-09', 'FICT', 120),
  ], gaps: ['PRICE_MISSING:UNRESOLVED'] };
  assert.equal(partialReferenceCoverage(partial).covered, 1);
  const display = historicalReferenceSeries([{ accountId: 'real' }], { series: [partial] })[0];
  assert.deepEqual(Array.from(display.points, p => p.equityUsd), [null, 100, null, 120]);
  assert.equal(display.returnPct, null);
  assert.equal(partial.points.every(p => p.valueUsd === null), true, 'original full-portfolio unknowns remain unknown');
  const invalid = [
    { ...point('2026-11-01', 'FICT', 80), totalPositions: 3 },
    point('2026-11-02', 'FICT', Infinity),
    point('2026-11-03', 'FICT', 80, ['FUTURE_UNRECOGNIZED_RISK']),
    { ...point('2026-11-04', 'FICT', 80), coveredPositions: 0, priceAsOf: [], gaps: ['FX_MISSING:HKD'] },
  ];
  partial.points.unshift(...invalid);
  const expanded = historicalReferenceSeries([{ accountId: 'real' }], { series: [partial] })[0];
  assert.equal(expanded.points.slice(0, invalid.length).every(p => p.equityUsd === null), true);
  partial.points.at(-1).priceAsOf.push({ ticker: 'FICT', date: '2026-11-09', source: 'duplicate' });
  assert.equal(partialReferenceCoverage(partial).covered, 1, 'an invalid last row cannot displace the prior verified anchor');
});

test('fixed cohort remains visible before a zero-coverage tail while exclusions and critical unknowns stay explicit', () => {
  const { historicalReferenceSeries, partialReferenceCoverage } = fixture().load('features/portfolio-comparison/comparison-display.ts');
  const point = (date, gaps = []) => ({ date, valueUsd: null, knownValueUsd: 100, coveredPositions: 1, totalPositions: 2,
    priceAsOf: [{ ticker: 'FICT', date, source: 'fixture' }], fxAsOf: [], gaps: ['COHORT_EXCLUDED:OTHER', ...gaps] });
  const reference = { accountId: 'real', coverage: { completePoints: 0 }, points: [point('2026-11-09'),
    point('2026-11-10', ['PRICE_BASIS_CHANGED:FICT']), point('2026-11-11'),
    { ...point('2026-11-12'), knownValueUsd: 0, coveredPositions: 0, priceAsOf: [], gaps: ['PRICE_MISSING:FICT', 'COHORT_EXCLUDED:OTHER'] }], gaps: [] };
  const coverage = partialReferenceCoverage(reference);
  assert.equal(coverage.covered, 1); assert.deepEqual(Array.from(coverage.missingTickers), ['OTHER']);
  const result = historicalReferenceSeries([{ accountId: 'real' }], { series: [reference] })[0];
  assert.deepEqual(Array.from(result.points, row => row.equityUsd), [100, null, 100, null]);
  assert.equal(result.points.at(-1).gaps.includes('PRICE_MISSING:FICT'), true);
  assert.equal(result.returnPct, null);
});

test('overview automatically shows available imported-position history and fills current account amounts', async () => {
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
    f.state.queries.set('portfolio-comparison', { data: { series: [{ accountId: 'real', name: 'Real', kind: 'real', colorIndex: -1, status: 'real',
      points: [], gaps: [], equityUsd: null, returnPct: null, strategyCount: 0,
      currentMark: { valueUsd: 240, basis: 'holdings_market_value', asOf: '2026-11-10T10:00:00Z', gaps: [] },
    }] } });
    f.state.queries.set('portfolio-history', { data: { refreshing: false, series: [{ accountId: 'real', coverage: { totalPositions: 1 }, gaps: [],
      points: [{ date: '2026-11-09', valueUsd: 220, gaps: [] }, { date: '2026-11-10', valueUsd: 240, gaps: [] }],
    }] } });
    f.load('features/portfolio-comparison/PortfolioComparisonChart.tsx').default = ({ series }) => React.createElement('output', null, series[0]?.points.map(p => p.equityUsd).join(','));
    const Page = f.load('pages/Overview/PortfolioOverviewPage.tsx').default;
    await React.act(async () => root.render(React.createElement(MemoryRouter, null, React.createElement(Page))));
    assert.equal(document.querySelector('output').textContent, '220,240');
    assert.match(document.body.textContent, /Current holdings lookback/);
    assert.match(document.querySelector('.portfolio-account-value').textContent, /240/);
    assert.match(document.querySelector('.portfolio-account-card').textContent, /Cash unconfirmed/);
    const saved = [...document.querySelectorAll('button')].find(b => b.textContent === 'Account records');
    await React.act(async () => saved.click());
    assert.equal(document.querySelector('output').textContent, '');
    assert.match(document.querySelector('.portfolio-account-value').textContent, /240/);
    const account = f.state.queries.get('portfolio-comparison').data.series[0];
    account.points = [{ timestamp: '2026-11-09T10:00:00Z', date: '2026-11-09', equityUsd: 200, returnPct: 10, gaps: [] }];
    account.returnPct = 10;
    await React.act(async () => [...document.querySelectorAll('button')].find(b => b.textContent === 'Return %').click());
    const returnCaption = document.querySelector('.portfolio-performance-figures .portfolio-performance-asof').textContent;
    assert.match(returnCaption, /Period return · Account records/);
    assert.match(returnCaption, /11\/9\/2026/);
    assert.doesNotMatch(returnCaption, /11\/10\/2026|Cash unconfirmed/);
    await React.act(async () => [...document.querySelectorAll('button')].find(b => b.textContent === 'Current holdings lookback').click());
    f.state.queries.set('portfolio-history', { isError: true, data: undefined });
    await React.act(async () => [...document.querySelectorAll('button')].find(b => b.textContent === 'Compare').click());
    assert.equal(document.querySelector('output').textContent, '');
    const records = [...document.querySelectorAll('button')].find(b => b.textContent === 'Account records');
    assert.ok(records, 'history failure must leave a direct route back to saved account records');
    await React.act(async () => records.click());
    assert.equal(document.querySelector('output').textContent, '200');
  } finally {
    await React.act(async () => root.unmount()); dom.window.close();
    global.window = previous.window; global.document = previous.document; global.IS_REACT_ACT_ENVIRONMENT = previous.act;
  }
});
