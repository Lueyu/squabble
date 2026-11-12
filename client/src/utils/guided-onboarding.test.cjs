const { test } = require('node:test');
const assert = require('node:assert/strict');
const fixture = require('./simple-test-loader.cjs');
const plain = value => JSON.parse(JSON.stringify(value));

test('onboarding follows saved holdings, persistent friends and an actually running team', () => {
  const { onboardingSteps } = fixture().load('features/onboarding/onboarding-state.ts');
  const steps = onboardingSteps({ hasHoldings: true, hasFriends: false, hasRunningTeam: false });
  assert.deepEqual(plain(steps.map(s => s.id)), ['holdings', 'friends', 'team']);
  assert.deepEqual(plain(steps.map(s => s.complete)), [true, false, false]);
  assert.equal(steps.find(s => !s.complete).path, '/friends');
});

test('a saved team is not mislabelled as autonomous before startup confirmation', () => {
  const { onboardingSteps } = fixture().load('features/onboarding/onboarding-state.ts');
  assert.equal(onboardingSteps({ hasHoldings: true, hasFriends: true, hasRunningTeam: false })[2].complete, false);
});

test('default agent connection reuses a usable model and never selects missing credentials', () => {
  const { defaultAgentExecutor } = fixture().load('features/agent-roster/agent-roster-state.ts');
  const models = [{ id: 'bad', available: false, fastModel: 'x' }, { id: 'good', available: true, fastModel: 'x' }];
  assert.deepEqual(plain(defaultAgentExecutor(models, [])), { executionMode: 'model', connectionId: 'good', model: 'fast' });
  assert.equal(defaultAgentExecutor([models[0]], []), null);
});

test('archived friends are not selectable and distinct friends on the same model remain distinct', () => {
  const { activeAgentSelections } = fixture().load('features/agent-roster/agent-roster-state.ts');
  const rows = [{ id: 'a', currentVersionId: 'v1', status: 'active' }, { id: 'b', currentVersionId: 'v2', status: 'active' }, { id: 'c', currentVersionId: 'v3', status: 'archived' }];
  assert.deepEqual(plain(activeAgentSelections(rows)), [{ agentId: 'a', agentVersionId: 'v1' }, { agentId: 'b', agentVersionId: 'v2' }]);
});
