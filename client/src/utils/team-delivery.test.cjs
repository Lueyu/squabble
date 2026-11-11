const { test } = require('node:test');
const assert = require('node:assert/strict');
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
