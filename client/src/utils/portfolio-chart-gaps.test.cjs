const test = require('node:test');
const assert = require('node:assert/strict');
const fixture = require('./simple-test-loader.cjs');

const point = (day, equityUsd, gaps = [], returnPct = null) => ({
  timestamp: `2026-11-${String(day).padStart(2, '0')}T16:00:00.000Z`,
  date: `2026-11-${String(day).padStart(2, '0')}`,
  equityUsd, returnPct, gaps,
});
const series = points => ({ accountId: 'real', points });

test('equity bridges only a declared observation gap using its unchanged known endpoints', () => {
  const options = fixture().load('features/portfolio-comparison/comparison-chart-options.ts');
  assert.equal(typeof options.comparisonGapBridges, 'function');
  const input = series([point(1, 100), point(2, null, ['MISSING_OBSERVATION']), point(4, 120)]);
  const original = JSON.stringify(input);
  const bridges = options.comparisonGapBridges(input, 'equity');
  assert.equal(bridges.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(bridges[0].data)), [
    [Date.parse(input.points[0].timestamp), 100], [Date.parse(input.points[2].timestamp), 120],
  ]);
  assert.equal(JSON.stringify(input), original);
  assert.equal(options.comparisonLineData(input, 'equity')[1][1], null);
  assert.equal(options.comparisonGapBridges(input, 'return').length, 0);
});

test('incomplete balances, financial continuity changes and price convention changes never receive a gap bridge', () => {
  const { comparisonGapBridges } = fixture().load('features/portfolio-comparison/comparison-chart-options.ts');
  assert.equal(typeof comparisonGapBridges, 'function');
  for (const gap of ['INCOMPLETE_VALUATION', 'CASH_FLOW_OR_BASELINE_CHANGED', 'PRICE_BASIS_CHANGED:FICT', 'PRICE_DISCONTINUITY_UNVERIFIED:FICT']) {
    const input = series([point(1, 100), point(2, null, [gap]), point(4, 120)]);
    assert.equal(comparisonGapBridges(input, 'equity', true).length, 0, gap);
  }
  assert.equal(comparisonGapBridges(series([point(1, 100), point(2, null, []), point(4, 120)]), 'equity').length, 0);
  assert.equal(comparisonGapBridges(series([point(1, 100), point(2, null, ['MISSING_OBSERVATION']), point(4, 120, ['CASH_FLOW_OR_BASELINE_CHANGED'])]), 'equity').length, 0);
});

test('reference gaps can use a separately marked connection without converting missing prices into observations', () => {
  const { comparisonGapBridges } = fixture().load('features/portfolio-comparison/comparison-chart-options.ts');
  assert.equal(typeof comparisonGapBridges, 'function');
  const input = series([point(1, 100), point(2, null, ['PRICE_MISSING:FICT']), point(4, 120)]);
  assert.equal(comparisonGapBridges(input, 'equity', false).length, 0);
  assert.equal(comparisonGapBridges(input, 'equity', true).length, 1);
  assert.equal(comparisonGapBridges(input, 'return', true).length, 0);
});

test('isolated points stay visible for the selected metric even when equity has many observations', () => {
  const { comparisonSymbolIndices } = fixture().load('features/portfolio-comparison/comparison-chart-options.ts');
  assert.equal(typeof comparisonSymbolIndices, 'function');
  const input = series([point(1, 100, [], 0), point(2, 101), point(3, 105, [], 5), point(4, 106), point(5, 110, [], 10)]);
  assert.deepEqual(Array.from(comparisonSymbolIndices(input, 'return')), [0, 2, 4]);
  assert.deepEqual(Array.from(comparisonSymbolIndices(input, 'equity')), []);
});

test('tooltips exclude visual bridge series and keep only actual timestamps and values', () => {
  const { comparisonTooltip } = fixture().load('features/portfolio-comparison/comparison-chart-options.ts');
  assert.equal(typeof comparisonTooltip, 'function');
  const timestamp = Date.parse('2026-11-04T16:02:00.000Z');
  const tooltip = comparisonTooltip([
    { seriesId: 'real', seriesName: 'Real portfolio', data: [timestamp, 120] },
    { seriesId: 'gap-bridge:real:0', seriesName: 'Invented interpolation', data: [timestamp, 999] },
  ], 'en-US', 'equity');
  assert.match(tooltip, /Real portfolio: \$120\.00/);
  assert.doesNotMatch(tooltip, /999|Invented interpolation/);
  assert.equal(comparisonTooltip([{ seriesId: 'gap-bridge:real:0', data: [timestamp, 999] }], 'en-US', 'equity'), '');
});

test('reference date labels remain date-only while actual sampling descriptions distinguish hourly observations', () => {
  const { comparisonSamplingLabel, referenceDateLabel } = fixture().load('features/portfolio-comparison/comparison-chart-options.ts');
  assert.equal(typeof comparisonSamplingLabel, 'function');
  assert.match(comparisonSamplingLabel('hourly', false), /hour/i);
  assert.match(comparisonSamplingLabel('observations', false), /saved/i);
  assert.match(comparisonSamplingLabel('daily', true), /每日/);
  assert.match(comparisonSamplingLabel('hourly', false, true), /daily close/i);
  assert.doesNotMatch(referenceDateLabel(Date.parse('2026-11-04T12:00:00Z'), 'en-US'), /:/);
});

test('real account colors follow the current foreground token in HTML and resolved chart colors', () => {
  const { accountColor, chartAccountColor } = fixture().load('features/portfolio-comparison/comparison-chart-options.ts');
  assert.match(accountColor('real', -1), /var\(--foreground/);
  assert.equal(typeof chartAccountColor, 'function');
  assert.equal(chartAccountColor('real', -1, true, 'rgb(225, 238, 231)'), 'rgb(225, 238, 231)');
  assert.equal(accountColor('same-account', 2), chartAccountColor('same-account', 2, true));
});

test('chart captions expose the actual sampling and distinguish a visual gap connection from saved values', () => {
  const f = fixture();
  f.state.queries.set('portfolio-comparison', { data: { granularity: 'hourly', series: [{
    ...series([point(1, 100), point(2, null, ['MISSING_OBSERVATION']), point(4, 120)]),
    name: 'Real portfolio', kind: 'real', status: 'real', colorIndex: -1,
    equityUsd: 120, returnPct: 20, strategyCount: 0, gaps: ['MISSING_OBSERVATION'],
  }] } });
  f.load('features/portfolio-comparison/PortfolioComparisonChart.tsx').default = () => null;
  const Panel = f.load('features/portfolio-comparison/PortfolioComparisonPanel.tsx').default;
  const markup = f.render(Panel);
  assert.match(markup, /Latest saved valuation per hour/);
  assert.match(markup, /Dashed links mark missing intervals/);
  assert.match(markup, /not additional valuations/);
});

test('intraday reference retains its actual quote timestamps and resolves the exact source observation', () => {
  const f = fixture();
  const { historicalReferenceSeries, referenceHistoryPoint } = f.load('features/portfolio-comparison/comparison-display.ts');
  const quoteAt = '2026-11-04T16:02:00.000Z';
  const daily = { date: '2026-11-03', valueUsd: 100, knownValueUsd: 100, coveredPositions: 1, totalPositions: 1,
    priceAsOf: [{ ticker: 'FICT', date: '2026-11-03', source: 'daily-close' }], fxAsOf: [], gaps: [] };
  const quote = { ...daily, date: '2026-11-04', timestamp: quoteAt, valueUsd: 105,
    priceAsOf: [{ ticker: 'FICT', date: '2026-11-04', timestamp: quoteAt, source: 'saved-quote' }] };
  const history = { series: [{ accountId: 'real', points: [daily, quote], coverage: { completePoints: 2 } }] };
  const result = historicalReferenceSeries([{ accountId: 'real' }], history)[0];
  assert.equal(result.points[0].timestamp, '2026-11-03T12:00:00.000Z');
  assert.equal(result.points[1].timestamp, quoteAt);
  assert.equal(typeof referenceHistoryPoint, 'function');
  assert.equal(referenceHistoryPoint(history.series[0], result.points[1]).priceAsOf[0].source, 'saved-quote');
});

test('only reference quotes with a real observed-at timestamp display a time in the tooltip', () => {
  const { comparisonTooltip, comparisonSamplingLabel } = fixture().load('features/portfolio-comparison/comparison-chart-options.ts');
  const timestamp = Date.parse('2026-11-04T16:02:00.000Z');
  const input = [{ seriesId: 'real', seriesName: 'Reference', data: [timestamp, 120] }];
  assert.doesNotMatch(comparisonTooltip(input, 'en-US', 'equity', true).split('\n')[0], /:/);
  assert.match(comparisonTooltip(input, 'en-US', 'equity', true, [timestamp]).split('\n')[0], /:/);
  assert.match(comparisonSamplingLabel('hourly', false, true, 'observations'), /quote/i);
});

test('a daily close does not inherit another account quote time at the same chart coordinate', () => {
  const { comparisonTooltip } = fixture().load('features/portfolio-comparison/comparison-chart-options.ts');
  const timestamp = Date.parse('2026-11-04T12:00:00.000Z');
  const text = comparisonTooltip([
    { seriesId: 'daily', seriesName: 'Daily close', data: [timestamp, 100] },
    { seriesId: 'quote', seriesName: 'Saved quote', data: [timestamp, 120] },
  ], 'en-US', 'equity', true, [{ accountId: 'quote', timestamp }]);
  assert.match(text, /Daily close: \$100\.00/);
  assert.match(text, /Saved quote \([^\n]+:[^\n]+\): \$120\.00/);
  assert.doesNotMatch(text.split('\n')[0], /:/);
});
