const { test } = require('node:test');
const assert = require('node:assert/strict');
const fixture = require('./simple-test-loader.cjs');

test('team transport keeps team and commission identities in every mutation URL', async () => {
  const { state, load } = fixture();
  const { teamsApi } = load('api/teams.ts');
  await teamsApi.saveLayout('team/a', { requestKey: 'layout-key', expectedLayoutRevision: 4, layout: {} });
  await teamsApi.saveDraft('team/a', { requestKey: 'draft-key', expectedSemanticRevision: 9, config: {} });
  await teamsApi.recoverCommission('team/a', 'commission/b', { requestKey: 'check-key', expectedCommissionRevision: 7, action: 'check_existing' });
  assert.deepEqual(state.requests.map(r => [r.method, r.args[0]]), [
    ['put', '/api/teams/team%2Fa/layout'], ['put', '/api/teams/team%2Fa/draft'], ['post', '/api/teams/team%2Fa/commissions/commission%2Fb/recover'],
  ]);
  assert.equal(state.requests[0].args[1].expectedLayoutRevision, 4);
  assert.equal(state.requests[1].args[1].expectedSemanticRevision, 9);
  assert.equal(state.requests[2].args[1].action, 'check_existing');
  assert.throws(() => teamsApi.detail(''), /explicit team/i);
});

test('query keys partition snapshots by team and commission', () => {
  const { teamKeys } = fixture().load('api/teams.ts');
  assert.notDeepEqual(teamKeys.detail('A'), teamKeys.detail('B'));
  assert.notDeepEqual(teamKeys.commission('A', 'one'), teamKeys.commission('A', 'two'));
});
