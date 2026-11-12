const { test } = require('node:test');
const assert = require('node:assert/strict');
const fixture = require('./simple-test-loader.cjs');

function state() {
  return {
    config: { schemaVersion: 1, departments: [{ id: 'research', parentDepartmentId: null, purpose: '' }, { id: 'risk', parentDepartmentId: 'research', purpose: '' }],
      roles: ['analyst', 'lead', 'risk-lead'].map(id => ({ id, departmentId: id === 'analyst' ? 'risk' : 'research', participation: 'placeholder', responsibility: '', expectedOutput: '', executor: null, allowedToolIds: [], sourceGrantIds: [] })),
      relations: [
        { id: 'r1', fromRoleId: 'analyst', toRoleId: 'lead', kind: 'reports_to', responsibilityScope: 'Evidence' },
        { id: 'r2', fromRoleId: 'analyst', toRoleId: 'risk-lead', kind: 'reports_to', responsibilityScope: 'Risk' },
      ], defaults: { leadRoleId: 'lead', parallelism: 1 } },
    display: { name: 'Research', avatar: null, departmentLabels: { research: 'Research', risk: 'Risk' }, roleLabels: { analyst: 'Analyst', lead: 'Lead', 'risk-lead': 'Risk lead' } },
    layout: { schemaVersion: 1, positions: { research: { x: 10, y: 20 }, risk: { x: 30, y: 40 }, analyst: { x: 50, y: 60 } }, collapsedDepartmentIds: [], viewport: { x: 0, y: 0, zoom: 1 } },
  };
}

test('matrix reporting stays legal while responsibility cycles and duplicate scopes are located', () => {
  const { validateTeamGraph } = fixture().load('features/teams/team-graph.ts');
  const value = state();
  assert.equal(validateTeamGraph(value.config).length, 0);
  value.config.relations.push({ id: 'cycle', fromRoleId: 'lead', toRoleId: 'analyst', kind: 'reports_to', responsibilityScope: 'Direction' });
  assert.ok(validateTeamGraph(value.config).some(issue => issue.code === 'REPORTING_CYCLE' && issue.objectIds.includes('analyst')));
  value.config.relations.pop();
  value.config.relations.push({ ...value.config.relations[0], id: 'duplicate' });
  assert.ok(validateTeamGraph(value.config).some(issue => issue.code === 'DUPLICATE_RELATION'));
  value.config.relations.pop();
  value.config.relations.push({ id: 'collaborate', fromRoleId: 'lead', toRoleId: 'analyst', kind: 'reviews', responsibilityScope: 'Review' });
  assert.equal(validateTeamGraph(value.config).length, 0);
});

test('department dissolve preserves children, cross-group reporting and absolute coordinates', () => {
  const { dissolveDepartment, absolutePosition } = fixture().load('features/teams/team-graph.ts');
  const before = state();
  const absolute = absolutePosition(before, 'analyst');
  const after = dissolveDepartment(before, 'risk', false);
  assert.equal(after.config.roles[0].departmentId, 'research');
  assert.deepEqual(after.config.relations, before.config.relations);
  assert.deepEqual(absolutePosition(after, 'analyst'), absolute);
  assert.equal(before.config.roles[0].departmentId, 'risk', 'edits do not mutate history');
});

test('nested grouping rejects descendants and undo restores both grouping and position', () => {
  const { moveTeamObjects, createTeamHistory, commitTeamEdit, undoTeamEdit, redoTeamEdit } = fixture().load('features/teams/team-graph.ts');
  const initial = state();
  assert.throws(() => moveTeamObjects(initial, ['research'], 'risk'), /descendant|自身|后代/i);
  const moved = moveTeamObjects(initial, ['analyst'], null);
  assert.equal(moved.config.roles[0].departmentId, null);
  assert.deepEqual(JSON.parse(JSON.stringify(moved.layout.positions.analyst)), { x: 90, y: 120 });
  const history = commitTeamEdit(createTeamHistory(initial), moved);
  assert.deepEqual(undoTeamEdit(history).present, initial);
  assert.deepEqual(redoTeamEdit(undoTeamEdit(history)).present, moved);
});

test('role deletion clears only current draft references and preserves immutable input', () => {
  const { deleteTeamObjects } = fixture().load('features/teams/team-graph.ts');
  const initial = state();
  const next = deleteTeamObjects(initial, ['lead']);
  assert.equal(next.config.defaults.leadRoleId, null);
  assert.equal(next.config.relations.length, 1);
  assert.equal(initial.config.relations.length, 2);
  assert.equal(initial.config.defaults.leadRoleId, 'lead');
});

test('a cost ceiling is required and external unknown cost never becomes a free call', () => {
  const { validateCommissionForm, teamCostLabel } = fixture().load('features/teams/team-commission-state.ts');
  const form = { objective: 'Research', expectedOutput: 'Evidence', leadRoleId: 'lead', participantRoleIds: ['lead'], deadlineAt: '2026-11-13T12:00:00.000Z', dataCutoffAt: '', budgetMode: 'cost_and_calls', amount: '', currency: 'USD', callLimit: '3', paidRevisionLimit: '0', parallelism: 1 };
  assert.ok(validateCommissionForm(form, '2026-11-12T12:00:00.000Z').some(issue => issue.field === 'amount'));
  assert.equal(validateCommissionForm({ ...form, budgetMode: 'calls_only' }, '2026-11-12T12:00:00.000Z').length, 0);
  assert.match(teamCostLabel({ confirmed: { amount: null, currency: 'USD' }, reserved: { amount: null, currency: 'USD' }, estimatedMaximum: { amount: null, currency: 'USD' }, externalUsageUnknown: true, unknownAttemptIds: ['attempt'] }, false), /unknown/i);
});

test('the thirtieth role remains editable while additions and oversized copies are rejected atomically', () => {
  const { addTeamObject, duplicateTeamObjects } = fixture().load('features/teams/team-graph.ts');
  const initial = state();
  initial.config.roles = Array.from({ length: 30 }, (_, index) => ({ ...initial.config.roles[0], id: `role-${index}` }));
  assert.throws(() => addTeamObject(initial, 'role', null, 'Extra role', 'extra'), /30/);
  assert.throws(() => duplicateTeamObjects(initial, ['role-0', 'role-1'], 'copy'), /30/);
  assert.equal(initial.config.roles.length, 30);
  assert.equal(initial.config.roles[0].id, 'role-0');
});

test('a restored historical version removes newer geometry and keeps current team presentation', () => {
  const { restoreTeamVersion } = fixture().load('features/teams/team-graph.ts');
  const current = state();
  current.layout.positions.newer = { x: 999, y: 999 };
  current.layout.collapsedDepartmentIds.push('newer');
  const old = state();
  const restored = restoreTeamVersion(current, { config: old.config, displaySnapshot: { ...old.display, name: 'Historical name' } });
  assert.equal(restored.display.name, current.display.name);
  assert.equal(restored.layout.positions.newer, undefined);
  assert.equal(restored.layout.collapsedDepartmentIds.includes('newer'), false);
  assert.equal(current.layout.positions.newer.x, 999);
});

test('duplicate executing participants require correction instead of silently shrinking the authorization', () => {
  const { validateCommissionForm } = fixture().load('features/teams/team-commission-state.ts');
  const form = { objective: 'Research', expectedOutput: 'Evidence', leadRoleId: 'lead', participantRoleIds: ['lead', 'lead'], deadlineAt: '2026-11-13T12:00:00.000Z', dataCutoffAt: '', budgetMode: 'cost_and_calls', amount: '1.00', currency: 'USD', callLimit: '3', paidRevisionLimit: '0', parallelism: 1 };
  assert.ok(validateCommissionForm(form, '2026-11-12T12:00:00.000Z').some(issue => issue.field === 'participantRoleIds'));
});

test('a placeholder default lead is never preselected as a disabled executing participant', () => {
  const { teamLeadSuggestion } = fixture().load('features/teams/team-commission-state.ts');
  const config = state().config;
  assert.equal(typeof teamLeadSuggestion, 'function');
  assert.equal(teamLeadSuggestion(config), '');
  config.roles.find(role => role.id === 'lead').participation = 'enabled';
  config.roles.find(role => role.id === 'lead').executor = { executionMode: 'local', localAgentId: 'native', settings: {} };
  assert.equal(teamLeadSuggestion(config), 'lead');
});

test('organization views keep a linked person’s animal and name separate from a changed seat label', () => {
  const f = fixture();
  const value = state();
  value.config.roles[0].agentId = 'cat'; value.config.roles[1].agentId = 'bear';
  value.display.roleLabels.analyst = 'Manager'; value.display.roleLabels.lead = 'Challenger';
  const profiles = [{ id: 'cat', name: 'Cashflow cat', specialty: 'Cash flow', avatar: 'technical' }, { id: 'bear', name: 'Evidence bear', specialty: 'Check evidence', avatar: 'risk' }];
  f.state.queries.set('agent-roster', { data: { items: profiles } });
  const { toTeamFlow } = f.load('features/teams/team-flow-adapter.ts');
  const nodes = toTeamFlow(value, [], 'all', false, profiles).nodes;
  assert.equal(nodes.find(node => node.id === 'analyst').data.avatar, 'technical');
  assert.equal(nodes.find(node => node.id === 'analyst').data.agentName, 'Cashflow cat');
  assert.equal(nodes.find(node => node.id === 'lead').data.avatar, 'risk');
  const { TeamOutline } = f.load('features/teams/TeamOutline.tsx');
  const html = f.render(TeamOutline, { state: value, selected: [], select() {}, edit() {}, locate() {}, zh: false, readOnly: false });
  assert.match(html, /Cashflow cat/); assert.match(html, /Evidence bear/);
  assert.match(html, /data-persona="technical"/); assert.match(html, /data-persona="risk"/);
  assert.match(html, /Manager/);
});
