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
  const content = [...dom.window.document.querySelectorAll('article > section')].map(section => section.textContent).join('\n');
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
