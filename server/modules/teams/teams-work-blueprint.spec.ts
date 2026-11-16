import test from 'node:test';
import assert from 'node:assert/strict';
import type { TeamSemanticConfig } from '../../../shared/team-workspace.interface';
import { canonicalHash } from './team-contract';
import { semanticHash } from './team-graph';
import { TEAM_WORK_BLUEPRINT_COMPILER_VERSION, compileWorkBlueprint, diagnoseWorkBlueprint } from './team-work-blueprint';

const uuid = (n: number) => `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`;
const ids = { lead: uuid(1), financials: uuid(2), business: uuid(3), bear: uuid(4) };
const errorCode = (code: string) => (error: unknown) => typeof error === 'object' && error !== null && 'getResponse' in error && (error.getResponse as () => { code: string })().code === code;

function role(id: string, n: number, overrides: Record<string, unknown> = {}) {
  return { id, departmentId: null, participation: 'enabled' as const, responsibility: 'Bounded fictional research', expectedOutput: 'Evidence, counterevidence and unknowns',
    executor: { executionMode: 'model' as const, connectionId: uuid(90), model: 'fixture-model', settings: {} },
    agentId: uuid(100 + n), agentVersionId: uuid(200 + n), allowedToolIds: [] as string[], sourceGrantIds: [] as string[], ...overrides };
}
function relation(fromRoleId: string, toRoleId: string, kind: 'reports_to' | 'delegates_to' | 'reviews', index: number) {
  return { id: uuid(300 + index), fromRoleId, toRoleId, kind, responsibilityScope: `scope-${index}` };
}

function classicFixture(): TeamSemanticConfig {
  return { schemaVersion: 1,
    departments: [{ id: uuid(10), parentDepartmentId: null, purpose: 'Research' }, { id: uuid(11), parentDepartmentId: null, purpose: 'Challenge' }],
    roles: [role(ids.lead, 1), role(ids.financials, 2), role(ids.business, 3), role(ids.bear, 4)],
    relations: [
      relation(ids.financials, ids.lead, 'reports_to', 1),
      relation(ids.financials, ids.business, 'reports_to', 2),
      relation(ids.business, ids.lead, 'reports_to', 3),
      relation(ids.bear, ids.lead, 'reports_to', 4),
      relation(ids.lead, ids.financials, 'delegates_to', 5),
      relation(ids.lead, ids.business, 'delegates_to', 6),
      relation(ids.lead, ids.bear, 'delegates_to', 7),
      relation(ids.bear, ids.financials, 'reviews', 8),
      relation(ids.lead, ids.business, 'reviews', 9),
      relation(ids.lead, ids.bear, 'reviews', 10),
      relation(ids.bear, ids.lead, 'reviews', 11),
    ],
    defaults: { leadRoleId: ids.lead, parallelism: 1 },
    workBlueprint: { schemaVersion: 1,
      works: [
        { workId: 'financials', roleId: ids.financials, taskKind: 'financials', objective: 'Check the cash flow', expectedOutput: 'Cash-flow evidence', dependencyWorkIds: [], reviewerRoleId: ids.bear, reviewMode: 'independent' },
        { workId: 'business', roleId: ids.business, taskKind: 'business', objective: 'Assess the business', expectedOutput: 'Business assessment', dependencyWorkIds: ['financials'], reviewerRoleId: ids.lead, reviewMode: 'independent' },
        { workId: 'challenge', roleId: ids.bear, taskKind: 'challenge', objective: 'Challenge the thesis', expectedOutput: 'Counterevidence', dependencyWorkIds: ['financials', 'business'], reviewerRoleId: ids.lead, reviewMode: 'independent' },
      ],
      summary: { reviewerRoleId: ids.bear, reviewMode: 'independent', expectedOutput: 'Final thesis and conditions' } },
  };
}
const context = { objective: 'Review a fictional investment thesis', expectedSummaryOutput: 'Preserve disagreements' };

test('classic division compiles to the exact four work items and eight reserved calls', () => {
  const result = compileWorkBlueprint(classicFixture(), context);
  assert.deepEqual(result.work.map(w => [w.workKey, w.roleId, w.dependencyWorkKeys, w.reviewerRoleId]), [
    ['financials', ids.financials, [], ids.bear],
    ['business', ids.business, ['financials'], ids.lead],
    ['challenge', ids.bear, ['business', 'financials'], ids.lead],
    ['summary', ids.lead, ['business', 'challenge', 'financials'], ids.bear],
  ]);
  assert.equal(result.minimumCallCount, 8);
  assert.deepEqual(result.participantRoleIds, Object.values(ids).sort());
  assert.deepEqual(result.nonParticipatingRoleIds, []);
  assert.deepEqual(result.unusedReviewRelationIds, []);
  assert.equal(result.leadRoleId, ids.lead);
  const summary = result.work.find(w => w.workKey === 'summary')!;
  assert.match(summary.expectedOutput, /Final thesis and conditions/);
  assert.match(summary.expectedOutput, /Preserve disagreements/);
  assert.deepEqual(summary.requestedByRoleIds, [ids.lead]);
  assert.equal(TEAM_WORK_BLUEPRINT_COMPILER_VERSION, 'team-work-blueprint-v1');
});

test('reported-to and delegated edges never invent dependencies; only the blueprint does', () => {
  const result = compileWorkBlueprint(classicFixture(), context);
  const business = result.work.find(w => w.workKey === 'business')!;
  // The financials seat reports to the business seat, but the dependency comes from the blueprint.
  assert.deepEqual(business.dependencyWorkKeys, ['financials']);
  assert.deepEqual(business.requestedByRoleIds, [ids.lead]);
});

test('a dependency cycle in the blueprint blocks compilation', () => {
  const config = classicFixture();
  config.workBlueprint!.works[0].dependencyWorkIds = ['challenge'];
  assert.throws(() => compileWorkBlueprint(config, context), errorCode('TEAM_PLAN_INVALID'));
  assert.ok(diagnoseWorkBlueprint(config).some(issue => issue.code === 'WORK_CYCLE'));
});

test('an independent review without the review relation blocks compilation', () => {
  const config = classicFixture();
  config.relations = config.relations.filter(r => !(r.kind === 'reviews' && r.fromRoleId === ids.bear && r.toRoleId === ids.financials));
  assert.throws(() => compileWorkBlueprint(config, context), errorCode('TEAM_PLAN_INVALID'));
  assert.ok(diagnoseWorkBlueprint(config).some(issue => issue.code === 'REVIEW_RELATION_REQUIRED' && issue.workId === 'financials'));
});

test('unused review edges are reported but never turned into extra work', () => {
  const config = classicFixture();
  config.relations = [...config.relations, relation(ids.business, ids.bear, 'reviews', 20)];
  const result = compileWorkBlueprint(config, context);
  assert.equal(result.work.length, 4);
  assert.deepEqual(result.unusedReviewRelationIds, [uuid(320)]);
  assert.ok(diagnoseWorkBlueprint(config).some(issue => issue.code === 'REVIEW_RELATION_UNUSED' && issue.relationId === uuid(320)));
});

test('array order never decides the plan or the blueprint hash', () => {
  const base = classicFixture();
  const reversed = { ...base,
    roles: [...base.roles].reverse(),
    relations: [...base.relations].reverse(),
    workBlueprint: { ...base.workBlueprint!, works: [...base.workBlueprint!.works].reverse().map(work => ({ ...work, dependencyWorkIds: [...work.dependencyWorkIds].reverse() })) } };
  const first = compileWorkBlueprint(base, context), second = compileWorkBlueprint(reversed, context);
  assert.deepEqual(first.work, second.work);
  assert.equal(first.blueprintHash, second.blueprintHash);
  assert.equal(first.minimumCallCount, second.minimumCallCount);
});

test('a review-only seat participates without creating a second research item', () => {
  const financials = ids.financials, lead = ids.lead, reviewer = uuid(5);
  const config: TeamSemanticConfig = { schemaVersion: 1, departments: [],
    roles: [role(lead, 1), role(financials, 2), role(reviewer, 3)],
    relations: [relation(financials, lead, 'reports_to', 1), relation(reviewer, lead, 'reports_to', 2),
      relation(lead, financials, 'delegates_to', 3), relation(reviewer, financials, 'reviews', 4)],
    defaults: { leadRoleId: lead, parallelism: 1 },
    workBlueprint: { schemaVersion: 1,
      works: [{ workId: 'financials', roleId: financials, taskKind: 'financials', objective: 'Check the numbers', expectedOutput: 'Numbers', dependencyWorkIds: [], reviewerRoleId: reviewer, reviewMode: 'independent' }],
      summary: { reviewerRoleId: lead, reviewMode: 'self_check', expectedOutput: 'Final thesis and conditions' } } };
  const result = compileWorkBlueprint(config, { objective: 'Bounded review', expectedSummaryOutput: 'Keep disagreements' });
  assert.equal(result.work.length, 2);
  assert.equal(result.minimumCallCount, 4);
  assert.deepEqual(result.participantRoleIds, [lead, financials, reviewer].sort());
  assert.equal(result.work.filter(w => w.roleId === reviewer).length, 0);
  assert.ok(result.work.some(w => w.workKey === 'summary' && w.reviewMode === 'self_check'));
});

test('a single-person division is honest about self check', () => {
  const lead = ids.lead;
  const config: TeamSemanticConfig = { schemaVersion: 1, departments: [], roles: [role(lead, 1)], relations: [],
    defaults: { leadRoleId: lead, parallelism: 1 },
    workBlueprint: { schemaVersion: 1, works: [], summary: { reviewerRoleId: lead, reviewMode: 'self_check', expectedOutput: 'Final thesis' } } };
  const result = compileWorkBlueprint(config, { objective: 'Solo review', expectedSummaryOutput: 'Uncertainty' });
  assert.equal(result.work.length, 1);
  assert.equal(result.work[0].taskKind, 'summary');
  assert.equal(result.work[0].reviewMode, 'self_check');
  assert.equal(result.minimumCallCount, 2);
  assert.deepEqual(result.participantRoleIds, [lead]);
});

test('legacy configs without a blueprint stay readable and never gain an empty one', () => {
  const base = classicFixture();
  const { workBlueprint, ...legacy } = base;
  void workBlueprint;
  assert.deepEqual(diagnoseWorkBlueprint(legacy).map(issue => issue.code), ['BLUEPRINT_MISSING']);
  assert.throws(() => compileWorkBlueprint(legacy, context), errorCode('TEAM_PLAN_INVALID'));
  assert.equal(typeof semanticHash(legacy), 'string');
  assert.equal('workBlueprint' in JSON.parse(JSON.stringify(legacy)), false);
});

test('semantic hash covers the blueprint and ignores array order', () => {
  const base = classicFixture();
  const changed = { ...base, workBlueprint: { ...base.workBlueprint!, summary: { ...base.workBlueprint!.summary, reviewerRoleId: ids.business } } };
  assert.notEqual(semanticHash(base), semanticHash(changed));
  const reordered = { ...base, roles: [...base.roles].reverse(), relations: [...base.relations].reverse(),
    workBlueprint: { ...base.workBlueprint!, works: [...base.workBlueprint!.works].reverse().map(work => ({ ...work, dependencyWorkIds: [...work.dependencyWorkIds].reverse() })) } };
  assert.equal(semanticHash(base), semanticHash(reordered));
});

test('the blueprint hash changes when the reviewer changes even if work text is identical', () => {
  const base = classicFixture();
  const changed = classicFixture();
  changed.relations = [...changed.relations, relation(ids.business, ids.financials, 'reviews', 30)];
  changed.workBlueprint!.works[0].reviewerRoleId = ids.business;
  const first = compileWorkBlueprint(base, context), second = compileWorkBlueprint(changed, context);
  assert.deepEqual(first.work.map(w => w.objective), second.work.map(w => w.objective));
  assert.notEqual(first.work[0].reviewerRoleId, second.work[0].reviewerRoleId);
  assert.notEqual(first.blueprintHash, second.blueprintHash);
});

test('blocking structural findings are rejected while draft-only findings stay warnings', () => {
  const missingLead = classicFixture();
  missingLead.defaults.leadRoleId = null;
  assert.throws(() => compileWorkBlueprint(missingLead, context), errorCode('TEAM_PLAN_INVALID'));
  assert.ok(diagnoseWorkBlueprint(missingLead).some(issue => issue.code === 'LEAD_REQUIRED'));

  const leadWork = classicFixture();
  leadWork.workBlueprint!.works[0].roleId = ids.lead;
  assert.ok(diagnoseWorkBlueprint(leadWork).some(issue => issue.code === 'LEAD_WORK_NOT_ALLOWED'));

  const duplicateRole = classicFixture();
  duplicateRole.workBlueprint!.works[1].roleId = ids.financials;
  assert.ok(diagnoseWorkBlueprint(duplicateRole).some(issue => issue.code === 'DUPLICATE_WORK_ROLE'));

  const unknownRole = classicFixture();
  unknownRole.workBlueprint!.works[0].roleId = uuid(999);
  assert.ok(diagnoseWorkBlueprint(unknownRole).some(issue => issue.code === 'UNKNOWN_ROLE'));

  const selfDependency = classicFixture();
  selfDependency.workBlueprint!.works[0].dependencyWorkIds = ['financials'];
  assert.ok(diagnoseWorkBlueprint(selfDependency).some(issue => issue.code === 'SELF_DEPENDENCY'));

  const noRelation = classicFixture();
  noRelation.relations = noRelation.relations.filter(r => r.kind !== 'reviews');
  assert.ok(diagnoseWorkBlueprint(noRelation).some(issue => issue.code === 'REVIEW_RELATION_REQUIRED'));

  const reserved = classicFixture();
  reserved.workBlueprint!.works[0].workId = 'summary';
  assert.ok(diagnoseWorkBlueprint(reserved).some(issue => issue.code === 'RESERVED_WORK_ID'));

  const tooManyWorks = classicFixture();
  tooManyWorks.workBlueprint!.works = [...tooManyWorks.workBlueprint!.works,
    { workId: 'extra-a', roleId: uuid(12), taskKind: 'specialist', objective: 'Extra', expectedOutput: 'Extra', dependencyWorkIds: [], reviewerRoleId: ids.lead, reviewMode: 'independent' },
    { workId: 'extra-b', roleId: uuid(13), taskKind: 'specialist', objective: 'Extra', expectedOutput: 'Extra', dependencyWorkIds: [], reviewerRoleId: ids.lead, reviewMode: 'independent' },
    { workId: 'extra-c', roleId: uuid(14), taskKind: 'specialist', objective: 'Extra', expectedOutput: 'Extra', dependencyWorkIds: [], reviewerRoleId: ids.lead, reviewMode: 'independent' }];
  assert.ok(diagnoseWorkBlueprint(tooManyWorks).some(issue => issue.code === 'TOO_MANY_WORKS'));

  const placeholder = classicFixture();
  placeholder.roles[1] = { ...placeholder.roles[1], participation: 'placeholder', executor: null, agentId: undefined, agentVersionId: undefined };
  const warnings = diagnoseWorkBlueprint(placeholder);
  assert.ok(warnings.some(issue => issue.code === 'ROLE_NOT_READY' && issue.roleId === ids.financials));
  // ROLE_NOT_READY is a draft-level warning: the pure structure compiler still succeeds;
  // only the formal commission preview turns it into a blocker.
  const drafted = compileWorkBlueprint(placeholder, context);
  assert.equal(drafted.work.length, 4);
  assert.equal(drafted.minimumCallCount, 8);
});

test('two seats backed by the same persistent friend cannot claim independent review', () => {
  const config = classicFixture();
  config.roles = config.roles.map(r => r.id === ids.financials ? { ...r, agentId: uuid(777), agentVersionId: uuid(778) } : r)
    .map(r => r.id === ids.bear ? { ...r, agentId: uuid(777), agentVersionId: uuid(779) } : r);
  assert.ok(diagnoseWorkBlueprint(config).some(issue => issue.code === 'INDEPENDENT_REVIEW_SAME_FRIEND'));
  assert.throws(() => compileWorkBlueprint(config, context), errorCode('TEAM_PLAN_INVALID'));
});

test('review mode must disclose who actually reviews', () => {
  const config = classicFixture();
  config.workBlueprint!.works[0].reviewMode = 'self_check';
  assert.ok(diagnoseWorkBlueprint(config).some(issue => issue.code === 'REVIEW_MODE_MISMATCH'));
  const summarySelf = classicFixture();
  summarySelf.workBlueprint!.summary.reviewMode = 'independent';
  summarySelf.workBlueprint!.works.forEach(w => { if (w.reviewerRoleId === ids.bear) w.reviewerRoleId = ids.lead; });
  assert.ok(diagnoseWorkBlueprint(summarySelf).some(issue => issue.code === 'REVIEW_MODE_MISMATCH' || issue.code === 'REVIEW_RELATION_REQUIRED'));
});

test('more than six participants are refused before any call is reserved', () => {
  const config = classicFixture();
  const extra = [uuid(41), uuid(42), uuid(43), uuid(44), uuid(45), uuid(46), uuid(47)].map((id, index) => role(id, 40 + index));
  config.roles = [...config.roles, ...extra];
  config.relations = [...config.relations];
  // Six work items would already be too many; assert the participant ceiling on its own via diagnosis.
  config.workBlueprint!.works = config.workBlueprint!.works.map((work, index) => ({ ...work, roleId: extra[index].id, reviewerRoleId: extra[(index + 3) % extra.length].id }));
  const issues = diagnoseWorkBlueprint(config);
  assert.ok(issues.some(issue => issue.code === 'TOO_MANY_PARTICIPANTS'), JSON.stringify(issues));
  assert.throws(() => compileWorkBlueprint(config, context), errorCode('TEAM_PLAN_INVALID'));
});

test('canonical blueprint hash is stable across JSON round trips', () => {
  const base = classicFixture();
  const roundTrip = JSON.parse(JSON.stringify(base)) as TeamSemanticConfig;
  assert.equal(canonicalHash(base.workBlueprint), canonicalHash(roundTrip.workBlueprint));
  assert.equal(semanticHash(base), semanticHash(roundTrip));
  const result = compileWorkBlueprint(base, context);
  assert.equal(result.blueprintHash, compileWorkBlueprint(roundTrip, context).blueprintHash);
});

test('a dedicated final reviewer remains a participating member without a research work item', () => {
  const config = classicFixture();
  config.roles = [config.roles[0], config.roles[3]];
  config.relations = [relation(ids.bear, ids.lead, 'reviews', 50)];
  config.workBlueprint!.works = [];
  const compiled = compileWorkBlueprint(config, context);
  assert.deepEqual(compiled.participantRoleIds, [ids.lead, ids.bear].sort());
  assert.deepEqual(compiled.nonParticipatingRoleIds, []);
  assert.equal(compiled.work[0].reviewerRoleId, ids.bear);
});

test('structural preview refuses a graph rejected by the shared graph validator', async () => {
  const { TeamWorkPlanPreviewService } = await import('./team-work-plan-preview.service');
  const config = classicFixture();
  config.relations[1].id = config.relations[0].id;
  const service = new TeamWorkPlanPreviewService({} as never);
  const preview = service.compile('fixture-preview', 1, config);
  assert.equal(preview.structurallyValid, false);
  assert.equal(preview.work.length, 0);
  assert.ok(preview.issues.some(issue => issue.code === 'TEAM_GRAPH_INVALID'));
});
