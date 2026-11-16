const { test } = require('node:test');
const assert = require('node:assert/strict');
const fixture = require('./simple-test-loader.cjs');
const { randomUUID } = require('node:crypto');
const plain = v => JSON.parse(JSON.stringify(v));

/** A small template that already carries the fields T07 will add to every template. */
function templateFixture() {
  return {
    id: 'fixture-template', category: 'professional',
    name: { 'zh-CN': '模板', en: 'Fixture template' },
    description: { 'zh-CN': '占位说明', en: 'fixture' },
    researchSources: [],
    config: {
      schemaVersion: 1,
      departments: [{ id: 'dept-1', parentDepartmentId: null, purpose: '研究部 / Research' }],
      roles: [
        { id: 'role-lead', departmentId: 'dept-1', participation: 'placeholder', responsibility: 'lead', expectedOutput: 'output', executor: null, allowedToolIds: [], sourceGrantIds: [] },
        { id: 'role-f', departmentId: 'dept-1', participation: 'placeholder', responsibility: 'financials', expectedOutput: 'output', executor: null, allowedToolIds: [], sourceGrantIds: [] },
      ],
      relations: [{ id: 'rel-1', fromRoleId: 'role-f', toRoleId: 'role-lead', kind: 'reports_to', responsibilityScope: 'scope' }],
      defaults: { leadRoleId: 'role-lead', parallelism: 1 },
      workBlueprint: {
        schemaVersion: 1,
        works: [{ workId: 'financials', roleId: 'role-f', taskKind: 'financials', objective: 'objective', expectedOutput: 'delivery', dependencyWorkIds: [], reviewerRoleId: 'role-lead', reviewMode: 'self_check' }],
        summary: { reviewerRoleId: 'role-lead', reviewMode: 'self_check', expectedOutput: 'summary' },
      },
    },
    display: { name: 'Fixture', avatar: null, departmentLabels: { 'dept-1': '研究部' }, roleLabels: { 'role-lead': 'Lead', 'role-f': 'Fin' } },
    layout: { schemaVersion: 1, positions: { 'dept-1': { x: 0, y: 0, width: 100, height: 100 }, 'role-lead': { x: 1, y: 1 }, 'role-f': { x: 2, y: 2 } }, collapsedDepartmentIds: [], viewport: { x: 0, y: 0, zoom: 1 } },
    staffing: [{ roleId: 'role-f', recommendedTemplateId: 'financials', required: true }],
  };
}

const originalIds = template => new Set([...template.config.departments, ...template.config.roles, ...template.config.relations].map(n => n.id));

test('instantiation remaps every reference and leaves no template-local UUID behind', () => {
  const f = fixture(); f.state.randomUUID = randomUUID;
  const { instantiateTemplate } = f.load('features/teams/team-template-instantiation.ts');
  const t = templateFixture();
  const before = plain(t);
  const out = instantiateTemplate(t);
  assert.deepEqual(plain(t), before, 'Instantiation is pure: a failed confirm never mutates the local organization');
  const oldIds = originalIds(t);
  const newIds = new Set([...out.config.departments, ...out.config.roles, ...out.config.relations].map(n => n.id));
  assert.equal(newIds.size, 4, 'Every node gets its own fresh id');
  for (const oldId of oldIds) assert.ok(!newIds.has(oldId), `template-local id ${oldId} leaked into the instance`);
  for (const d of out.config.departments) assert.ok(!d.parentDepartmentId || newIds.has(d.parentDepartmentId));
  for (const r of out.config.roles) assert.ok(out.config.departments.some(d => d.id === r.departmentId));
  for (const e of out.config.relations) assert.ok(newIds.has(e.fromRoleId) && newIds.has(e.toRoleId));
  assert.equal(out.config.defaults.leadRoleId, out.config.roles[0].id);
  const blueprint = out.config.workBlueprint;
  assert.ok(blueprint);
  assert.equal(blueprint.works[0].workId, 'financials', 'workId is a stable task key inside the instance');
  assert.equal(blueprint.works[0].roleId, out.config.roles[1].id);
  assert.equal(blueprint.works[0].reviewerRoleId, out.config.roles[0].id);
  assert.equal(blueprint.summary.reviewerRoleId, out.config.roles[0].id);
  assert.ok(out.staffing && out.staffing[0].roleId === out.config.roles[1].id);
  assert.ok(out.display.departmentLabels[out.config.departments[0].id]);
  for (const role of out.config.roles) assert.ok(out.display.roleLabels[role.id]);
  for (const role of out.config.roles) assert.ok(out.layout.positions[role.id]);
  for (const key of Object.keys(out.layout.positions)) assert.ok(newIds.has(key));
});

test('two instantiations of the same template never share a UUID', () => {
  const f = fixture(); f.state.randomUUID = randomUUID;
  const { instantiateTemplate } = f.load('features/teams/team-template-instantiation.ts');
  const a = instantiateTemplate(templateFixture());
  const b = instantiateTemplate(templateFixture());
  const idsA = new Set([...a.config.departments, ...a.config.roles].map(n => n.id));
  const idsB = new Set([...b.config.departments, ...b.config.roles].map(n => n.id));
  for (const id of idsA) assert.ok(!idsB.has(id), `shared id ${id}`);
});

test('every stored template instantiates without dangling references', () => {
  const f = fixture(); f.state.randomUUID = randomUUID;
  const { instantiateTemplate } = f.load('features/teams/team-template-instantiation.ts');
  const { TEAM_TEMPLATES } = f.load('../../shared/team-templates.ts');
  assert.ok(TEAM_TEMPLATES.length >= 10);
  for (const t of TEAM_TEMPLATES) {
    const out = instantiateTemplate(t);
    const newIds = new Set([...out.config.departments, ...out.config.roles, ...out.config.relations].map(n => n.id));
    assert.equal(newIds.size, out.config.departments.length + out.config.roles.length + out.config.relations.length, `unique ids for ${t.id}`);
    for (const d of out.config.departments) assert.ok(!d.parentDepartmentId || newIds.has(d.parentDepartmentId), `parent of ${d.id}`);
    for (const r of out.config.roles) assert.ok(!r.departmentId || newIds.has(r.departmentId), `department of ${r.id}`);
    for (const e of out.config.relations) assert.ok(newIds.has(e.fromRoleId) && newIds.has(e.toRoleId), `endpoints of ${e.id}`);
    assert.ok(newIds.has(out.config.defaults.leadRoleId), `lead ${t.id}`);
    for (const role of out.config.roles) {
      assert.ok(out.display.roleLabels[role.id], `role label ${t.id}`);
      assert.ok(out.layout.positions[role.id], `role position ${t.id}`);
    }
    for (const key of Object.keys(out.layout.positions)) assert.ok(newIds.has(key), `position key ${t.id}`);
  }
});
