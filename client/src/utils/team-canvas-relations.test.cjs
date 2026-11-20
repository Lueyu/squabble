const { test } = require('node:test');
const assert = require('node:assert/strict');
const { MarkerType } = require('@xyflow/react');
const f = require('./simple-test-loader.cjs')();
const { toTeamFlow } = f.load('features/teams/team-flow-adapter.ts');

const state = () => ({
  config: {
    schemaVersion: 1, departments: [], defaults: { leadRoleId: 'lead', parallelism: 1 },
    roles: ['lead', 'financials', 'risk'].map(id => ({ id, departmentId: null, participation: 'placeholder', responsibility: 'Research', expectedOutput: '', executor: null, allowedToolIds: [], sourceGrantIds: [] })),
    relations: [
      { id: 'report', fromRoleId: 'financials', toRoleId: 'lead', kind: 'reports_to', responsibilityScope: 'Report findings' },
      { id: 'review', fromRoleId: 'lead', toRoleId: 'financials', kind: 'reviews', responsibilityScope: 'Check evidence' },
      { id: 'collaborate', fromRoleId: 'financials', toRoleId: 'lead', kind: 'delegates_to', responsibilityScope: 'Share questions' },
      { id: 'other', fromRoleId: 'risk', toRoleId: 'lead', kind: 'reports_to', responsibilityScope: 'Risk report' },
    ],
  },
  display: { name: 'Fixture', avatar: null, roleLabels: { lead: 'Lead', financials: 'Financials', risk: 'Risk' }, departmentLabels: {} },
  layout: { schemaVersion: 1, positions: {}, collapsedDepartmentIds: [], viewport: { x: 0, y: 0, zoom: 1 } },
});

test('selected relations view reveals all adjacent relation kinds without changing the saved organization', () => {
  const value = state();
  const snapshot = JSON.stringify(value);
  assert.equal(toTeamFlow(value, ['financials'], 'selected', false).edges.map(edge => edge.id).sort().join(','), 'collaborate,report,review');
  assert.equal(toTeamFlow(value, ['review'], 'selected', false).edges.map(edge => edge.id).join(','), 'review');
  assert.equal(toTeamFlow(value, [], 'selected', false).edges.length, 0);
  assert.equal(toTeamFlow(value, [], 'reports_to', false).edges.length, 2);
  assert.equal(JSON.stringify(value), snapshot);
});

test('relation labels stay hidden until that relation is selected and each edge retains an accessible name', () => {
  const normal = toTeamFlow(state(), [], 'all', false).edges;
  assert.ok(normal.every(edge => !edge.label), 'dense canvases must not render every label at rest');
  assert.ok(normal.every(edge => edge.ariaLabel?.includes('→')), 'keyboard users can identify endpoints and direction');
  const selected = toTeamFlow(state(), ['review'], 'all', false).edges;
  assert.equal(selected.filter(edge => edge.label).length, 1);
  assert.match(selected.find(edge => edge.id === 'review').label, /Check evidence/);
});

test('parallel relationships draw distinct routes and keep source and target direction', () => {
  const value = state();
  value.layout.positions = { financials: { x: 20, y: 50 }, lead: { x: 320, y: 50 }, risk: { x: 20, y: 250 } };
  const edges = toTeamFlow(value, [], 'all', false).edges.filter(edge => edge.id !== 'other');
  assert.equal(new Set(edges.map(edge => edge.data.offset)).size, 3);
  edges.forEach(edge => {
    const relation = value.config.relations.find(relation => relation.id === edge.id);
    assert.equal(edge.source, relation.fromRoleId);
    assert.equal(edge.target, relation.toRoleId);
    assert.equal(edge.type, 'teamParallel');
    assert.equal(edge.data.horizontal, true);
    assert.equal(edge.markerEnd.type, MarkerType.ArrowClosed);
  });
  assert.equal(edges.find(edge => edge.id === 'review').targetHandle, 'right-in');
  assert.equal(edges.find(edge => edge.id === 'report').targetHandle, 'left-in');
});
