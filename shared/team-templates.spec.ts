import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TEAM_TEMPLATES } from './team-templates';

test('templates are editable unconfigured organizations with research provenance and bounded participants', () => {
  assert.ok(TEAM_TEMPLATES.filter(t => t.category === 'professional').length >= 6);
  assert.ok(TEAM_TEMPLATES.filter(t => t.category === 'playful').length >= 4);
  assert.equal(new Set(TEAM_TEMPLATES.map(t => t.id)).size, TEAM_TEMPLATES.length);
  for (const template of TEAM_TEMPLATES) {
    assert.ok(template.name.en && template.name['zh-CN']);
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
    if (template.category === 'professional') {
      assert.ok(template.researchSources.length > 0);
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
