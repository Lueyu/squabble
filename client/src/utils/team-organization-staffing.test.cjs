const { test } = require('node:test');
const assert = require('node:assert/strict');
const fixture = require('./simple-test-loader.cjs');

const f = fixture();
const staffing = f.load('features/teams/team-staffing.ts');
const models = [{ id: 'saved-model', available: true, fastModel: 'fast-name', slowModel: 'slow-name' }];
const agent = (patch = {}) => ({
  id: 'friend', name: 'Friend', specialty: 'Company analysis', status: 'active', availability: 'configured',
  currentVersionId: 'friend-v2',
  currentVersion: { config: { templateId: 'financials', executor: { executionMode: 'model', connectionId: 'saved-model', model: 'slow' }, allowedToolIds: ['read_quotes'], allowedSources: [{ id: 'personal-source' }] } },
  ...patch,
});
const state = () => ({
  config: {
    schemaVersion: 1, departments: [], relations: [], defaults: { leadRoleId: 'seat', parallelism: 1 },
    roles: [{ id: 'seat', departmentId: null, participation: 'placeholder', responsibility: 'Keep the chosen duties', expectedOutput: 'Keep the chosen delivery', executor: null, allowedToolIds: [], sourceGrantIds: ['team-source'] }],
  },
  display: { name: 'Team', avatar: null, roleLabels: { seat: 'Financials' }, departmentLabels: {} },
  layout: { schemaVersion: 1, positions: { seat: { x: 20, y: 30 } }, collapsedDepartmentIds: [], viewport: { x: 0, y: 0, zoom: 0.63 } },
});

test('explicit staffing pins the chosen version and saved connection while retaining seat duties and grants', () => {
  assert.equal(typeof staffing.assignAgentToRole, 'function', 'the shared staffing command must exist');
  const before = state();
  const snapshot = JSON.stringify(before);
  const result = staffing.assignAgentToRole(before, 'seat', 'friend', [agent()], models);
  const seat = result.config.roles[0];
  assert.equal(seat.agentId, 'friend');
  assert.equal(seat.agentVersionId, 'friend-v2');
  assert.equal(seat.executor.connectionId, 'saved-model');
  assert.equal(seat.executor.model, 'slow-name');
  assert.equal(seat.executor.tier, 'slow');
  assert.equal(seat.participation, 'enabled');
  assert.equal(seat.responsibility, 'Keep the chosen duties');
  assert.equal(seat.expectedOutput, 'Keep the chosen delivery');
  assert.equal(JSON.stringify(seat.allowedToolIds), '["read_quotes"]');
  assert.equal(JSON.stringify(seat.sourceGrantIds), '["team-source"]', 'personal source access is never imported');
  assert.equal(result.layout, before.layout);
  assert.equal(result.display, before.display);
  assert.equal(JSON.stringify(before), snapshot, 'the input stays available for undo');
});

test('archived and disconnected friends cannot replace an existing seat binding', () => {
  assert.equal(typeof staffing.assignAgentToRole, 'function', 'the shared staffing command must exist');
  for (const [candidate, code] of [[agent({ status: 'archived' }), 'agent_archived'], [agent({ availability: 'unavailable' }), 'agent_unavailable']]) {
    const before = state();
    const snapshot = JSON.stringify(before);
    assert.throws(() => staffing.assignAgentToRole(before, 'seat', 'friend', [candidate], models), error => error.code === code);
    assert.equal(JSON.stringify(before), snapshot);
  }
});

test('staffing rejects unavailable saved models, stale targets and readonly drafts', () => {
  assert.equal(typeof staffing.assignAgentToRole, 'function', 'the shared staffing command must exist');
  const before = state();
  for (const args of [
    ['seat', 'friend', [agent()], [], {}, 'connection_unavailable'],
    ['gone', 'friend', [agent()], models, {}, 'role_missing'],
    ['seat', 'gone', [agent()], models, {}, 'agent_missing'],
    ['seat', 'friend', [agent()], models, { readOnly: true }, 'read_only'],
  ]) {
    const [roleId, agentId, roster, connections, options, code] = args;
    assert.throws(() => staffing.assignAgentToRole(before, roleId, agentId, roster, connections, options), error => error.code === code);
  }
});

test('staffing preserves local executor settings without sharing mutable agent tool arrays', () => {
  assert.equal(typeof staffing.assignAgentToRole, 'function', 'the shared staffing command must exist');
  const candidate = agent();
  candidate.currentVersion.config.executor = { executionMode: 'local', localAgentId: 'local-helper', settings: { profile: 'research' } };
  const result = staffing.assignAgentToRole(state(), 'seat', 'friend', [candidate], []);
  assert.equal(result.config.roles[0].executor.localAgentId, 'local-helper');
  assert.equal(result.config.roles[0].executor.settings.profile, 'research');
  result.config.roles[0].allowedToolIds.push('another');
  assert.equal(candidate.currentVersion.config.allowedToolIds.length, 1);
});
