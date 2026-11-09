const assert = require('node:assert/strict');
const { test } = require('node:test');
const { JSDOM } = require('jsdom');
const fixture = require('./simple-test-loader.cjs');

function review(overrides = {}) {
  return { accountId: 'simulation-one', timezone: 'Asia/Shanghai', from: '2026-11-06', to: '2026-11-06',
    initialEquityUsd: '1000.00', endingEquityUsd: '1250.00', profitUsd: '250.00', returnPct: '25.0000',
    buyAndHoldEquityUsd: '1200.00', excessReturnPct: '5.0000', orders: 2, feesUsd: '3.50', gaps: [],
    valuationAsOf: '2026-11-06', indexBenchmarkTicker: 'SPY', indexBenchmarkEquityUsd: '1100.00',
    indexBenchmarkReturnPct: '10.0000', indexExcessReturnPct: '15.0000', observedMaxDrawdownPct: '2.0000',
    drawdownSampleCount: 3, drawdownCoverage: 'observed_snapshots_only', strategyContributions: [
      { mandateId: 'private-plan-id', title: 'Measured allocation', version: 2, from: '2026-11-06T00:00:00Z',
        to: '2026-11-06T16:00:00Z', profitUsd: '250.00', returnPct: '25.0000', orders: 2, feesUsd: '3.50', gaps: [] },
    ], ...overrides };
}
function archived(value = review(), sections) {
  return { id: 'historical-review', title: '每日模拟复盘 / Simulation review 2026-11-06 — 2026-11-06',
    kind: 'council', source: null, createdAt: '2026-11-06T16:00:00Z', status: 'valid', sourceStatus: 'available',
    content: 'IMMUTABLE ORIGINAL JSON BODY', snapshot: { experimentId: value.accountId, scene: 'trade_post_review',
      from: value.from, to: value.to, timezone: value.timezone, review: value },
    sections: sections ?? [{ id: 'performance', title: '收益与数据口径 / Performance & data coverage', content: JSON.stringify(value) },
      { id: 'thesis-review', title: '判断待复核 / Thesis review', content: 'No realized losing fills identified; this does not validate the thesis.' }] };
}
function renderVersion(version, language = 'en') {
  const { load, render, state } = fixture(); state.language = language;
  state.queries.set('research-document', { data: { version } });
  const html = render(load('pages/Analysis/SimpleReportReader.tsx').default, { versionId: version.id });
  const dom = new JSDOM(html);
  const content = [...dom.window.document.querySelectorAll('article .report-section')].map(section => section.textContent).join('\n');
  dom.window.close(); return { html, content, state };
}

test('historical simulation review displays saved performance, fees and strategy attribution without rewriting its archive', () => {
  const version = archived(); const before = JSON.stringify(version);
  const { html, content, state } = renderVersion(version);
  assert.match(content, /Period profit: 250\.00 USD/);
  assert.match(content, /Period return: 25\.0000%/);
  assert.match(content, /Fills: 2/); assert.match(content, /Fees: 3\.50 USD/);
  assert.match(content, /SPY/); assert.match(content, /15\.0000%/);
  assert.match(content, /Observed maximum drawdown: 2\.0000%/);
  assert.match(content, /Measured allocation/); assert.match(content, /v2/);
  assert.doesNotMatch(content, /private-plan-id|accountId|profitUsd|schemaVersion/);
  assert.doesNotMatch(html, /This report has no execution strategy draft|Update the analysis to generate one/);
  assert.equal(JSON.stringify(version), before); assert.equal(state.requests.length, 0);
});

test('unknown simulation returns stay unknown while zero fills and missing valuation are explained', () => {
  const value = review({ initialEquityUsd: null, endingEquityUsd: null, profitUsd: null, returnPct: null,
    buyAndHoldEquityUsd: null, excessReturnPct: null, indexBenchmarkEquityUsd: null, indexBenchmarkReturnPct: null,
    indexExcessReturnPct: null, observedMaxDrawdownPct: null, drawdownSampleCount: 0, drawdownCoverage: 'insufficient_samples',
    orders: 0, feesUsd: '0.00', gaps: ['PERIOD_START_SNAPSHOT_MISSING', 'MONITOR_OFFLINE_INTERVAL'], strategyContributions: [] });
  const { content } = renderVersion(archived(value));
  assert.match(content, /Period profit: Unknown/); assert.match(content, /Period return: Unknown/);
  assert.match(content, /Fills: 0/); assert.match(content, /Fees: 0\.00 USD/);
  assert.match(content, /Opening valuation is missing/); assert.match(content, /Monitoring was offline/);
  assert.match(content, /Insufficient samples/); assert.doesNotMatch(content, /Period return: 0/);
});

test('automatic review shows saved execution constraints, route counts and information gaps as prose', () => {
  const value = review(); const version = archived(value);
  version.sections.push(
    { id: 'execution-limited', title: 'Execution constraints', content: JSON.stringify([{ signalId: 'private-signal', reason: 'Cash was unavailable.' }]) },
    { id: 'information-gaps', title: 'Insufficient information', content: JSON.stringify({ gaps: ['PERIOD_END_SNAPSHOT_MISSING'],
      monitorGaps: [{ from: '2026-11-06T01:00:00Z', to: '2026-11-06T02:00:00Z' }], decisions: [{ signalId: 'private-decision', reason: 'Waiting for a fresh quote.' }] }) },
    { id: 'route-attribution', title: 'AI & Council decisions', content: JSON.stringify({ direct: 2, ai: 1, council: 0,
      vetoes: [{ signalId: 'private-veto', reason: 'The risk limit was exceeded.' }], sourcePlans: ['private-plan-one', 'private-plan-two'] }) },
  );
  const { content } = renderVersion(version);
  assert.match(content, /Cash was unavailable/); assert.match(content, /Closing valuation is missing/);
  assert.match(content, /Waiting for a fresh quote/); assert.match(content, /2026-11-06T01:00:00Z/);
  assert.match(content, /Direct decisions: 2/); assert.match(content, /AI decisions: 1/); assert.match(content, /Council decisions: 0/);
  assert.match(content, /The risk limit was exceeded/); assert.match(content, /Source strategies: 2/);
  assert.doesNotMatch(content, /private-signal|private-decision|private-veto|private-plan-one|signalId|sourcePlans/);
});

test('manually archived reviews and automatic losing-fill evidence render in Chinese', () => {
  const value = review(); const version = archived(value, [{ id: 'review', title: 'Period review / 期间复盘', content: JSON.stringify(value) },
    { id: 'thesis-review', title: '判断待复核 / Thesis review', content: '亏损成交不直接证明原判断错误。\n' + JSON.stringify([{ orderId: 'private-order', ticker: 'AAPL', realizedPl: '-12.50' }]) }]);
  delete version.snapshot.scene;
  const { content } = renderVersion(version, 'zh-CN');
  assert.match(content, /期间盈亏：250\.00 美元/); assert.match(content, /成交笔数：2/); assert.match(content, /费用：3\.50 美元/);
  assert.match(content, /AAPL/); assert.match(content, /-12\.50 美元/); assert.match(content, /亏损本身不能证明原判断错误/);
  assert.doesNotMatch(content, /private-order|realizedPl|orderId/);
});

test('review projection never opens unrelated or malformed JSON documents', () => {
  const version = archived(); version.snapshot.review = { secret: 'ARBITRARY OBJECT', profitUsd: '999.00' };
  version.sections = [{ id: 'performance', title: 'Performance', content: JSON.stringify(version.snapshot.review) }];
  const { html, content } = renderVersion(version);
  assert.equal(content, ''); assert.match(html, /formatting needs review/);
  const sourceVersion = archived(); sourceVersion.source = { type: 'council', id: 'real-research' };
  assert.doesNotMatch(renderVersion(sourceVersion).content, /Period profit:/);
});

test('older overview sections keep unavailable optional measurements unknown and describe empty decision lists', () => {
  const value = review(); delete value.drawdownSampleCount; delete value.drawdownCoverage;
  delete value.observedMaxDrawdownPct; delete value.strategyContributions;
  const version = archived(value, [{ id: 'overview', title: 'Overview', content: JSON.stringify(value) },
    { id: 'execution-limited', title: 'Execution constraints', content: '[]' },
    { id: 'information-gaps', title: 'Insufficient information', content: '{"gaps":[],"monitorGaps":[],"decisions":[]}' },
    { id: 'route-attribution', title: 'AI & Council decisions', content: '{"direct":0,"ai":0,"council":0,"vetoes":[],"sourcePlans":[]}' }]);
  const { content } = renderVersion(version);
  assert.match(content, /Period profit: 250\.00 USD/); assert.match(content, /Drawdown samples: Unknown/);
  assert.match(content, /Drawdown coverage: Unknown/);
  assert.match(content, /No execution constraints were recorded/); assert.match(content, /No additional information gaps were recorded/);
  assert.match(content, /Direct decisions: 0/); assert.match(content, /Source strategies: 0/);
});

test('initial-only review explains unknown performance and zero activity as bookkeeping', () => {
  const value = review({ profitUsd: null, returnPct: null, excessReturnPct: null, indexBenchmarkReturnPct: null,
    indexExcessReturnPct: null, initialEquityUsd: '1000.00', endingEquityUsd: '1000.00',
    valuationCoverage: 'initial_only', openingValuedAt: '2026-11-06T02:00:00Z', endingValuedAt: '2026-11-06T02:00:00Z',
    observedMaxDrawdownPct: null, drawdownSampleCount: 1, drawdownCoverage: 'insufficient_samples',
    orders: 0, feesUsd: '0.00', gaps: ['SUBSEQUENT_VALUATION_MISSING'], strategyContributions: [] });
  const version = archived(value);
  version.sections.push({ id: 'route-attribution', title: 'AI & Council decisions',
    content: '{"direct":0,"ai":0,"council":0,"vetoes":[],"sourcePlans":[]}' });
  const { content } = renderVersion(version);
  assert.match(content, /Only the initial valuation is recorded/);
  assert.match(content, /Period profit: Unknown/); assert.match(content, /Drawdown samples: 1/);
  assert.match(content, /bookkeeping/); assert.match(content, /No AI or Council decision was recorded/);
  assert.doesNotMatch(content, /SUBSEQUENT_VALUATION_MISSING/);
  const chinese = renderVersion(version, 'zh-CN').content;
  assert.match(chinese, /仅记录了初始化估值/); assert.match(chinese, /账本/); assert.match(chinese, /未记录 AI 或研讨决策/);
});

test('generic model notes are translated once while real coverage and execution gaps stay visible once', () => {
  const gaps = ['CORPORATE_ACTIONS_UNSUPPORTED', 'PUBLIC_QUOTES_MAY_BE_DELAYED', 'PUBLIC_QUOTES_MAY_BE_DELAYED',
    'CASH_AVAILABILITY_UNKNOWN:USD', 'SELLABILITY_UNKNOWN:AAPL', 'PERIOD_END_SNAPSHOT_MISSING'];
  const version = archived(review({ gaps }));
  version.sections.push({ id: 'information-gaps', title: 'Insufficient information',
    content: JSON.stringify({ gaps, monitorGaps: [], decisions: [] }) });
  const before = JSON.stringify(version);
  const { content } = renderVersion(version);
  assert.match(content, /Model and data notes/);
  assert.equal(content.match(/Corporate actions are not automatically processed/g)?.length, 1);
  assert.equal(content.match(/Public quotes may be delayed/g)?.length, 1);
  assert.equal(content.match(/Available cash is unconfirmed/g)?.length, 1);
  assert.equal(content.match(/Sellable shares are unconfirmed/g)?.length, 1);
  assert.equal(content.match(/Closing valuation is missing/g)?.length, 1);
  assert.doesNotMatch(content, /CORPORATE_ACTIONS_UNSUPPORTED|PUBLIC_QUOTES_MAY_BE_DELAYED|CASH_AVAILABILITY_UNKNOWN|SELLABILITY_UNKNOWN/);
  assert.equal(JSON.stringify(version), before);
});

test('legacy saved zero returns retain their figures but cannot imply a full day of observed performance', () => {
  const value = review({ initialEquityUsd: '1000.00', endingEquityUsd: '1000.00', profitUsd: '0.00', returnPct: '0.0000',
    observedMaxDrawdownPct: '0.0000', drawdownSampleCount: 2 });
  const version = archived(value); const before = JSON.stringify(version);
  const { content } = renderVersion(version);
  assert.match(content, /Period profit: 0\.00 USD/);
  assert.match(content, /Time coverage is unknown in this archived review/);
  assert.match(content, /do not establish full-day performance/);
  assert.doesNotMatch(content, /Only the initial valuation is recorded/);
  assert.equal(JSON.stringify(version), before);
});

test('known later equal valuations show their real observation span and legacy drawdown timestamps stay unknown', () => {
  const value = review({ valuationCoverage: 'observed_period', openingValuedAt: '2026-11-06T02:00:00Z',
    endingValuedAt: '2026-11-06T07:00:00Z', profitUsd: '0.00', returnPct: '0.0000',
    drawdownCoverage: 'unknown_timestamps', observedMaxDrawdownPct: null });
  const { content } = renderVersion(archived(value));
  assert.match(content, /Observed valuation interval/); assert.match(content, /2026-11-06T02:00:00Z/);
  assert.match(content, /2026-11-06T07:00:00Z/); assert.match(content, /full calendar day/);
  assert.match(content, /Some recorded valuations have unknown timestamps/);
  assert.match(content, /Period profit: 0\.00 USD/);
});

test('date-only saved endpoints do not become known valuation timestamps', () => {
  const value = review({ valuationCoverage: 'observed_period', openingValuedAt: '2026-11-06', endingValuedAt: '2026-11-07' });
  const { content } = renderVersion(archived(value));
  assert.match(content, /Time coverage is unknown in this archived review/);
  assert.doesNotMatch(content, /Observed valuation interval:/);
});
