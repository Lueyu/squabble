import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TEAM_TEMPLATES } from './team-templates';
import { AGENT_TEMPLATE_IDS } from './agent-roster.interface';

const ORIGINAL_TEMPLATE_IDS = ['bull-bear-committee', 'reflective-manager', 'portfolio-specialists', 'fine-grained-diligence', 'competing-hypotheses', 'matrix-specialists', 'huawei-style', 'bytedance-style', 'alibaba-style', 'tencent-style'];

test('templates are editable unconfigured organizations with research provenance and bounded participants', () => {
  assert.equal(TEAM_TEMPLATES.length, 11);
  assert.deepEqual(new Set(TEAM_TEMPLATES.map(t => t.id)).size, 11);
  for (const id of ORIGINAL_TEMPLATE_IDS) assert.ok(TEAM_TEMPLATES.some(t => t.id === id), `stable id ${id} kept`);
  assert.ok(TEAM_TEMPLATES.filter(t => t.category === 'professional').length >= 7);
  assert.ok(TEAM_TEMPLATES.filter(t => t.category === 'playful').length >= 4);
  const catalog = new Set<string>(AGENT_TEMPLATE_IDS);
  for (const template of TEAM_TEMPLATES) {
    assert.ok(template.name.en && template.name['zh-CN']);
    assert.equal(template.templateVersion, 2);
    assert.ok(template.config.roles.length <= 6);
    const ids = new Set([...template.config.roles, ...template.config.departments].map(n => n.id));
    for (const role of template.config.roles) {
      assert.equal(role.executor, null);
      assert.equal(role.participation, 'placeholder');
      assert.deepEqual(role.allowedToolIds, []);
      assert.deepEqual(role.sourceGrantIds, []);
      assert.ok(role.responsibility && role.expectedOutput);
      assert.ok(template.display.roleLabels[role.id]);
      assert.ok(template.layout.positions[role.id]);
    }
    for (const edge of template.config.relations) {
      assert.ok(ids.has(edge.fromRoleId) && ids.has(edge.toRoleId));
      assert.notEqual(edge.fromRoleId, edge.toRoleId);
      assert.ok(edge.responsibilityScope);
    }
    // Staffing: one slot per seat, catalog specialty, stable role references.
    assert.equal(template.staffing.length, template.config.roles.length);
    assert.equal(new Set(template.staffing.map(slot => slot.recommendedTemplateId)).size, template.config.roles.length,
      `${template.id} needs a distinct built-in friend for every independent seat`);
    for (const slot of template.staffing) {
      assert.ok(ids.has(slot.roleId));
      assert.ok(catalog.has(slot.recommendedTemplateId));
    }
    // Blueprint: bounded, resolvable, reviewable division of labour.
    const blueprint = template.config.workBlueprint!;
    assert.ok(blueprint, `${template.id} carries a work blueprint`);
    assert.equal(blueprint.schemaVersion, 1);
    assert.ok(blueprint.works.length >= 1 && blueprint.works.length <= 5);
    const workIds = new Set(blueprint.works.map(work => work.workId));
    assert.equal(workIds.size, blueprint.works.length);
    for (const work of blueprint.works) {
      assert.ok(ids.has(work.roleId) && ids.has(work.reviewerRoleId));
      assert.ok(work.objective && work.expectedOutput);
      for (const dep of work.dependencyWorkIds) assert.ok(workIds.has(dep));
    }
    assert.ok(ids.has(blueprint.summary.reviewerRoleId));
    // Professional templates keep research provenance; classic is the documented product default.
    if (template.category === 'professional' && template.id !== 'classic') {
      assert.ok(template.researchSources.length > 0, `${template.id} cites research`);
      assert.ok(template.researchSources.every(source => source.url.startsWith('https://arxiv.org/abs/')));
    }
  }
});

test('matrix templates preserve multiple reporting lines and playful styles retain substantive checks', () => {
  const matrix = TEAM_TEMPLATES.find(t => t.id === 'matrix-specialists')!;
  const targets = new Map<string, Set<string>>();
  for (const edge of matrix.config.relations.filter(e => e.kind === 'reports_to')) {
    const set = targets.get(edge.fromRoleId) ?? new Set<string>();
    set.add(edge.toRoleId); targets.set(edge.fromRoleId, set);
  }
  assert.ok([...targets.values()].some(values => values.size > 1));
  for (const id of ['huawei-style', 'bytedance-style', 'alibaba-style', 'tencent-style']) {
    const template = TEAM_TEMPLATES.find(t => t.id === id)!;
    assert.equal(template.category, 'playful');
    assert.ok(template.config.roles.some(role => /反证|风险|复核/.test(role.responsibility)));
    assert.ok(template.description['zh-CN'].includes('趣味'));
  }
});
