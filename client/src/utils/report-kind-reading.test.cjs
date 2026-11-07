const assert = require('node:assert/strict');
const { test } = require('node:test');
const fixture = require('./simple-test-loader.cjs');

test('daily report history defaults to research and offers an explicit ledger review category', () => {
  const { load, render } = fixture();
  const html = render(load('pages/Analysis/ReportHistory.tsx').default);
  assert.match(html, /Report type/);
  assert.match(html, /value="daily" selected/);
  assert.match(html, /Simulation ledger reviews/);
});

test('report history names a source-less simulation review as bookkeeping', () => {
  const { state, load, render } = fixture();
  state.queries.set('report-history', { data: { items: [{ id: 'ledger-review', category: 'review',
    title: 'Daily simulation review', source: null, topicKey: 'portfolio', createdAt: '2026-11-06T16:00:00Z' }], total: 1 } });
  const html = render(load('pages/Analysis/ReportHistory.tsx').default);
  assert.match(html, /Simulation ledger review/);
  assert.match(html, /\/analysis\/reports\/ledger-review/);
  assert.doesNotMatch(html, /Portfolio · Analysis/);
});

test('a simulation report reader explains its scope and links back to holdings research', () => {
  const { state, load, render } = fixture();
  const review = { accountId: 'account', from: '2026-11-06', to: '2026-11-06', timezone: 'Asia/Shanghai',
    orders: 0, feesUsd: '0.00', gaps: [], initialEquityUsd: '1000.00', endingEquityUsd: '1000.00' };
  state.queries.set('research-document', { data: { version: { id: 'ledger', kind: 'council', source: null,
    createdAt: '2026-11-06T16:00:00Z', title: 'Daily simulation review', snapshot: {
      experimentId: 'account', from: review.from, to: review.to, review },
    sections: [{ id: 'performance', title: 'Performance', content: JSON.stringify(review) }] } } });
  const html = render(load('pages/Analysis/SimpleReportReader.tsx').default, { versionId: 'ledger' });
  assert.match(html, /Simulation ledger review · Read only/);
  assert.match(html, /Holdings findings are in the daily research reports/);
  assert.match(html, /href="\/analysis#report-history"/);
});
