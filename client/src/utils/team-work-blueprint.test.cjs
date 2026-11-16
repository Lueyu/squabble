'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const f = require('./simple-test-loader.cjs')();

const uuid = n => `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`;

function classicConfig() {
  const ids = { lead: uuid(1), financials: uuid(2), business: uuid(3), bear: uuid(4), research: uuid(10), challenge: uuid(11) };
  const roles = [ids.lead, ids.financials, ids.business, ids.bear].map((id, index) => ({
    id, departmentId: index === 1 || index === 2 ? ids.research : index === 3 ? ids.challenge : null,
    participation: 'enabled', responsibility: 'Bounded fictional research', expectedOutput: 'Evidence, counterevidence and unknowns',
    executor: { executionMode: 'model', connectionId: uuid(90), model: 'fixture-model', settings: {} },
    agentId: uuid(100 + index), agentVersionId: uuid(200 + index), allowedToolIds: [], sourceGrantIds: [],
  }));
  const relations = [
    { id: uuid(300), fromRoleId: ids.financials, toRoleId: ids.lead, kind: 'reports_to', responsibilityScope: 'scope-0' },
    { id: uuid(301), fromRoleId: ids.financials, toRoleId: ids.business, kind: 'reports_to', responsibilityScope: 'scope-1' },
    { id: uuid(302), fromRoleId: ids.business, toRoleId: ids.lead, kind: 'reports_to', responsibilityScope: 'scope-2' },
    { id: uuid(303), fromRoleId: ids.bear, toRoleId: ids.lead, kind: 'reports_to', responsibilityScope: 'scope-3' },
    { id: uuid(304), fromRoleId: ids.lead, toRoleId: ids.financials, kind: 'delegates_to', responsibilityScope: 'scope-4' },
    { id: uuid(305), fromRoleId: ids.lead, toRoleId: ids.business, kind: 'delegates_to', responsibilityScope: 'scope-5' },
    { id: uuid(306), fromRoleId: ids.lead, toRoleId: ids.bear, kind: 'delegates_to', responsibilityScope: 'scope-6' },
    { id: uuid(307), fromRoleId: ids.bear, toRoleId: ids.financials, kind: 'reviews', responsibilityScope: 'scope-7' },
    { id: uuid(308), fromRoleId: ids.lead, toRoleId: ids.business, kind: 'reviews', responsibilityScope: 'scope-8' },
    { id: uuid(309), fromRoleId: ids.lead, toRoleId: ids.bear, kind: 'reviews', responsibilityScope: 'scope-9' },
    { id: uuid(310), fromRoleId: ids.bear, toRoleId: ids.lead, kind: 'reviews', responsibilityScope: 'scope-10' },
  ];
  return {
    schemaVersion: 1,
    departments: [{ id: ids.research, parentDepartmentId: null, purpose: 'Research' }, { id: ids.challenge, parentDepartmentId: null, purpose: 'Challenge' }],
    roles,
    relations,
    defaults: { leadRoleId: ids.lead, parallelism: 1 },
    workBlueprint: {
      schemaVersion: 1,
      works: [
        { workId: 'financials', roleId: ids.financials, taskKind: 'financials', objective: 'verify', expectedOutput: 'cash', dependencyWorkIds: [], reviewerRoleId: ids.bear, reviewMode: 'independent' },
        { workId: 'business', roleId: ids.business, taskKind: 'business', objective: 'model', expectedOutput: 'moat', dependencyWorkIds: ['financials'], reviewerRoleId: ids.lead, reviewMode: 'independent' },
        { workId: 'challenge', roleId: ids.bear, taskKind: 'challenge', objective: 'counter', expectedOutput: 'strongest counter', dependencyWorkIds: ['financials', 'business'], reviewerRoleId: ids.lead, reviewMode: 'independent' },
      ],
      summary: { reviewerRoleId: ids.bear, reviewMode: 'independent', expectedOutput: 'Final thesis and conditions' },
    },
  };
}

const blueprint = config => config.workBlueprint;
const configOf = () => classicConfig();
const codes = issues => issues.map(issue => issue.code).join(',');

test('workBlueprintOf reads and missing returns null', () => {
  f.state.randomUUID = require('node:crypto').randomUUID;
  const { workBlueprintOf } = f.load('features/teams/team-work-blueprint.ts');
  const withBlueprint = configOf();
  assert.equal(workBlueprintOf(withBlueprint).works.length, 3);
  const legacy = configOf(); delete legacy.workBlueprint;
  assert.equal(workBlueprintOf(legacy), null);
});

test('withBlueprintWork upserts and caps at five items', () => {
  f.state.randomUUID = require('node:crypto').randomUUID;
  const { withBlueprintWork, workBlueprintOf } = f.load('features/teams/team-work-blueprint.ts');
  const config = configOf();
  const replaced = withBlueprintWork(config, { workId: 'financials', roleId: config.defaults.leadRoleId, taskKind: 'valuation', objective: 'new', expectedOutput: 'new out', dependencyWorkIds: [], reviewerRoleId: config.roles[0].id, reviewMode: 'self_check' });
  const financials = workBlueprintOf(replaced).works.find(work => work.workId === 'financials');
  assert.equal(financials.taskKind, 'valuation');
  assert.equal(workBlueprintOf(replaced).works.length, 3);
  let added = replaced;
  for (let index = 3; index < 5; index += 1) {
    added = withBlueprintWork(added, { workId: `extra-${index}`, roleId: config.roles[0].id, taskKind: 'specialist', objective: 'x', expectedOutput: 'y', dependencyWorkIds: [], reviewerRoleId: config.roles[0].id, reviewMode: 'self_check' });
    assert.equal(workBlueprintOf(added).works.length, index + 1);
  }
  const capped = withBlueprintWork(added, { workId: 'extra-5', roleId: config.roles[0].id, taskKind: 'specialist', objective: 'x', expectedOutput: 'y', dependencyWorkIds: [], reviewerRoleId: config.roles[0].id, reviewMode: 'self_check' });
  assert.equal(workBlueprintOf(capped).works.length, 5);
});

test('removeBlueprintWork strips dependencies from siblings', () => {
  f.state.randomUUID = require('node:crypto').randomUUID;
  const { removeBlueprintWork, workBlueprintOf } = f.load('features/teams/team-work-blueprint.ts');
  const config = removeBlueprintWork(configOf(), 'financials');
  const works = workBlueprintOf(config).works;
  assert.equal(works.length, 2);
  assert.equal(works.find(work => work.workId === 'business').dependencyWorkIds.join(','), '');
  assert.equal(works.find(work => work.workId === 'challenge').dependencyWorkIds.join(','), 'business');
  assert.equal(removeBlueprintWork(config, 'summary'), config, 'summary cannot be removed');
});

test('structural issues flag reviewer, cycle, same-friend and reserved cases', () => {
  f.state.randomUUID = require('node:crypto').randomUUID;
  const { blueprintStructuralIssues, patchBlueprintWork, patchBlueprintSummary } = f.load('features/teams/team-work-blueprint.ts');
  const config = configOf();
  const unknownReviewer = patchBlueprintWork(config, 'financials', { reviewerRoleId: uuid(99) });
  assert.ok(codes(blueprintStructuralIssues(unknownReviewer)).includes('UNKNOWN_REVIEWER'));
  const cycle = patchBlueprintWork(config, 'financials', { dependencyWorkIds: ['challenge'] });
  assert.ok(codes(blueprintStructuralIssues(cycle)).includes('WORK_CYCLE'));
  const sameFriendBase = configOf();
  sameFriendBase.roles[2].agentId = sameFriendBase.roles[1].agentId;
  const sameFriend = patchBlueprintWork(sameFriendBase, 'financials', { reviewerRoleId: sameFriendBase.roles[2].id });
  assert.ok(codes(blueprintStructuralIssues(sameFriend)).includes('INDEPENDENT_REVIEW_SAME_FRIEND'));
  const mismatch = patchBlueprintWork(config, 'financials', { reviewerRoleId: config.roles[2].id, reviewMode: 'self_check' });
  assert.ok(codes(blueprintStructuralIssues(mismatch)).includes('REVIEW_MODE_MISMATCH'));
  const reserved = withReservedWork(config);
  assert.ok(codes(blueprintStructuralIssues(reserved)).includes('RESERVED_WORK_ID'));
  const missingRelation = patchBlueprintWork(config, 'business', { reviewerRoleId: uuid(5) });
  assert.ok(codes(blueprintStructuralIssues(missingRelation)).includes('UNKNOWN_REVIEWER'));
  const leadWork = patchBlueprintWork(config, 'financials', { roleId: config.defaults.leadRoleId });
  assert.ok(codes(blueprintStructuralIssues(leadWork)).includes('LEAD_WORK_NOT_ALLOWED'));
  const summaryLeadReviewer = patchBlueprintSummary(config, { reviewerRoleId: config.defaults.leadRoleId, reviewMode: 'self_check' });
  assert.equal(codes(blueprintStructuralIssues(summaryLeadReviewer)).includes('REVIEW_MODE_MISMATCH'), false, 'lead self-review summary is valid');
  const summaryIndependentNoEdge = patchBlueprintSummary(config, { reviewerRoleId: uuid(6), reviewMode: 'independent' });
  assert.ok(codes(blueprintStructuralIssues(summaryIndependentNoEdge)).includes('UNKNOWN_REVIEWER'));
});

function withReservedWork(config) {
  return { ...config, workBlueprint: { ...config.workBlueprint, works: [...config.workBlueprint.works, { workId: 'summary', roleId: config.roles[0].id, taskKind: 'specialist', objective: 'x', expectedOutput: 'y', dependencyWorkIds: [], reviewerRoleId: config.roles[0].id, reviewMode: 'self_check' }] } };
}

test('structural issues report too many participants and missing blueprint', () => {
  f.state.randomUUID = require('node:crypto').randomUUID;
  const { blueprintStructuralIssues } = f.load('features/teams/team-work-blueprint.ts');
  const legacy = configOf(); delete legacy.workBlueprint;
  assert.ok(codes(blueprintStructuralIssues(legacy)).includes('BLUEPRINT_MISSING'));
  const config = configOf();
  const extraRoles = [5, 6, 7].map(n => ({ id: uuid(n), departmentId: null, participation: 'enabled', responsibility: 'x', expectedOutput: 'y', executor: { executionMode: 'model', connectionId: uuid(90), model: 'm', settings: {} }, agentId: uuid(200 + n), agentVersionId: uuid(300 + n), allowedToolIds: [], sourceGrantIds: [] }));
  const crowded = { ...config, roles: [...config.roles, ...extraRoles], workBlueprint: { ...config.workBlueprint, works: [...config.workBlueprint.works, { workId: 'extra-1', roleId: uuid(5), taskKind: 'specialist', objective: 'x', expectedOutput: 'y', dependencyWorkIds: [], reviewerRoleId: uuid(6), reviewMode: 'independent' }, { workId: 'extra-2', roleId: uuid(6), taskKind: 'specialist', objective: 'x', expectedOutput: 'y', dependencyWorkIds: [], reviewerRoleId: uuid(7), reviewMode: 'independent' }] } };
  assert.ok(codes(blueprintStructuralIssues(crowded)).includes('TOO_MANY_PARTICIPANTS'));
});

test('blueprintDiff reports added, removed, changed and summary changes', () => {
  f.state.randomUUID = require('node:crypto').randomUUID;
  const { blueprintDiff, patchBlueprintWork, patchBlueprintSummary } = f.load('features/teams/team-work-blueprint.ts');
  const before = blueprint(configOf());
  const removed = removeWork(before, 'financials');
  const diff = blueprintDiff(before, removed);
  assert.equal(diff.removed.join(','), 'financials');
  assert.ok(diff.changed.some(change => change.workId === 'business' && change.fields.includes('dependencyWorkIds')));
  const added = addWork(before, { workId: 'growth', roleId: uuid(5), taskKind: 'growth', objective: 'x', expectedOutput: 'y', dependencyWorkIds: [], reviewerRoleId: uuid(6), reviewMode: 'independent' });
  assert.equal(blueprintDiff(before, added).added.join(','), 'growth');
  const reviewerChange = patchBlueprintWork(configOf(), 'financials', { reviewerRoleId: uuid(7) });
  const changed = blueprintDiff(before, blueprint(reviewerChange));
  assert.ok(changed.changed.some(change => change.workId === 'financials' && change.fields.includes('reviewerRoleId')));
  const summaryChange = patchBlueprintSummary(configOf(), { expectedOutput: 'different summary' });
  assert.equal(blueprintDiff(before, blueprint(summaryChange)).summary, 'changed');
  assert.equal(blueprintDiff(before, before).summary, 'unchanged');
  assert.equal(blueprintDiff(before, before).added.length, 0);
  assert.equal(blueprintDiff(undefined, before).added.length, 3);
});

function removeWork(blueprint, workId) {
  return { ...blueprint, works: blueprint.works.filter(work => work.workId !== workId).map(work => ({ ...work, dependencyWorkIds: work.dependencyWorkIds.filter(dep => dep !== workId) })) };
}
function addWork(blueprint, work) {
  return { ...blueprint, works: [...blueprint.works, work] };
}

test('suggestBlueprintFromOrganization builds a lead-reviewed division from enabled roles', () => {
  f.state.randomUUID = require('node:crypto').randomUUID;
  const { suggestBlueprintFromOrganization } = f.load('features/teams/team-work-blueprint.ts');
  const config = configOf(); delete config.workBlueprint;
  const suggested = suggestBlueprintFromOrganization(config);
  assert.ok(suggested);
  assert.equal(suggested.works.length, 3);
  assert.ok(suggested.works.every(work => work.reviewerRoleId === config.defaults.leadRoleId));
  assert.equal(suggested.summary.reviewerRoleId, config.defaults.leadRoleId);
  assert.equal(suggested.summary.reviewMode, 'self_check');
  const ids = new Set(suggested.works.map(work => work.workId));
  assert.equal(ids.size, 3, 'work ids are unique');
  assert.ok(suggested.works.every(work => /^[a-z][a-z0-9_-]{0,63}$/.test(work.workId)));
  const already = configOf();
  assert.equal(suggestBlueprintFromOrganization(already), null, 'existing blueprint takes precedence');
});
