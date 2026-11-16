const { test } = require('node:test');
const assert = require('node:assert/strict');
const { getSmoothStepPath, Position } = require('@xyflow/react');
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
  const edges = toTeamFlow(value, [], 'all', false).edges.filter(edge => edge.id !== 'other');
  const paths = edges.map(edge => {
    const reverse = edge.source === 'lead';
    return getSmoothStepPath({ sourceX: reverse ? 350 : 100, sourceY: reverse ? 60 : 250, sourcePosition: Position.Bottom, targetX: reverse ? 100 : 350, targetY: reverse ? 250 : 60, targetPosition: Position.Top, ...edge.pathOptions })[0];
  });
  assert.equal(new Set(paths).size, 3, 'multiple relations between the same pair need separate visible routes');
  assert.equal(edges.find(edge => edge.id === 'review').source, 'lead');
  assert.equal(edges.find(edge => edge.id === 'review').target, 'financials');
  assert.ok(edges.every(edge => edge.markerEnd));
});
