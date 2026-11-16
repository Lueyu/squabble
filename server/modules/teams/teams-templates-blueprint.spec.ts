import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TEAM_TEMPLATES } from '../../../shared/team-templates';
import { instantiateTemplate } from '../../../shared/team-template-instantiation';
import { compileWorkBlueprint } from './team-work-blueprint';
import { validateTeamGraph } from './team-graph';

/** 04-organization-templates: minimum authorized call budget is two per work item. */
const MINIMUM_CALLS: Record<string, number> = {
  classic: 8,
  'bull-bear-committee': 12,
  'reflective-manager': 12,
  'portfolio-specialists': 10,
  'fine-grained-diligence': 12,
  'competing-hypotheses': 10,
  'matrix-specialists': 10,
  'huawei-style': 12,
  'bytedance-style': 10,
  'alibaba-style': 10,
  'tencent-style': 10,
};

test('every template instantiates, validates and compiles with the production blueprint compiler', () => {
  assert.equal(TEAM_TEMPLATES.length, 11);
  for (const template of TEAM_TEMPLATES) {
    const org = instantiateTemplate(template);
    validateTeamGraph(org.config);
    const compiled = compileWorkBlueprint(org.config, { objective: 'Review a fictional investment thesis', expectedSummaryOutput: 'Preserve disagreements' });
    assert.equal(compiled.minimumCallCount, MINIMUM_CALLS[template.id], `${template.id} reserves two calls per work item`);
    const participants = new Set([...compiled.work.map(work => work.roleId), ...compiled.work.map(work => work.reviewerRoleId), compiled.leadRoleId]);
    assert.deepEqual([...compiled.participantRoleIds].sort(), [...participants].sort(), `${template.id} participants are exactly the executing and reviewing seats`);
    assert.match(compiled.blueprintHash, /^[a-f0-9]{64}$/);
    // A generated instance never points back at template-local ids.
    const oldIds = new Set([...template.config.departments, ...template.config.roles, ...template.config.relations].map(node => node.id));
    const newIds = new Set([...org.config.departments, ...org.config.roles, ...org.config.relations].map(node => node.id));
    for (const id of oldIds) assert.ok(!newIds.has(id), `${template.id} leaked ${id}`);
    for (const key of Object.keys(org.layout.positions)) assert.ok(newIds.has(key) || org.config.departments.some(d => d.id === key) || org.config.roles.some(r => r.id === key));
  }
});

test('classic wires the documented research department, double reporting line and independent review chain', () => {
  const template = TEAM_TEMPLATES.find(t => t.id === 'classic')!;
  const org = instantiateTemplate(template);
  const role = (needle: string) => org.config.roles.find(r => r.responsibility.includes(needle))!;
  const lead = role('综合全部研究');
  const financials = role('财务口径、盈利质量');
  const business = role('商业模式');
  const counterpoint = role('最强论点');
  const edges = org.config.relations;
  const has = (from: string, to: string, kind: string) => edges.some(e => e.fromRoleId === from && e.toRoleId === to && e.kind === kind);
  assert.equal(org.config.departments.length, 2, 'research department and challenge department');
  assert.equal(lead.departmentId, null, 'the portfolio lead sits at the root');
  assert.ok(has(financials.id, lead.id, 'reports_to') && has(financials.id, business.id, 'reports_to'), 'the financials expert reports to both the lead and the business analyst');
  assert.ok(has(business.id, lead.id, 'reports_to') && has(counterpoint.id, lead.id, 'reports_to'));
  assert.ok(has(lead.id, financials.id, 'delegates_to') && has(lead.id, business.id, 'delegates_to') && has(lead.id, counterpoint.id, 'delegates_to'));
  assert.ok(has(counterpoint.id, financials.id, 'reviews') && has(lead.id, business.id, 'reviews') && has(lead.id, counterpoint.id, 'reviews') && has(counterpoint.id, lead.id, 'reviews'));
  const compiled = compileWorkBlueprint(org.config, { objective: 'Review a fictional thesis', expectedSummaryOutput: 'Preserve disagreements' });
  const rows = compiled.work.map(work => [work.workKey, work.roleId, work.dependencyWorkKeys, work.reviewerRoleId]);
  assert.deepEqual(rows, [
    ['financials', financials.id, [], counterpoint.id],
    ['business', business.id, ['financials'], lead.id],
    ['challenge', counterpoint.id, ['business', 'financials'], lead.id],
    ['summary', lead.id, ['business', 'challenge', 'financials'], counterpoint.id],
  ]);
  assert.equal(compiled.minimumCallCount, 8);
});
