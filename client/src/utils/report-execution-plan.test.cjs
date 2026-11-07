const assert = require('node:assert/strict');
const { test } = require('node:test');
const React = require('react');
const { createRoot } = require('react-dom/client');
const { MemoryRouter } = require('react-router-dom');
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
function report(value) { return { version: { id: 'exact-version', status: 'valid', sourceStatus: 'available', snapshot: value ? { executionPlan: value } : {} } }; }

test('the execution plan shows readable strategy text, readiness and one-click actions', () => {
  const { load, render, state } = fixture();
  state.queries.set('research-document', { data: report(plan()) });
  const html = render(load('components/ReportExecutionPlan.tsx').default, { versionId: 'exact-version' });
  assert.match(html, /Monitoring execution strategy/);
  assert.match(html, /\bReady\b/);
  assert.match(html, new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(html, /BUY AAPL/);
  assert.match(html, /Apply to simulation/);
  assert.match(html, />\s*Copy\s*</);
  assert.doesNotMatch(html, /schemaVersion|numericEvidence|plan-hash/);
  state.language = 'zh-CN';
  const chinese = render(load('components/ReportExecutionPlan.tsx').default, { versionId: 'exact-version' });
  assert.match(chinese, /监控执行策略/);
  assert.match(chinese, /可执行/);
  assert.match(chinese, /一键应用到模拟盘/);
});

test('needs-review and observation-only reports get honest readiness labels', () => {
  const { load, render, state } = fixture(); const Component = load('components/ReportExecutionPlan.tsx').default;
  state.queries.set('research-document', { data: report(plan({ readiness: 'needs_info', gaps: ['Confirm the intended quantity.'] })) });
  let html = render(Component, { versionId: 'exact-version' });
  assert.match(html, /Needs review/); assert.doesNotMatch(html, /\bReady\b/);
  state.queries.set('research-document', { data: report(plan({ readiness: 'no_trade' })) });
  html = render(Component, { versionId: 'exact-version' });
  assert.match(html, /Observation only/); assert.doesNotMatch(html, /\bReady\b/);
});

test('a report without an execution plan renders nothing', () => {
  const { load, render, state } = fixture();
  state.queries.set('research-document', { data: report() });
  const html = render(load('components/ReportExecutionPlan.tsx').default, { versionId: 'exact-version' });
  assert.equal(html, '');
});

async function withDom(run) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' });
  const previous = { window: global.window, document: global.document, act: global.IS_REACT_ACT_ENVIRONMENT };
  global.window = dom.window; global.document = dom.window.document; global.IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(document.getElementById('root'));
  try { await run({ dom, root }); } finally { await React.act(async () => root.unmount()); dom.window.close(); global.window = previous.window; global.document = previous.document; global.IS_REACT_ACT_ENVIRONMENT = previous.act; }
}

test('copying preserves the readable plan text without internal fields', async () => withDom(async ({ dom, root }) => {
  const { load, state } = fixture(); state.queries.set('research-document', { data: report(plan()) });
  let copied = '';
  Object.defineProperty(dom.window.navigator, 'clipboard', { value: { async writeText(value) { copied = value; } } });
  const Component = load('components/ReportExecutionPlan.tsx').default;
  await React.act(async () => root.render(React.createElement(MemoryRouter, null, React.createElement(Component, { versionId: 'exact-version' }))));
  const button = label => [...document.querySelectorAll('button')].find(item => item.textContent.trim() === label);
  await React.act(async () => button('Copy').click());
  assert.match(copied, /Measured buying plan/);
  assert.match(copied, new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(copied, /schemaVersion|numericEvidence/);
  // Let the copied-state reset timer fire while the component is still mounted.
  await React.act(async () => new Promise(resolve => setTimeout(resolve, 1600)));
}));

test('one-click apply posts the quick-apply request and confirms success', async () => withDom(async ({ root }) => {
  const { load, state } = fixture(); state.queries.set('research-document', { data: report(plan()) });
  const Component = load('components/ReportExecutionPlan.tsx').default;
  await React.act(async () => root.render(React.createElement(MemoryRouter, null, React.createElement(Component, { versionId: 'exact-version' }))));
  const button = label => [...document.querySelectorAll('button')].find(item => item.textContent.trim() === label);
  await React.act(async () => button('Apply to simulation').click());
  const applyCalls = state.requests.filter(r => r.method === 'post' && String(r.args[0]).includes('/quick-apply'));
  assert.equal(applyCalls.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(applyCalls[0].args[1])), { versionId: 'exact-version', requestKey: 'request-key' });
  assert.match(document.body.textContent, /Applied — view simulation/);
}));
