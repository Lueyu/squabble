import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { makeTeamFixture, teamErrorIs } from './team-test.fixture';
import { TeamWorkPlanPreviewService } from './team-work-plan-preview.service';
import { AgentRosterService } from '../agent-roster/agent-roster.service';
import { TeamRunService } from '../team-runs/team-run.service';
import { teamRequests, teamPreviews, teamCommissions, teamCommissionJobs } from '../../database/teams.schema';
import { councilResearchTasks } from '../../database/research-workflow.schema';
import type { AgentProfile } from '../../../shared/agent-roster.interface';
import type { TeamRunAgreementInput } from '../../../shared/team-run.interface';
import type { TeamSemanticConfig } from '../../../shared/team-workspace.interface';

const options = { skip: !process.env.TEAM_TEST_DATABASE_URL };
const uuid = (n: number) => `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`;
const ids = { lead: uuid(1), financials: uuid(2), business: uuid(3), bear: uuid(4), research: uuid(10), challenge: uuid(11) };

/** Fictional classic organization; agents are only attached when the caller wants a run-ready team. */
function classicConfig(connectionId: string, friends?: Record<string, AgentProfile>): TeamSemanticConfig {
  const role = (id: string, departmentId: string | null, responsibility: string, expectedOutput: string) => ({
    id, departmentId, participation: 'enabled' as const, responsibility, expectedOutput,
    executor: { executionMode: 'model' as const, connectionId, model: 'fixture', settings: {} },
    allowedToolIds: [], sourceGrantIds: [],
    ...(friends?.[id] ? { agentId: friends[id].id, agentVersionId: friends[id].currentVersionId } : {}),
  });
  return {
    schemaVersion: 1,
    departments: [
      { id: ids.research, parentDepartmentId: null, purpose: 'Investment research' },
      { id: ids.challenge, parentDepartmentId: null, purpose: 'Independent challenge' },
    ],
    roles: [
      role(ids.lead, null, 'Lead the investment thesis', 'Final thesis and conditions'),
      role(ids.financials, ids.research, 'Verify cash flow and accounting', 'Accounting bridge and cash-flow evidence'),
      role(ids.business, ids.research, 'Explain the business and moat', 'Business evidence and counterevidence'),
      role(ids.bear, ids.challenge, 'Challenge the strongest claim', 'Strongest counterevidence and unknowns'),
    ],
    relations: [
      { id: uuid(100), fromRoleId: ids.financials, toRoleId: ids.lead, kind: 'reports_to' as const, responsibilityScope: 'Key financial risks' },
      { id: uuid(101), fromRoleId: ids.financials, toRoleId: ids.business, kind: 'reports_to' as const, responsibilityScope: 'Accounting basis' },
      { id: uuid(102), fromRoleId: ids.business, toRoleId: ids.lead, kind: 'reports_to' as const, responsibilityScope: 'Business conclusion' },
      { id: uuid(103), fromRoleId: ids.bear, toRoleId: ids.lead, kind: 'reports_to' as const, responsibilityScope: 'Challenge conclusion' },
      { id: uuid(104), fromRoleId: ids.lead, toRoleId: ids.financials, kind: 'delegates_to' as const, responsibilityScope: 'Financial request' },
      { id: uuid(105), fromRoleId: ids.lead, toRoleId: ids.business, kind: 'delegates_to' as const, responsibilityScope: 'Business request' },
      { id: uuid(106), fromRoleId: ids.lead, toRoleId: ids.bear, kind: 'delegates_to' as const, responsibilityScope: 'Challenge request' },
      { id: uuid(107), fromRoleId: ids.bear, toRoleId: ids.financials, kind: 'reviews' as const, responsibilityScope: 'Check strongest counterevidence' },
      { id: uuid(108), fromRoleId: ids.lead, toRoleId: ids.business, kind: 'reviews' as const, responsibilityScope: 'Business review' },
      { id: uuid(109), fromRoleId: ids.lead, toRoleId: ids.bear, kind: 'reviews' as const, responsibilityScope: 'Challenge review' },
      { id: uuid(110), fromRoleId: ids.bear, toRoleId: ids.lead, kind: 'reviews' as const, responsibilityScope: 'Final thesis review' },
    ],
    defaults: { leadRoleId: ids.lead, parallelism: 1 },
    workBlueprint: {
      schemaVersion: 1,
      works: [
        { workId: 'financials', roleId: ids.financials, taskKind: 'financials', objective: 'Verify the accounting bridge', expectedOutput: 'Cash-flow bridge with unknowns', dependencyWorkIds: [], reviewerRoleId: ids.bear, reviewMode: 'independent' },
        { workId: 'business', roleId: ids.business, taskKind: 'business', objective: 'Test the business claim', expectedOutput: 'Business evidence', dependencyWorkIds: ['financials'], reviewerRoleId: ids.lead, reviewMode: 'independent' },
        { workId: 'challenge', roleId: ids.bear, taskKind: 'challenge', objective: 'Find the strongest counterevidence', expectedOutput: 'Counterevidence and unknowns', dependencyWorkIds: ['financials', 'business'], reviewerRoleId: ids.lead, reviewMode: 'independent' },
      ],
      summary: { reviewerRoleId: ids.bear, reviewMode: 'independent', expectedOutput: 'Final thesis and conditions' },
    },
  };
}

async function rosterFriends(f: Awaited<ReturnType<typeof makeTeamFixture>>): Promise<Record<string, AgentProfile>> {
  const roster = new AgentRosterService(f.db);
  const friend = async (name: string, roleId: string) => roster.create(f.owner, { requestKey: randomUUID(), name,
    instructions: 'Frozen base instructions', executor: { executionMode: 'model', connectionId: f.connection.id, model: 'slow' }, allowedToolIds: [], allowedSources: [] });
  return { [ids.lead]: await friend('Lead friend', ids.lead), [ids.financials]: await friend('Financials friend', ids.financials),
    [ids.business]: await friend('Business friend', ids.business), [ids.bear]: await friend('Challenge friend', ids.bear) };
}

async function publishAndBind(f: Awaited<ReturnType<typeof makeTeamFixture>>, teamId: string, config: TeamSemanticConfig) {
  const detail = await f.service.detail(f.owner, teamId);
  const saved = await f.service.save(f.owner, teamId, 'draft', { requestKey: randomUUID(), expectedSemanticRevision: detail.semanticRevision, config });
  const pp = await f.versions.publishPreview(f.owner, teamId, { requestKey: randomUUID(), expectedSemanticRevision: saved.semanticRevision });
  const published = await f.versions.publish(f.owner, teamId, { requestKey: randomUUID(), previewId: pp.previewId, previewHash: pp.previewHash });
  const account = await f.account();
  const bp = await f.versions.bindingPreview(f.owner, teamId, { requestKey: randomUUID(), action: 'assign', accountId: account.id,
    teamVersionId: published.version.id, expectedBindingRevision: published.team.bindingRevision, expectedAccountBindingId: null,
    executionChoice: 'keep_confirmed_rules', acknowledgePendingReapproval: true });
  const binding = await f.versions.binding(f.owner, teamId, { requestKey: randomUUID(), previewId: bp.previewId, previewHash: bp.previewHash });
  return { saved, published, account, binding };
}

test('structural preview compiles the folder draft without writing or dispatching anything', options, async () => {
  const f = await makeTeamFixture();
  try {
    const t = await f.team();
    const config = classicConfig(f.connection.id);
    const saved = await f.service.save(f.owner, t.team.id, 'draft', { requestKey: randomUUID(), expectedSemanticRevision: t.team.semanticRevision, config });
    const workPlans = new TeamWorkPlanPreviewService(f.store);
    const snapshot = async () => ({
      requests: (await f.db.select().from(teamRequests)).length, previews: (await f.db.select().from(teamPreviews)).length,
      commissions: (await f.db.select().from(teamCommissions)).length, jobs: (await f.db.select().from(teamCommissionJobs)).length,
      tasks: (await f.db.select().from(councilResearchTasks)).length,
    });
    const before = await snapshot();
    const request = { requestKey: randomUUID(), expectedSemanticRevision: saved.semanticRevision, config };
    const result = await workPlans.preview(f.owner, t.team.id, request);
    assert.deepEqual(await snapshot(), before, 'Structural preview never writes request/preview/commission/job/task rows');
    assert.equal(result.mode, 'blueprint_v1');
    assert.equal(result.structurallyValid, true);
    assert.equal(result.dispatchable, false);
    assert.equal(result.blueprintHash?.length, 64);
    assert.equal(result.minimumCallCount, 8);
    assert.deepEqual(result.work.map(work => [work.workKey, work.roleId, work.dependencyWorkKeys, work.reviewerRoleId]), [
      ['financials', ids.financials, [], ids.bear],
      ['business', ids.business, ['financials'], ids.lead],
      ['challenge', ids.bear, ['business', 'financials'], ids.lead],
      ['summary', ids.lead, ['business', 'challenge', 'financials'], ids.bear],
    ]);
    const replay = await workPlans.preview(f.owner, t.team.id, { ...request, requestKey: randomUUID() });
    assert.deepEqual(replay.work, result.work, 'Replaying the preview never creates a second plan or request row');
    assert.deepEqual(await snapshot(), before);
  } finally {
    await f.dispose();
  }
});

test('structural preview keeps owner and revision boundaries', options, async () => {
  const f = await makeTeamFixture();
  try {
    const t = await f.team();
    const config = classicConfig(f.connection.id);
    const saved = await f.service.save(f.owner, t.team.id, 'draft', { requestKey: randomUUID(), expectedSemanticRevision: t.team.semanticRevision, config });
    const workPlans = new TeamWorkPlanPreviewService(f.store);
    await assert.rejects(workPlans.preview(f.stranger, t.team.id, { requestKey: randomUUID(), expectedSemanticRevision: saved.semanticRevision, config }),
      teamErrorIs('TEAM_NOT_FOUND'), 'Another owner cannot inspect this draft');
    await assert.rejects(workPlans.preview(f.owner, t.team.id, { requestKey: randomUUID(), expectedSemanticRevision: saved.semanticRevision + 1, config }),
      teamErrorIs('TEAM_REVISION_CONFLICT'), 'A stale revision is rejected instead of silently previewing a newer draft');
  } finally {
    await f.dispose();
  }
});

test('formal blueprint preview compiles the published division and freezes its proof into the commission', options, async () => {
  const f = await makeTeamFixture();
  try {
    const t = await f.team();
    const friends = await rosterFriends(f);
    const { published, binding } = await publishAndBind(f, t.team.id, classicConfig(f.connection.id, friends));
    const preview = await f.commissions.preview(f.owner, t.team.id, { requestKey: randomUUID(), planMode: 'blueprint',
      teamVersionId: published.version.id, bindingId: binding.binding!.id, expectedBindingRevision: binding.team.bindingRevision,
      objective: 'Fictional portfolio review', dataCutoffAt: null, deadlineAt: new Date(Date.now() + 3600000).toISOString(), inputRefs: [],
      budget: { budgetMode: 'cost_and_calls', ceiling: { amount: '8', currency: 'USD' }, callLimit: 8, paidRevisionLimit: 0 } });
    const plan = (preview.result as { plan: { workPlanProof: { mode: string; blueprintHash: string }; work: { workKey: string; roleId: string }[] } }).plan;
    assert.equal(plan.workPlanProof.mode, 'blueprint_v1');
    assert.equal(plan.workPlanProof.blueprintHash.length, 64);
    // The compiled work carries the frozen hashed identity, but the role order must follow the blueprint.
    assert.deepEqual(plan.work.map(work => work.roleId), [ids.financials, ids.business, ids.bear, ids.lead]);
    const frozenKeys = plan.work.map(work => work.workKey);
    const created = await f.commissions.create(f.owner, t.team.id, { requestKey: randomUUID(), previewId: preview.previewId, previewHash: preview.previewHash });
    const [commission] = await f.db.select().from(teamCommissions);
    assert.equal(created.state, 'queued');
    assert.equal(commission.plan.workPlanProof?.mode, 'blueprint_v1');
    assert.deepEqual(commission.plan.work.map(work => work.workKey), frozenKeys, 'Stored work freezes the exact preview plan, not a client-supplied list');
  } finally {
    await f.dispose();
  }
});

test('formal blueprint preview refuses a budget below the compiled reservation', options, async () => {
  const f = await makeTeamFixture();
  try {
    const t = await f.team();
    const friends = await rosterFriends(f);
    const { published, binding } = await publishAndBind(f, t.team.id, classicConfig(f.connection.id, friends));
    await assert.rejects(f.commissions.preview(f.owner, t.team.id, { requestKey: randomUUID(), planMode: 'blueprint',
      teamVersionId: published.version.id, bindingId: binding.binding!.id, expectedBindingRevision: binding.team.bindingRevision,
      objective: 'Fictional portfolio review', dataCutoffAt: null, deadlineAt: new Date(Date.now() + 3600000).toISOString(), inputRefs: [],
      budget: { budgetMode: 'cost_and_calls', ceiling: { amount: '4', currency: 'USD' }, callLimit: 4, paidRevisionLimit: 0 } }),
      (error: unknown) => {
        const response = (error as { getResponse: () => { code: string; required?: number; allowed?: number } }).getResponse();
        return response.code === 'TEAM_BUDGET_BLOCKED' && response.required === 8 && response.allowed === 4;
      }, 'The exact reserved-call gap is disclosed');
  } finally {
    await f.dispose();
  }
});

test('formal blueprint preview blocks an unready participating seat', options, async () => {
  const f = await makeTeamFixture();
  try {
    const t = await f.team();
    const config = classicConfig(f.connection.id);
    const financials = config.roles.find(role => role.id === ids.financials)!;
    financials.participation = 'placeholder';
    financials.executor = null;
    const { published, binding } = await publishAndBind(f, t.team.id, config);
    await assert.rejects(f.commissions.preview(f.owner, t.team.id, { requestKey: randomUUID(), planMode: 'blueprint',
      teamVersionId: published.version.id, bindingId: binding.binding!.id, expectedBindingRevision: binding.team.bindingRevision,
      objective: 'Fictional portfolio review', dataCutoffAt: null, deadlineAt: new Date(Date.now() + 3600000).toISOString(), inputRefs: [],
      budget: { budgetMode: 'cost_and_calls', ceiling: { amount: '8', currency: 'USD' }, callLimit: 8, paidRevisionLimit: 0 } }),
      teamErrorIs('TEAM_PLAN_INVALID'), 'A placeholder seat cannot be dispatched even when the division itself is valid');
    const workPlans = new TeamWorkPlanPreviewService(f.store);
    const detail = await f.service.detail(f.owner, t.team.id);
    const structural = await workPlans.preview(f.owner, t.team.id, { requestKey: randomUUID(), expectedSemanticRevision: detail.semanticRevision, config });
    assert.equal(structural.work.length, 4, 'The same draft is still previewable structurally');
    assert.ok(structural.warnings.some(warning => warning.code === 'ROLE_NOT_READY'));
  } finally {
    await f.dispose();
  }
});

test('legacy teams keep the historical division and its explicit proof mode', options, async () => {
  const f = await makeTeamFixture();
  try {
    const t = await f.team();
    const workPlans = new TeamWorkPlanPreviewService(f.store);
    const structural = await workPlans.preview(f.owner, t.team.id, { requestKey: randomUUID(), expectedSemanticRevision: t.team.semanticRevision, config: t.team.draft.config });
    assert.equal(structural.mode, 'legacy_v1');
    assert.deepEqual(structural.work, []);
    assert.ok(structural.warnings.some(warning => warning.code === 'BLUEPRINT_MISSING'));
    const legacy = await f.commission();
    const [commission] = await f.db.select().from(teamCommissions);
    assert.equal(commission.id, legacy.created.commissionId);
    assert.equal(commission.plan.workPlanProof?.mode, 'manual_custom', 'Manual custom plans disclose their own proof mode');
    assert.equal(commission.plan.workPlanProof?.blueprintHash, null);
  } finally {
    await f.dispose();
  }
});

test('automatic run previews carry the compiled proof for legacy and blueprint teams', options, async () => {
  const legacy = await makeTeamFixture();
  try {
    const t = await legacy.team();
    const roster = new AgentRosterService(legacy.db);
    const friend = await roster.create(legacy.owner, { requestKey: randomUUID(), name: 'Fictional analyst', instructions: 'Frozen base instructions',
      executor: { executionMode: 'model', connectionId: legacy.connection.id, model: 'slow' }, allowedToolIds: [], allowedSources: [] });
    const config = structuredClone(t.version.config);
    config.roles[0].agentId = friend.id;
    config.roles[0].agentVersionId = friend.currentVersionId;
    const detail = await legacy.service.detail(legacy.owner, t.team.id);
    const saved = await legacy.service.save(legacy.owner, t.team.id, 'draft', { requestKey: randomUUID(), expectedSemanticRevision: detail.semanticRevision, config });
    const pp = await legacy.versions.publishPreview(legacy.owner, t.team.id, { requestKey: randomUUID(), expectedSemanticRevision: saved.semanticRevision });
    const published = await legacy.versions.publish(legacy.owner, t.team.id, { requestKey: randomUUID(), previewId: pp.previewId, previewHash: pp.previewHash });
    const account = await legacy.account();
    const bp = await legacy.versions.bindingPreview(legacy.owner, t.team.id, { requestKey: randomUUID(), action: 'assign', accountId: account.id,
      teamVersionId: published.version.id, expectedBindingRevision: published.team.bindingRevision, expectedAccountBindingId: null,
      executionChoice: 'keep_confirmed_rules', acknowledgePendingReapproval: true });
    const binding = await legacy.versions.binding(legacy.owner, t.team.id, { requestKey: randomUUID(), previewId: bp.previewId, previewHash: bp.previewHash });
    const runs = new TeamRunService(legacy.store, legacy.commissions);
    const input: TeamRunAgreementInput = { requestKey: randomUUID(), teamVersionId: published.version.id, bindingId: binding.binding!.id,
      expectedBindingRevision: binding.team.bindingRevision, objective: 'Fictional portfolio review', market: 'CN',
      budget: { perRun: { budgetMode: 'cost_and_calls', ceiling: { amount: '2', currency: 'USD' }, callLimit: 2, paidRevisionLimit: 0 },
        daily: { costUsd: '2', calls: 2 }, monthly: { costUsd: '4', calls: 4 } },
      replacementPolicy: { kind: 'replace_combination', allocationPct: 50 }, inputRefs: [] };
    const preview = await runs.preview(legacy.owner, t.team.id, input);
    const configuration = (preview.result as { configuration: { workPlanProof?: { mode: string } } }).configuration;
    assert.equal(configuration.workPlanProof?.mode, 'legacy_run_v1', 'Old teams never silently claim the blueprint compiler');
  } finally {
    await legacy.dispose();
  }
  const modern = await makeTeamFixture();
  try {
    const t = await modern.team();
    const friends = await rosterFriends(modern);
    const { published, binding } = await publishAndBind(modern, t.team.id, classicConfig(modern.connection.id, friends));
    const runs = new TeamRunService(modern.store, modern.commissions);
    const input: TeamRunAgreementInput = { requestKey: randomUUID(), teamVersionId: published.version.id, bindingId: binding.binding!.id,
      expectedBindingRevision: binding.team.bindingRevision, objective: 'Fictional portfolio review', market: 'CN',
      budget: { perRun: { budgetMode: 'cost_and_calls', ceiling: { amount: '8', currency: 'USD' }, callLimit: 8, paidRevisionLimit: 0 },
        daily: { costUsd: '8', calls: 8 }, monthly: { costUsd: '16', calls: 16 } },
      replacementPolicy: { kind: 'replace_combination', allocationPct: 50 }, inputRefs: [] };
    const preview = await runs.preview(modern.owner, t.team.id, input);
    const configuration = (preview.result as { configuration: { workPlanProof?: { mode: string; blueprintHash: string } } }).configuration;
    assert.equal(configuration.workPlanProof?.mode, 'blueprint_v1', 'Automatic runs compile the published blueprint');
    assert.equal(configuration.workPlanProof?.blueprintHash.length, 64);
  } finally {
    await modern.dispose();
  }
});
