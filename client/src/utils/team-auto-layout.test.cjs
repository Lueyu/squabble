const { test } = require('node:test');
const assert = require('node:assert/strict');
const fixture = require('./simple-test-loader.cjs');

const f = fixture();
const { autoLayout, ensureVisiblePositions, LAYOUT_METRICS } = f.load('features/teams/team-auto-layout.ts');

const EMPTY_LAYOUT = () => ({ schemaVersion: 1, positions: {}, collapsedDepartmentIds: [], viewport: { x: 10, y: 20, zoom: 0.8 } });

function role(id, departmentId = null) {
  return { id, departmentId, participation: 'placeholder', responsibility: 'r', expectedOutput: 'e', executor: null, allowedToolIds: [], sourceGrantIds: [] };
}
function dept(id, parentDepartmentId = null) {
  return { id, parentDepartmentId, purpose: 'p' };
}
function rel(id, fromRoleId, toRoleId, kind = 'reports_to') {
  return { id, fromRoleId, toRoleId, kind, responsibilityScope: 'scope' };
}
function config(departments, roles, leadRoleId = roles[0]?.id ?? null) {
  return { schemaVersion: 1, departments, roles, relations: [], defaults: { leadRoleId, parallelism: 1 } };
}
const viewport = layout => layout.viewport;
const pos = (layout, id) => layout.positions[id];

test('auto layout is deterministic and preserves viewport and collapsed departments', () => {
  const cfg = config([dept('d1'), dept('d2')], [role('lead'), role('a', 'd1'), role('b', 'd1'), role('c', 'd2')], 'lead');
  const base = { ...EMPTY_LAYOUT(), collapsedDepartmentIds: ['d2'] };
  const first = autoLayout(cfg, base);
  const second = autoLayout(cfg, base);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.deepEqual(viewport(first), { x: 10, y: 20, zoom: 0.8 });
  assert.deepEqual(first.collapsedDepartmentIds, ['d2']);
});

test('root lead sits on the first row and root departments never overlap', () => {
  const cfg = config([dept('d1'), dept('d2')], [role('lead'), role('a', 'd1'), role('b', 'd1'), role('c', 'd2')], 'lead');
  const layout = autoLayout(cfg, EMPTY_LAYOUT());
  assert.deepEqual({ x: pos(layout, 'lead').x, y: pos(layout, 'lead').y }, { x: 24, y: 24 });
  const first = pos(layout, 'd1');
  const second = pos(layout, 'd2');
  const overlap = first.x < second.x + second.width && second.x < first.x + first.width && first.y < second.y + second.height && second.y < first.y + first.height;
  assert.equal(overlap, false, 'root departments must not overlap');
  assert.ok(first.width >= 280 && first.height >= 180, 'a populated department keeps a usable minimum size');
});

test('roles inside a department stay inside its content box and never overlap each other', () => {
  const cfg = config([dept('d1')], [role('lead', 'd1'), role('a', 'd1'), role('b', 'd1'), role('c', 'd1')], 'lead');
  const layout = autoLayout(cfg, EMPTY_LAYOUT());
  const box = pos(layout, 'd1');
  const roles = ['lead', 'a', 'b', 'c'].map(id => pos(layout, id));
  for (const p of roles) {
    assert.ok(p.x >= 24 && p.x + LAYOUT_METRICS.cardWidth <= box.width - 24, `role x ${p.x} inside department width ${box.width}`);
    assert.ok(p.y >= 72, `role y ${p.y} under the department title`);
  }
  for (let i = 0; i < roles.length; i++) {
    for (let j = i + 1; j < roles.length; j++) {
      const a = { x: roles[i].x, y: roles[i].y };
      const b = { x: roles[j].x, y: roles[j].y };
      const overlap = a.x < b.x + LAYOUT_METRICS.cardWidth && b.x < a.x + LAYOUT_METRICS.cardWidth && a.y < b.y + LAYOUT_METRICS.cardHeight && b.y < a.y + LAYOUT_METRICS.cardHeight;
      assert.equal(overlap, false, `roles must not overlap: ${i}/${j}`);
    }
  }
});

test('the lead of a department keeps its membership and is placed first', () => {
  const cfg = config([dept('d1')], [role('other', 'd1'), role('lead', 'd1')], 'lead');
  const layout = autoLayout(cfg, EMPTY_LAYOUT());
  const lead = pos(layout, 'lead');
  const other = pos(layout, 'other');
  assert.deepEqual({ x: lead.x, y: lead.y }, { x: 24, y: 72 });
  assert.equal(other.y, lead.y, 'the next role shares the first content row');
  assert.ok(other.x > lead.x);
});

test('nested departments stay inside their parent and keep independent content coordinates', () => {
  const cfg = config([dept('outer'), dept('inner', 'outer')], [role('lead', 'outer'), role('a', 'inner'), role('b', 'inner')], 'lead');
  const layout = autoLayout(cfg, EMPTY_LAYOUT());
  const outer = pos(layout, 'outer');
  const inner = pos(layout, 'inner');
  assert.ok(inner.x >= 24 && inner.y >= 72, 'inner department sits in the outer content box');
  assert.ok(inner.x + inner.width <= outer.width - 24 + 0.001, 'inner department width fits the outer department');
  const a = pos(layout, 'a');
  const b = pos(layout, 'b');
  assert.ok(a.x >= 24 && a.y >= 72 && a.x + LAYOUT_METRICS.cardWidth <= inner.width - 24);
  assert.ok(b.x >= 24 && b.y >= 72 && b.x + LAYOUT_METRICS.cardWidth <= inner.width - 24);
});

test('empty departments retain their expandable minimum even when collapsed', () => {
  const cfg = config([dept('empty'), dept('collapsed')], [role('lead')], 'lead');
  const layout = autoLayout(cfg, { ...EMPTY_LAYOUT(), collapsedDepartmentIds: ['collapsed'] });
  assert.deepEqual({ width: pos(layout, 'empty').width, height: pos(layout, 'empty').height }, { width: 280, height: 180 });
  assert.deepEqual({ width: pos(layout, 'collapsed').width, height: pos(layout, 'collapsed').height }, { width: 280, height: 180 });
});

test('ensureVisiblePositions keeps stored coordinates and only appends missing nodes', () => {
  const cfg = config([dept('d1')], [role('lead'), role('a', 'd1'), role('b', 'd1'), role('c', 'd1')], 'lead');
  const stored = { ...EMPTY_LAYOUT(), positions: { lead: { x: 999, y: 999 }, d1: { x: 40, y: 40, width: 600, height: 400 }, a: { x: 100, y: 120 } } };
  const layout = ensureVisiblePositions(cfg, stored);
  assert.deepEqual(pos(layout, 'lead'), { x: 999, y: 999 }, 'existing position untouched');
  assert.deepEqual(pos(layout, 'd1'), { x: 40, y: 40, width: 600, height: 400 }, 'existing department untouched');
  assert.deepEqual(pos(layout, 'a'), { x: 100, y: 120 });
  assert.ok(pos(layout, 'b'), 'missing role receives a temporary fallback');
  assert.ok(pos(layout, 'c'), 'missing role receives a temporary fallback');
  assert.notDeepEqual({ x: pos(layout, 'b').x, y: pos(layout, 'b').y }, { x: 0, y: 0 });
  assert.ok(pos(layout, 'b').y >= 120 + LAYOUT_METRICS.cardHeight, 'fallback appended after the existing bounding box');
  const again = ensureVisiblePositions(cfg, layout);
  assert.equal(JSON.stringify(again), JSON.stringify(layout), 'filling twice is stable');
});

test('a collapsed department can expand after auto layout without clipping its stored children', () => {
  const cfg = config([dept('research')], [role('lead'), role('a', 'research'), role('b', 'research')], 'lead');
  const layout = autoLayout(cfg, { ...EMPTY_LAYOUT(), collapsedDepartmentIds: ['research'] });
  const expanded = { ...layout, collapsedDepartmentIds: [] };
  const box = pos(expanded, 'research');
  for (const id of ['a', 'b']) {
    const child = pos(expanded, id);
    assert.ok(child.x + LAYOUT_METRICS.cardWidth <= box.width - 24, 'stored width contains the expanded card');
    assert.ok(child.y + LAYOUT_METRICS.cardHeight <= box.height - 24, 'stored height contains the expanded card');
  }
});
