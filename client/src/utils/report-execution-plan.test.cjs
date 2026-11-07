const assert = require('node:assert/strict');
const { test } = require('node:test');
const React = require('react');
const { createRoot } = require('react-dom/client');
const { MemoryRouter, useLocation } = require('react-router-dom');
const { JSDOM } = require('jsdom');
const fixture = require('./simple-test-loader.cjs');

const text = 'Buy 2 AAPL when price is at most 100; stop at 80.';
function plan(overrides = {}) {
  return { schemaVersion: 1, parameterOrigin: 'ai_proposed', readiness: 'ready', evidenceIds: ['evidence-one'], gaps: [],
    strategy: { title: 'Measured buying plan', body: '', timezone: 'Asia/Shanghai', startsAt: '2026-11-06T00:00:00Z', endsAt: '2026-11-13T00:00:00Z',
      limits: { maxPositionPct: 10, maxDailyIncreasePct: 5, maxDailyTurnoverPct: 20, minCashPct: 10, maxGrossExposurePct: 90, maxOrderPct: 5 },
      entries: [{ id: 'aapl-buy', text, ticker: 'AAPL', sourceKeys: [], directive: { ticker: 'AAPL', side: 'buy', quantity: 2, trigger: { kind: 'price_lte', price: 100 }, reviewedText: text, numericEvidence: [] } }] },
    preview: { revision: 1, contentHash: 'plan-hash', generatedAt: '2026-11-06T00:00:00Z', canConfirm: true,
      entries: [{ id: 'aapl-buy', ticker: 'AAPL', state: 'executable', startsAt: '2026-11-06T00:00:00Z', endsAt: '2026-11-13T00:00:00Z', timezone: 'Asia/Shanghai', explanation: { en: 'Buy AAPL: 2 shares when price ≤ 100.', 'zh-CN': 'AAPL：价格不高于 100 时买入 2 股。' } }], directives: [], mandateRules: [], issues: [] }, ...overrides };
}
function report(value) { return { version: { id: 'exact-version', status: 'valid', sourceStatus: 'available', content: 'Saved research to observe.', sections: [{ id: 'summary', title: 'Research', content: 'Saved research to observe.' }], snapshot: value ? { executionPlan: value } : {} } }; }

test('report execution plan presents proposed conditions, quantity, period and limits as human text', () => {
  const { load, render, state } = fixture();
  state.queries.set('research-document', { data: report(plan()) });
  const html = render(load('components/ReportExecutionPlan.tsx').default, { versionId: 'exact-version' });
  assert.match(html, /Execution strategy draft/); assert.match(html, /Ready for review/);
  assert.match(html, /Buy 2 AAPL when price is at most 100/); assert.match(html, /Buy AAPL: 2 shares/);
  assert.match(html, /AI-proposed risk limits/); assert.match(html, /Single-position cap/); assert.match(html, /10%/);
  assert.match(html, /Asia\/Shanghai/); assert.match(html, /2026/);
  assert.doesNotMatch(html, /schemaVersion|numericEvidence|plan-hash/);
  state.language = 'zh-CN';
  const chinese = render(load('components/ReportExecutionPlan.tsx').default, { versionId: 'exact-version' });
  assert.match(chinese, /执行策略草案/); assert.match(chinese, /AI 提议的风险边界/); assert.match(chinese, /买入 2 股/);
});

test('missing information and no-trade reports are never labeled ready', () => {
  const { load, render, state } = fixture(); const Component = load('components/ReportExecutionPlan.tsx').default;
  state.queries.set('research-document', { data: report(plan({ readiness: 'needs_info', gaps: ['Confirm the intended quantity.'] })) });
  let html = render(Component, { versionId: 'exact-version' });
  assert.match(html, /Needs information/); assert.match(html, /Confirm the intended quantity/); assert.doesNotMatch(html, /Ready for review/);
  state.queries.set('research-document', { data: report(plan({ readiness: 'no_trade', noTradeReason: 'Wait for the next filing.', strategy: { ...plan().strategy, entries: [], limits: undefined } })) });
  html = render(Component, { versionId: 'exact-version' });
  assert.match(html, /No trade proposed/); assert.match(html, /Wait for the next filing/); assert.doesNotMatch(html, /Ready for review/);
  assert.doesNotMatch(html, /Complete and review limits/);
});

test('system follow-ups keep the AI failure visible and offer an observation draft without suggesting trading limits', () => {
  const { load, render, state } = fixture();
  const observation = plan({ parameterOrigin: 'system_observation', readiness: 'no_trade', evidenceIds: [],
    noTradeReason: 'The AI execution proposal failed validation. This system follow-up does not authorize trading.',
    strategy: { ...plan().strategy, title: 'System observation plan', limits: undefined, entries: [{ id: 'watch', text: 'Recheck the original filing.', sourceKeys: [] }] },
    preview: { ...plan().preview, directives: [], entries: [], issues: [] } });
  state.queries.set('research-document', { data: { version: { ...report(observation).version, snapshot: { executionPlan: observation, executionPlanError: 'invalid' } } } });
  const html = render(load('components/ReportExecutionPlan.tsx').default, { versionId: 'exact-version' });
  assert.match(html, /System observation plan/); assert.match(html, /failed validation/); assert.match(html, /Copy to AI simulation/);
  assert.doesNotMatch(html, /AI-proposed risk limits|Complete and review limits|AI proposes the securities/);
});

test('legacy reports offer observation copying without inventing execution parameters', () => {
  const { load, render, state } = fixture(); state.queries.set('research-document', { data: report() });
  const html = render(load('components/ReportExecutionPlan.tsx').default, { versionId: 'exact-version' });
  assert.match(html, /This report has no execution strategy draft/);
  assert.match(html, /Copy report as observation draft/);
  assert.doesNotMatch(html, /Copy strategy text|Add to investment draft|Buy AAPL/);
});

test('missing historical plans copy exact readable research once without selecting the error placeholder', async () => withDom(async ({ root }) => {
  const { load, state } = fixture();
  const saved = report().version;
  state.queries.set('research-document', { data: { version: { ...saved, snapshot: { executionPlanError: 'missing' }, sections: [...saved.sections,
    { id: 'execution-strategy', title: 'Missing proposal', content: 'This report did not return a structured execution proposal.' }] } } });
  state.responses = new Map([['/api/investment-strategies/import-source', { id: 'legacy-observation' }]]);
  function Location() { const location = useLocation(); return React.createElement('output', null, location.pathname + location.search + location.hash); }
  await React.act(async () => root.render(React.createElement(MemoryRouter, null, React.createElement(load('components/ReportExecutionPlan.tsx').default, { versionId: 'exact-version' }), React.createElement(Location))));
  const button = [...document.querySelectorAll('button')].find(item => item.textContent === 'Copy report as observation draft');
  assert.ok(button); assert.equal(button.disabled, false);
  await React.act(async () => button.click());
  assert.equal(state.requests.length, 1); assert.equal(state.requests[0].args[0], '/api/investment-strategies/import-source');
  assert.deepEqual(JSON.parse(JSON.stringify(state.requests[0].args[1].source)), { kind: 'report', versionId: 'exact-version' });
  assert.equal(document.querySelector('output').textContent, '/paper?investmentStrategyId=legacy-observation#investment-strategy');
}));

test('a missing-plan notice alone cannot be copied as research and explains the missing readable content', () => {
  const { load, render, state } = fixture();
  state.queries.set('research-document', { data: { version: { ...report().version, snapshot: { executionPlanError: 'invalid' }, sections: [
    { id: 'execution-strategy', title: 'Rejected proposal', content: 'The proposal failed validation.' }] } } });
  const html = render(load('components/ReportExecutionPlan.tsx').default, { versionId: 'exact-version' });
  assert.match(html, /no readable research to copy/); assert.match(html, /disabled=""/);
  assert.equal(state.requests.length, 0);
});

test('a historical report that becomes unreadable reports the server cause and does not navigate or apply', async () => withDom(async ({ root }) => {
  const { load, state } = fixture(); state.queries.set('research-document', { data: report() });
  load('api/investment-strategies.ts').investmentStrategiesApi.importSource = async () => {
    throw Object.assign(new Error('Report unavailable'), { response: { data: { message: 'Report content is not ready for readable publication' } } });
  };
  function Location() { return React.createElement('output', null, useLocation().pathname); }
  await React.act(async () => root.render(React.createElement(MemoryRouter, null, React.createElement(load('components/ReportExecutionPlan.tsx').default, { versionId: 'exact-version' }), React.createElement(Location))));
  await React.act(async () => [...document.querySelectorAll('button')].find(item => item.textContent === 'Copy report as observation draft').click());
  assert.match(document.body.textContent, /no readable research to copy/); assert.equal(document.querySelector('output').textContent, '/');
  assert.equal(state.requests.length, 0);
}));

test('invalid or missing generated proposals explain why no executable plan is available', () => {
  const { load, render, state } = fixture(); const Component = load('components/ReportExecutionPlan.tsx').default;
  for (const [error, english, chinese] of [
    ['invalid', /The strategy parameters did not pass validation/, /本次策略参数未通过校验，暂无可执行方案/],
    ['missing', /This report did not return a structured strategy proposal/, /本次报告未返回结构化策略草案，暂无可执行方案/],
  ]) {
    state.queries.set('research-document', { data: { version: { ...report().version, snapshot: { executionPlanError: error } } } });
    state.language = 'en'; let html = render(Component, { versionId: 'exact-version' });
    assert.match(html, english); assert.doesNotMatch(html, /Copy strategy text|Add to investment draft|Update the analysis/);
    state.language = 'zh-CN'; html = render(Component, { versionId: 'exact-version' }); assert.match(html, chinese);
  }
  assert.equal(state.requests.length, 0);
});

test('Today and the historical reader place the saved plan after research without duplicating its archived section', () => {
  const { load, render, state } = fixture();
  const version = { ...report(plan()).version, title: 'Saved research', createdAt: '2026-11-06T00:00:00Z', content: 'Saved research text', sections: [
    { id: 'summary', title: 'Summary', content: 'Saved research text' }, { id: 'execution-strategy', title: 'Execution strategy', content: 'ARCHIVED_PLAN_DUPLICATE' },
  ] };
  state.queries.set('research-document', { data: { version } });
  const today = render(load('pages/Today/CurrentAnalysisPanel.tsx').default, { view: { documentId: 'exact-version', state: 'ready', researchLevel: 'ai', content: 'Saved research text' }, topicKey: 'portfolio' });
  assert.match(today, /Execution strategy draft/); assert.ok(today.indexOf('Execution strategy draft') > today.indexOf('Saved research text'));
  const historical = render(load('pages/Analysis/SimpleReportReader.tsx').default, { versionId: 'exact-version' });
  assert.match(historical, /Execution strategy draft/); assert.ok(historical.indexOf('Execution strategy draft') > historical.indexOf('Saved research text'));
  assert.doesNotMatch(historical, /ARCHIVED_PLAN_DUPLICATE/);
});

async function withDom(run) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' });
  const previous = { window: global.window, document: global.document, act: global.IS_REACT_ACT_ENVIRONMENT };
  global.window = dom.window; global.document = dom.window.document; global.IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(document.getElementById('root'));
  try { await run({ dom, root }); } finally { await React.act(async () => root.unmount()); dom.window.close(); global.window = previous.window; global.document = previous.document; global.IS_REACT_ACT_ENVIRONMENT = previous.act; }
}
test('copying preserves readable text and one click saves the exact plan then opens its simulation draft', async () => withDom(async ({ dom, root }) => {
  const { load, state } = fixture(); state.queries.set('research-document', { data: report(plan()) });
  state.responses = new Map([['/api/investment-strategies/import-source', { id: 'saved-draft' }]]);
  let copied = '';
  Object.defineProperty(dom.window.navigator, 'clipboard', { value: { async writeText(value) { copied = value; } } });
  const Component = load('components/ReportExecutionPlan.tsx').default;
  function Location() { const location = useLocation(); return React.createElement('output', null, location.pathname + location.search + location.hash); }
  await React.act(async () => root.render(React.createElement(MemoryRouter, null, React.createElement(Component, { versionId: 'exact-version' }), React.createElement(Location))));
  const button = label => [...document.querySelectorAll('button')].find(item => item.textContent === label);
  await React.act(async () => button('Copy strategy text').click());
  assert.match(copied, /Buy 2 AAPL/); assert.match(copied, /Single-position cap: 10%/); assert.match(copied, /Asia\/Shanghai/);
  assert.doesNotMatch(copied, /schemaVersion|numericEvidence/); assert.match(document.body.textContent, /Strategy text copied/);
  assert.equal(state.requests.length, 0, 'clipboard copying never changes a strategy');
  await React.act(async () => button('Copy to AI simulation').click());
  assert.equal(state.requests.length, 1);
  assert.equal(state.requests[0].args[0], '/api/investment-strategies/import-source');
  assert.deepEqual(JSON.parse(JSON.stringify(state.requests[0].args[1].source)), { kind: 'report', versionId: 'exact-version', sectionId: 'execution-strategy' });
  assert.equal(document.querySelector('output').textContent, '/paper?investmentStrategyId=saved-draft#investment-strategy');
}));

test('failed one-click imports stay on the report with a retry and no application', async () => withDom(async ({ root }) => {
  const { load, state } = fixture(); state.queries.set('research-document', { data: report(plan()) });
  let imports = 0; load('api/investment-strategies.ts').investmentStrategiesApi.importSource = async () => { imports++; throw Error('network'); };
  const Component = load('components/ReportExecutionPlan.tsx').default;
  await React.act(async () => root.render(React.createElement(MemoryRouter, null, React.createElement(Component, { versionId: 'exact-version' }))));
  const button = () => [...document.querySelectorAll('button')].find(item => item.textContent === 'Copy to AI simulation');
  await React.act(async () => button().click());
  assert.equal(imports, 1); assert.match(document.body.textContent, /Could not copy the strategy/); assert.equal(button().disabled, false);
  assert.equal(state.requests.length, 0);
}));

test('clipboard failure leaves readable strategy text available for manual copying', async () => withDom(async ({ dom, root }) => {
  const { load, state } = fixture(); state.queries.set('research-document', { data: report(plan()) });
  Object.defineProperty(dom.window.navigator, 'clipboard', { value: { async writeText() { throw new Error('denied'); } } });
  const Component = load('components/ReportExecutionPlan.tsx').default;
  await React.act(async () => root.render(React.createElement(MemoryRouter, null, React.createElement(Component, { versionId: 'exact-version', onAddToStrategy() {} }))));
  await React.act(async () => [...document.querySelectorAll('button')].find(item => item.textContent === 'Copy strategy text').click());
  assert.match(document.body.textContent, /Select the strategy text below to copy it/);
  assert.match(document.querySelector('textarea[readonly]').value, /Buy 2 AAPL/);
}));
