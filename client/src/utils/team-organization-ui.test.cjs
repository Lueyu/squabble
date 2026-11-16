'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const f = require('./simple-test-loader.cjs')();

const TEMPLATE = (() => {
  const ids = { dept: 'tpl-dept', lead: 'tpl-lead', fin: 'tpl-f', rel: 'tpl-rel' };
  return {
    id: 'fixture',
    category: 'professional',
    name: { 'zh-CN': '样板', en: 'Fixture' },
    description: { 'zh-CN': '测试模板', en: 'Fixture template' },
    researchSources: [{ title: 'x', url: 'https://arxiv.org/abs/2407.06567', year: 2024, evidence: 'preprint' }],
    templateVersion: 2,
    staffing: [{ roleId: ids.fin, recommendedTemplateId: 'financials', required: true }],
    config: {
      schemaVersion: 1,
      departments: [{ id: ids.dept, parentDepartmentId: null, purpose: '研究部 / Research' }],
      roles: [
        { id: ids.lead, departmentId: null, participation: 'enabled', responsibility: 'lead', expectedOutput: 'summary', executor: null, allowedToolIds: [], sourceGrantIds: [] },
        { id: ids.fin, departmentId: ids.dept, participation: 'enabled', responsibility: 'fin', expectedOutput: 'cash', executor: null, allowedToolIds: [], sourceGrantIds: [] },
      ],
      relations: [{ id: ids.rel, fromRoleId: ids.fin, toRoleId: ids.lead, kind: 'reports_to', responsibilityScope: 'scope' }],
      defaults: { leadRoleId: ids.lead, parallelism: 1 },
      workBlueprint: {
        schemaVersion: 1,
        works: [{ workId: 'financials', roleId: ids.fin, taskKind: 'financials', objective: 'verify', expectedOutput: 'cash bridge', dependencyWorkIds: [], reviewerRoleId: ids.lead, reviewMode: 'self_check' }],
        summary: { reviewerRoleId: ids.lead, reviewMode: 'self_check', expectedOutput: 'Final thesis and conditions' },
      },
    },
    display: {
      name: 'Fixture',
      avatar: null,
      departmentLabels: { [ids.dept]: '研究部 / Research' },
      roleLabels: { [ids.lead]: '负责人 / Lead', [ids.fin]: '财报专家 / Financials' },
    },
    layout: {
      schemaVersion: 1,
      positions: {
        [ids.dept]: { x: 0, y: 0, width: 600, height: 400 },
        [ids.lead]: { x: 20, y: 20 },
        [ids.fin]: { x: 24, y: 72 },
      },
      collapsedDepartmentIds: [],
      viewport: { x: 0, y: 0, zoom: 0.8 },
    },
  };
})();

const TEMPLATE_LOCAL_IDS = [
  TEMPLATE.config.departments[0].id,
  TEMPLATE.config.roles[0].id,
  TEMPLATE.config.roles[1].id,
  TEMPLATE.config.relations[0].id,
];

function makeDraft(loader) {
  const { instantiateTemplate } = loader.load('features/teams/team-template-instantiation.ts');
  const inst = instantiateTemplate(TEMPLATE, () => f.state.randomUUID());
  return {
    config: inst.config,
    display: { name: '我的团队', avatar: 'abcd', departmentLabels: inst.display.departmentLabels, roleLabels: inst.display.roleLabels },
    layout: inst.layout,
  };
}

function usedIds(draft) {
  const ids = [];
  for (const d of draft.config.departments) { ids.push(d.id, d.parentDepartmentId); }
  for (const r of draft.config.roles) { ids.push(r.id, r.departmentId); }
  for (const r of draft.config.relations) { ids.push(r.id, r.fromRoleId, r.toRoleId); }
  ids.push(draft.config.defaults.leadRoleId);
  return new Set(ids.filter(Boolean));
}

test('draftWithTemplate preserves draft identity and fully replaces the organization', () => {
  f.state.randomUUID = require('node:crypto').randomUUID;
  const { draftWithTemplate } = f.load('features/teams/team-template-instantiation.ts');
  const before = makeDraft(f);
  const after = draftWithTemplate(before, TEMPLATE, () => f.state.randomUUID());

  assert.equal(after.display.name, '我的团队');
  assert.equal(after.display.avatar, 'abcd');

  const used = usedIds(after);
  for (const id of TEMPLATE_LOCAL_IDS) assert.equal(used.has(id), false, `template-local id leaked: ${id}`);

  const financials = after.config.workBlueprint.works.find(w => w.workId === 'financials');
  assert.ok(financials, 'stable work id must survive');
  const finRole = after.config.roles.find(r => r.responsibility === 'fin');
  assert.equal(financials.roleId, finRole.id);
  assert.equal(financials.reviewerRoleId, after.config.defaults.leadRoleId);
  assert.equal(after.config.workBlueprint.summary.reviewerRoleId, after.config.defaults.leadRoleId);

  for (const key of Object.keys(after.display.departmentLabels)) assert.ok(used.has(key), `unmapped department label ${key}`);
  for (const key of Object.keys(after.display.roleLabels)) assert.ok(used.has(key), `unmapped role label ${key}`);
  for (const key of Object.keys(after.layout.positions)) assert.ok(used.has(key), `unmapped position ${key}`);

  const finLabel = after.display.roleLabels[finRole.id];
  assert.ok(finLabel.includes('财报'), 'labels replaced with template labels');
});

test('draftWithTemplate is pure and deterministic for a fixed generate sequence', () => {
  f.state.randomUUID = require('node:crypto').randomUUID;
  const { draftWithTemplate } = f.load('features/teams/team-template-instantiation.ts');
  const before = makeDraft(f);
  const snapshot = JSON.stringify(before);

  const first = draftWithTemplate(before, TEMPLATE, () => 'gen-a');
  const second = draftWithTemplate(before, TEMPLATE, () => 'gen-a');
  assert.equal(JSON.stringify(first), JSON.stringify(second), 'same generate must yield identical drafts');
  assert.equal(JSON.stringify(before), snapshot, 'input draft must not be mutated');
  assert.notEqual(JSON.stringify(first), snapshot, 'applying a template must change the draft');
});

test('sequential template applications keep previous drafts valid (undoable states)', () => {
  f.state.randomUUID = require('node:crypto').randomUUID;
  const { draftWithTemplate } = f.load('features/teams/team-template-instantiation.ts');
  const seeded = (seed) => { let n = 0; return () => `${seed}-${++n}`; };
  const first = makeDraft(f);
  const second = draftWithTemplate(first, TEMPLATE, seeded('s1'));
  const third = draftWithTemplate(second, TEMPLATE, seeded('s2'));

  assert.notEqual(JSON.stringify(first), JSON.stringify(second));
  assert.notEqual(JSON.stringify(second), JSON.stringify(third));
  assert.equal(JSON.stringify(draftWithTemplate(first, TEMPLATE, seeded('s1'))), JSON.stringify(second), 're-applying from the first draft must reproduce the second');
  assert.equal(usedIds(first).size, usedIds(second).size, 'every applied draft has a complete id set');
});
