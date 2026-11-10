const assert = require('node:assert/strict');
const { test } = require('node:test');
const fixture = require('./simple-test-loader.cjs');

test('daily separates real unknown values, independent accounts, initial research and discussion', () => {
  const { state, load, render } = fixture();
  state.queries.set('daily-workspace', { data: {
    date: '2026-11-10', readAt: '2026-11-10T08:00:00Z', timezone: 'Asia/Shanghai',
    personal: { returnBasis: { pnlUsd: null, endSnapshot: null }, transactions: [], gaps: [] },
    accounts: [
      { id: 'a', name: 'Fictional income account', status: 'paused', dailyPnlUsd: null, trades: [{ id: 'fill' }], notExecuted: [], gaps: ['VALUATION_TIME_UNKNOWN'] },
      { id: 'b', name: 'Fictional trend account', status: 'running', dailyPnlUsd: 7, trades: [], notExecuted: [{ id: 'rejected' }], gaps: [], companionId: 'technical' },
    ],
    reports: { initial: { documentId: 'initial', summary: 'Original independent finding', nextChecks: ['Recheck source date'] }, latestDiscussion: { documentId: 'discussion', summary: 'A later disagreement remains' } },
  } });
  const html = render(load('pages/Analysis/DailyReportPage.tsx').default);
  assert.match(html, /Fictional income account/);
  assert.match(html, /Fictional trend account/);
  assert.match(html, /Original independent finding/);
  assert.match(html, /A later disagreement remains/);
  assert.match(html, /Real ledger daily profit: —/);
  assert.match(html, /recorded 1 fills/);
  assert.match(html, /data-persona="user"/, 'unassigned accounts do not inherit an invented animal identity');
  assert.equal(state.requests.length, 0);
});

test('global memory distinguishes accepted research from user confirmation and labels page counts', () => {
  const { state, load, render } = fixture();
  state.queries.set('memory-inventory', { data: { total: 60, memories: [], theses: [{
    id: 'claim', ticker: 'TEST', market: 'US', topic: 'general', version: 3, status: 'accepted', excluded: false,
    sourceStatus: 'available', source: { reportCreatedAt: '2026-11-08T00:00:00Z', reportVersion: 2 },
    claim: 'Fictional source-backed observation', expiresAt: null,
  }] } });
  state.queries.set('channel-memory', { data: { items: [], reflections: [] } });
  const html = render(load('pages/Workspace/MemoryWorkspacePage.tsx').default);
  assert.match(html, /Research accepted/);
  assert.doesNotMatch(html, /User confirmed/);
  assert.match(html, /Eligible claims on page/);
  assert.match(html, /Unspecified; conditions still apply/);
  assert.match(html, /Fictional source-backed observation/);
});

test('data center shows configured availability without claiming fresh data', () => {
  const { state, load, render } = fixture();
  state.queries.set('integration-settings', { data: { financial: { provider: 'public', available: true } } });
  state.queries.set('import-batches', { data: [] });
  state.queries.set('data-archive-jobs', { data: { counts: { failed: 1 }, jobs: [] } });
  state.queries.set('model-connections', { data: [] });
  const html = render(load('pages/Workspace/DataCenterPage.tsx').default);
  assert.match(html, /configured source does not prove freshness/);
  assert.match(html, /No named model connections/);
  assert.doesNotMatch(html, /5 \/ 6|09:40|demo/);
  assert.equal(state.requests.length, 0);
});

test('research entry transfers a question for explicit sending and preserves old capability routes', () => {
  const { load, render } = fixture();
  const html = render(load('pages/Analysis/ResearchWorkspacePage.tsx').default);
  assert.match(html, /without calling a model/);
  for (const route of ['/research/portfolio', '/watchlist', '/settings/agents', '/analysis']) {
    assert.ok(html.includes(`href="${route}"`));
  }
  assert.match(html, /maxLength="2000"/i);
});
