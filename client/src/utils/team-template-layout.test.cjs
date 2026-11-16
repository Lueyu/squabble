const { test } = require('node:test');
const assert = require('node:assert/strict');
const fixture = require('./simple-test-loader.cjs');

const f = fixture();
const { TEAM_TEMPLATES } = f.load('../../shared/team-templates.ts');
const { autoLayout } = f.load('features/teams/team-auto-layout.ts');

const card = { width: 220, height: 154 };
const overlaps = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

function assertUsableLayout(template, layout) {
  const parentOf = item => 'departmentId' in item ? item.departmentId : item.parentDepartmentId;
  const bounds = item => ({ ...layout.positions[item.id], ...('departmentId' in item ? card : {}) });
  const objects = [...template.config.departments, ...template.config.roles];
  for (const item of objects) {
    const box = bounds(item);
    assert.ok(Number.isFinite(box.x) && Number.isFinite(box.y), `${template.id}: ${item.id} has coordinates`);
    const parentId = parentOf(item);
    if (parentId) {
      const parent = layout.positions[parentId];
      assert.ok(box.x >= 24 && box.y >= 72, `${template.id}: child coordinates start inside their own department`);
      assert.ok(box.x + box.width <= parent.width - 24, `${template.id}: child fits department width`);
      assert.ok(box.y + box.height <= parent.height - 24, `${template.id}: child fits department height`);
    }
  }
  for (let i = 0; i < objects.length; i += 1) {
    for (let j = i + 1; j < objects.length; j += 1) {
      if (parentOf(objects[i]) !== parentOf(objects[j])) continue;
      assert.equal(overlaps(bounds(objects[i]), bounds(objects[j])), false, `${template.id}: siblings do not overlap`);
    }
  }
}

test('every new template uses parent-relative coordinates that contain readable cards without overlap', () => {
  for (const template of TEAM_TEMPLATES) assertUsableLayout(template, template.layout);
});

test('explicit auto layout uses the same readable card envelope for every template', () => {
  for (const template of TEAM_TEMPLATES) assertUsableLayout(template, autoLayout(template.config, template.layout));
});
