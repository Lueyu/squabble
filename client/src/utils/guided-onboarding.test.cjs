const { test } = require('node:test');
const assert = require('node:assert/strict');
const fixture = require('./simple-test-loader.cjs');
const plain = value => JSON.parse(JSON.stringify(value));

const model = { id: 'model', available: true, fastModel: 'fast' };
const local = { connectionId: 'local', connected: true, executable: true };
const tested = { ...model, testState: 'passed', testedAt: '2026-11-18T00:00:00Z' };

test('onboarding accepts either a ready local agent or a tested model API', () => {
  const { usableAiConnection } = fixture().load('features/onboarding/onboarding-state.ts');
  const busy = { ...local, executable: false, state: 'busy' };
  assert.equal(usableAiConnection([busy], [model]), null);
  assert.equal(usableAiConnection([busy], [{ ...tested, available: false }]), null);
  assert.equal(usableAiConnection([busy], [{ ...tested, testState: 'failed' }]), null);
  assert.equal(usableAiConnection([busy], [tested])?.kind, 'model');
  assert.equal(usableAiConnection([local], [model])?.kind, 'local');
});

test('progress resumes from saved holdings, readiness or the actual existing team agreement', () => {
  const { onboardingNext, usableAiConnection } = fixture().load('features/onboarding/onboarding-state.ts');
  const empty = { hasHoldings: false, connection: null, connectionPath: '/settings/models?onboarding=1',
    team: null, agreementState: null, hasCreationProgress: false };
  assert.equal(onboardingNext(empty).step, 'holdings');
  const imported = { ...empty, hasHoldings: true };
  assert.equal(onboardingNext(imported).path, '/settings/models?onboarding=1');
  const ready = { ...imported, connection: usableAiConnection([], [tested]) };
  assert.equal(onboardingNext(ready).path, '/teams?guided=1');
  const existing = { ...empty, team: { id: 'existing' } };
  assert.match(onboardingNext(existing).path, /teams\/existing\?panel=overview/);
  assert.equal(onboardingNext({ ...existing, agreementState: 'paused' }).agreementState, 'paused');
  assert.equal(onboardingNext({ ...existing, agreementState: 'suspended' }).agreementState, 'suspended');
  assert.equal(onboardingNext({ ...existing, agreementState: 'running' }), null);
  assert.equal(onboardingNext({ ...existing, hasCreationProgress: true }).path, '/teams?guided=1');
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
