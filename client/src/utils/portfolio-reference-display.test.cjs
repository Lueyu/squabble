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

test('overview shows recorded returns, current equity and dated holdings references in the selected chart', () => {
  const React = require('react');
  const { renderToStaticMarkup } = require('react-dom/server');
  const { MemoryRouter } = require('react-router-dom');
  const { JSDOM } = require('jsdom');
  const f = fixture();
  const observed = '2026-11-09T10:00:00Z';
  const current = '2026-11-10T10:00:00Z';
  f.state.queries.set('portfolio-comparison', { data: { granularity: 'observations', series: [{
    accountId: 'real', name: 'Real', kind: 'real', colorIndex: -1, status: 'real',
    points: [{ timestamp: observed, date: '2026-11-09', equityUsd: 200, returnPct: 10, gaps: [] }],
    gaps: [], equityUsd: 200, returnPct: 10, valuationAsOf: observed,
    currentMark: { valueUsd: 240, basis: 'holdings_market_value', asOf: current, gaps: [] },
  }] } });
  const latestPrice = { date: '2026-11-10', valueUsd: 220, gaps: [] };
  f.state.queries.set('portfolio-history', { data: { series: [{ accountId: 'real', coverage: { completePoints: 2 }, gaps: [],
    points: [{ date: '2026-11-09', valueUsd: 210, gaps: [] }, latestPrice,
      { date: '2026-11-11', valueUsd: null, gaps: ['PRICE_MISSING:FICT'] }],
  }] } });
  const Page = f.load('pages/Overview/PortfolioOverviewPage.tsx').default;
  function overview(url) {
    return JSDOM.fragment(renderToStaticMarkup(React.createElement(MemoryRouter, { initialEntries: [url] }, React.createElement(Page))));
  }
  const panel = page => page.querySelector('section[aria-label="Account performance"]');
  const defaultPage = overview('/');
  assert.deepEqual([...defaultPage.querySelectorAll('h2')].map(node => node.textContent), [
    'Account returns', 'My accounts', 'Today’s investment daily',
  ]);
  assert.ok(defaultPage.querySelector('a[href="/holdings?accountId=real"]'));
  assert.ok(defaultPage.querySelector('a[href="/daily"]'));
  const returns = panel(defaultPage);
  assert.match(returns.querySelector('dl').textContent, /\+10\.00%/);
  assert.equal(returns.querySelector('time').dateTime, observed);
  assert.equal(returns.querySelector('summary').textContent, 'View historical valuations');

  const equity = panel(overview('/?basis=records&metric=equity'));
  assert.equal(equity.querySelector('h2').textContent, 'Account equity');
  assert.match(equity.querySelector('dl').textContent, /\$240\.00/);
  assert.match(equity.querySelector('dl').textContent, /Holdings value · Cash unconfirmed/);
  assert.equal(equity.querySelector('time').dateTime, current);

  const reference = panel(overview('/?basis=reference'));
  assert.equal(reference.querySelector('h2').textContent, 'Holdings lookback');
  assert.match(reference.querySelector('dl').textContent, /\$220\.00/);
  assert.equal(reference.querySelector('time').dateTime, '2026-11-10');
  assert.doesNotMatch(reference.querySelector('time').textContent, /\d:\d/);
  assert.equal(reference.querySelector('summary').textContent, 'View reference values and price sources');
  assert.match(reference.textContent, /Excludes cash, trades and dividends/);
  latestPrice.timestamp = '2026-11-10T07:35:00Z';
  const quoteTime = panel(overview('/?basis=reference')).querySelector('time');
  assert.equal(quoteTime.dateTime, latestPrice.timestamp);
  assert.match(quoteTime.textContent, /15:35/);

  f.state.queries.set('portfolio-history', { isError: true });
  const unavailable = panel(overview('/?basis=reference'));
  assert.match(unavailable.querySelector('[role="alert"]').textContent, /Historical prices are unavailable/);
  assert.equal(unavailable.querySelector('dd').textContent, '—');
});
