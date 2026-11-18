const { test } = require('node:test');
const assert = require('node:assert/strict');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { MemoryRouter } = require('react-router-dom');
const { QueryClient, QueryClientProvider } = require('@tanstack/react-query');
const { JSDOM } = require('jsdom');
const fixture = require('./simple-test-loader.cjs');

function commission(acceptedAttemptId = 'work-accepted') {
  const delivery = { conclusion: 'A fictional conclusion with an unresolved cost assumption', evidenceIds: ['source-version-one'], asOf: '2026-11-12T01:00:00Z', currency: 'USD', units: 'millions', assumptions: ['Stable revenue classification'], gaps: ['Missing audited liquidity note'], skillVersions: [], response: { text: 'Original fictional result' } };
  return { id: 'commission', teamId: 'team', teamVersionId: 'team-version', bindingId: 'binding', bindingRevision: 2, sessionId: 'session', cycleId: 'cycle',
    members: [{ memberId: 'member', roleId: 'analyst', label: 'Fictional analyst' }], links: [],
    plan: { work: [{ workKey: 'exact-work', inputRefs: [{ kind: 'report_version', id: 'source-version-one', revision: '1', availability: 'available' }] }] },
    tasks: [{ id: 'task', memberId: 'member', workKey: 'exact-work', key: 'specialist', state: 'accepted', reason: null, revision: 1, acceptedAttemptId, delivery,
      attempts: [{ id: 'work-accepted', kind: 'work', state: 'succeeded', revision: 1, startedAt: '2026-11-12T02:00:00Z', delivery }, { id: 'later-review', kind: 'review', state: 'succeeded', revision: 1, startedAt: '2026-11-12T02:01:00Z', externalUsageUnknown: true, review: { accepted: true, feedback: 'Fictional structural review' } }] }] };
}

test('accepted delivery preserves evidence, limits and external unknown usage without claiming adoption or fills', () => {
  const f = fixture(); const Component = f.load('features/teams/TeamWorkHistory.tsx').TeamTaskDeliveries;
  const html = f.render(Component, { commission: commission(), zh: false, review() {}, editable: true });
  assert.match(html, /Structure accepted/); assert.match(html, /Missing audited liquidity note/); assert.match(html, /Stable revenue classification/);
  assert.match(html, /External usage and cost unknown/); assert.match(html, /Factual correctness still requires content review/);
  assert.match(html, /Record content review and decision/); assert.doesNotMatch(html, /Policy applied|Simulated fill/);
});

test('the most recent reviewer cannot replace the accepted work attempt in a decision basis', () => {
  const f = fixture(); const Component = f.load('features/teams/TeamWorkHistory.tsx').TeamTaskDeliveries;
  const html = f.render(Component, { commission: commission('later-review'), zh: false, review() {}, editable: true });
  assert.doesNotMatch(html, /Record content review and decision/);
  assert.match(html, /Fictional structural review/);
});

test('Chinese delivery states keep structural acceptance distinct from factual judgment', () => {
  const f = fixture(); const Component = f.load('features/teams/TeamWorkHistory.tsx').TeamTaskDeliveries;
  const html = f.render(Component, { commission: commission(), zh: true, review() {}, editable: false });
  assert.match(html, /结构验收通过/); assert.match(html, /事实正确性仍需内容复核/); assert.match(html, /外部用量与费用未知/); assert.match(html, /disabled=""/);
});

test('history retains the exact delivery and decision receipts and shows actions only for readable reports', () => {
  const f = fixture({ realQuery: true });
  const { TeamWorkHistory } = f.load('features/teams/TeamWorkHistory.tsx');
  const { teamKeys } = f.load('api/teams.ts');
  const client = new QueryClient();
  const team = { id: 'team', scopeRevision: 2 };
  const record = { ...commission(), accountId: 'paper', state: 'completed',
    cost: { confirmed: { amount: '0', currency: 'USD' }, reserved: { amount: '0', currency: 'USD' }, unknownAttemptIds: [] } };
  const link = { id: 'receipt', kind: 'report_version', relation: 'produced', targetId: 'exact-version',
    targetRevision: '2', workKey: 'exact-work', attemptId: 'work-accepted' };
  const decision = { id: 'decision', teamId: team.id, proposalId: 'proposal', proposalRevision: 1, event: 'observe',
    reason: 'Review the original assumptions', basis: { reportVersionId: link.targetId, workKey: link.workKey } };
  const page = items => ({ pages: [{ items, nextCursor: null }], pageParams: [undefined] });
  client.setQueryData(teamKeys.commissions(team.id), page([]));
  try {
    for (const reportAvailable of [true, false, undefined]) {
      client.setQueryData([...teamKeys.commission(team.id, record.id), team.scopeRevision], { ...record, links: [{ ...link, reportAvailable }] });
      client.setQueryData([...teamKeys.decisions(team.id), 'all', team.scopeRevision], page([{ ...decision, reportAvailable }]));
      const element = React.createElement(TeamWorkHistory, { team, zh: false, online: true, commissionId: record.id, selectCommission() {} });
      const html = renderToStaticMarkup(React.createElement(QueryClientProvider, { client }, React.createElement(MemoryRouter, null, element)));
      const doc = JSDOM.fragment(html);
      const receipt = doc.querySelector('.team-source-row').textContent;
      assert.match(receipt, /exact-version · 2/);
      assert.match(receipt, /exact-work · work-accepted/);
      assert.match(doc.querySelector('.team-decision').textContent, /Review the original assumptions/);
      assert.equal(doc.querySelectorAll('a[href="/analysis/reports/exact-version"]').length, reportAvailable === true ? 2 : 0);
      const buttons = [...doc.querySelectorAll('button')].map(button => button.textContent);
      for (const label of ['Record content decision', 'Record content review and decision', 'Record next decision']) {
        assert.equal(buttons.includes(label), reportAvailable === true, label);
      }
    }
  } finally { client.clear(); }
});
