const { test } = require('node:test'); const assert = require('node:assert/strict');
const fixture = require('./simple-test-loader.cjs'); const plain = v => JSON.parse(JSON.stringify(v));
const agents = ['financials', 'moderator'].map((templateId, index) => ({ id: `agent-${index}`, name: `Person ${index}`, specialty: templateId, description: 'Analyze evidence', status: 'active', currentVersionId: `v-${index}`, currentVersion: { config: { templateId, executor: { executionMode: 'model', connectionId: 'connection', model: 'fast' }, allowedToolIds: ['get_stock_price'] } } }));
test('guided team references existing people and versions rather than anonymously copying a model', () => {
  const { rosterTeamConfig } = fixture().load('features/teams/guided-team-state.ts');
  const config = rosterTeamConfig(agents, [{ id: 'connection', available: true, fastModel: 'fast-model', slowModel: 'slow-model' }], ['role-1', 'role-2']);
  assert.deepEqual(plain(config.roles.map(r => [r.agentId, r.agentVersionId])), [['agent-0', 'v-0'], ['agent-1', 'v-1']]);
  assert.equal(config.defaults.leadRoleId, 'role-2'); assert.equal(config.defaults.parallelism, 1);
  assert.equal(config.roles[0].executor.model, 'fast-model');
});
test('archived, duplicate and missing-connection members fail before creating a team', () => {
  const { rosterTeamConfig } = fixture().load('features/teams/guided-team-state.ts');
  assert.throws(() => rosterTeamConfig([agents[0], agents[0]], [], ['a', 'b']));
  assert.throws(() => rosterTeamConfig([{ ...agents[0], status: 'archived' }], [], ['a']));
  assert.throws(() => rosterTeamConfig([agents[0]], [], ['a']));
});
test('a daily limit yields finite run, daily and monthly ceilings and honest unknown-fee mode', () => {
  const { guidedRunBudget } = fixture().load('features/teams/guided-team-state.ts');
  const limits = guidedRunBudget('2', true); assert.equal(limits.daily.costUsd, '2.00');
  assert.equal(limits.perRun.ceiling.amount, '1.00'); assert.equal(limits.monthly.costUsd, '40.00');
  assert.equal(limits.perRun.budgetMode, 'calls_only'); assert(limits.monthly.calls > 0);
  assert.throws(() => guidedRunBudget('0', false));
});
