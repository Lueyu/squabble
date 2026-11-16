import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { makeTeamFixture } from './team-test.fixture';
import { AgentRosterService } from '../agent-roster/agent-roster.service';
import { TeamCommissionWorker } from './team-commission.worker';
import { TeamWorkPlanPreviewService } from './team-work-plan-preview.service';
import { CouncilWorkflowStore } from '../council/council.workflow-store';
import { teamTaskPlan } from '../council/council.team';
import { councilSessions } from '../../database/council.schema';
import { teamCommissions } from '../../database/teams.schema';
import type { AgentProfile } from '../../../shared/agent-roster.interface';
import type { TeamSemanticConfig } from '../../../shared/team-workspace.interface';

const options = { skip: !process.env.TEAM_TEST_DATABASE_URL };
const uuid = (n: number) => `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`;
const ids = { lead: uuid(1), financials: uuid(2), business: uuid(3), bear: uuid(4), research: uuid(10), challenge: uuid(11) };
const memberIdOf = (roleId: string) => roleId.replaceAll('-', '');

function classicConfig(connectionId: string, friends: Record<string, AgentProfile>): TeamSemanticConfig {
  const role = (id: string, departmentId: string | null, responsibility: string, expectedOutput: string) => ({
    id, departmentId, participation: 'enabled' as const, responsibility, expectedOutput,
    executor: { executionMode: 'model' as const, connectionId, model: 'fixture', settings: {} },
    allowedToolIds: [], sourceGrantIds: [],
    agentId: friends[id].id, agentVersionId: friends[id].currentVersionId,
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
  const friend = async (name: string) => roster.create(f.owner, { requestKey: randomUUID(), name,
    instructions: 'Frozen base instructions', executor: { executionMode: 'model', connectionId: f.connection.id, model: 'slow' }, allowedToolIds: [], allowedSources: [] });
  return { [ids.lead]: await friend('Lead friend'), [ids.financials]: await friend('Financials friend'),
    [ids.business]: await friend('Business friend'), [ids.bear]: await friend('Challenge friend') };
}

test('prepared council tasks carry the exact compiled member, reviewer and dependency identity', options, async () => {
  const f = await makeTeamFixture();
  try {
    const t = await f.team();
    const friends = await rosterFriends(f);
    const config = classicConfig(f.connection.id, friends);
    const detail = await f.service.detail(f.owner, t.team.id);
    const saved = await f.service.save(f.owner, t.team.id, 'draft', { requestKey: randomUUID(), expectedSemanticRevision: detail.semanticRevision, config });
    const pp = await f.versions.publishPreview(f.owner, t.team.id, { requestKey: randomUUID(), expectedSemanticRevision: saved.semanticRevision });
    const published = await f.versions.publish(f.owner, t.team.id, { requestKey: randomUUID(), previewId: pp.previewId, previewHash: pp.previewHash });
    const account = await f.account();
    const bp = await f.versions.bindingPreview(f.owner, t.team.id, { requestKey: randomUUID(), action: 'assign', accountId: account.id,
      teamVersionId: published.version.id, expectedBindingRevision: published.team.bindingRevision, expectedAccountBindingId: null,
      executionChoice: 'keep_confirmed_rules', acknowledgePendingReapproval: true });
    const binding = await f.versions.binding(f.owner, t.team.id, { requestKey: randomUUID(), previewId: bp.previewId, previewHash: bp.previewHash });
    const request = { requestKey: randomUUID(), planMode: 'blueprint' as const, teamVersionId: published.version.id,
      bindingId: binding.binding!.id, expectedBindingRevision: binding.team.bindingRevision, objective: 'Fictional portfolio review',
      dataCutoffAt: null, deadlineAt: new Date(Date.now() + 3600000).toISOString(), inputRefs: [] as [],
      budget: { budgetMode: 'cost_and_calls' as const, ceiling: { amount: '8', currency: 'USD' }, callLimit: 8, paidRevisionLimit: 0 } };
    const preview = await f.commissions.preview(f.owner, t.team.id, request);
    const previewPlan = (preview.result as { plan: { workPlanProof: { mode: string; blueprintHash: string }; work: Array<{ workKey: string }> } }).plan;
    await f.commissions.create(f.owner, t.team.id, { requestKey: randomUUID(), previewId: preview.previewId, previewHash: preview.previewHash });
    const [commission] = await f.db.select().from(teamCommissions).where(eq(teamCommissions.teamId, t.team.id));
    const worker = new TeamCommissionWorker(f.store, f.runtime, f.commissions);
    await worker.runOnce();
    await worker.runOnce();
    const [session] = await f.db.select().from(councilSessions).where(eq(councilSessions.teamCommissionId, commission.id));
    assert.ok(session, 'The durable prepare step created the council session');
    // The fixture runtime stub does not flip the session to running; emulate the durable start command.
    await f.db.update(councilSessions).set({ status: 'running' }).where(eq(councilSessions.id, session.id));
    const store = new CouncilWorkflowStore(f.db as never);
    await store.initialize({ ...session, status: 'running' }, teamTaskPlan(session.checkpoint!.teamContext!), () => []);
    const tasks = await store.list(f.owner, session.id, session.checkpoint!.cycleId);
    const memberId = (roleId: string) => roleId.replaceAll('-', '');
    // The frozen plan re-hashes every work key; tasks carry those final keys in the same stable order.
    const byKey = new Map(tasks.map(task => [task.key, task]));
    assert.equal(tasks.map(task => task.key).join(','), 'financials,business,challenge,summary');
    const financials = byKey.get('financials')!, business = byKey.get('business')!, challenge = byKey.get('challenge')!, summary = byKey.get('summary')!;
    assert.equal(financials.memberId, memberId(ids.financials));
    assert.equal(financials.reviewerMemberId, memberId(ids.bear));
    assert.equal((financials.dependencyWorkKeys ?? []).join(','), '');
    assert.equal(business.memberId, memberId(ids.business));
    assert.equal(business.reviewerMemberId, memberId(ids.lead));
    assert.equal((business.dependencyWorkKeys ?? []).join(','), financials.workKey);
    assert.equal(challenge.memberId, memberId(ids.bear));
    assert.equal(challenge.reviewerMemberId, memberId(ids.lead));
    assert.equal([...(challenge.dependencyWorkKeys ?? [])].sort().join(','), [financials.workKey, business.workKey].sort().join(','));
    assert.equal(summary.memberId, memberId(ids.lead));
    assert.equal(summary.reviewerMemberId, memberId(ids.bear));
    assert.equal([...(summary.dependencyWorkKeys ?? [])].sort().join(','), [financials.workKey, business.workKey, challenge.workKey].sort().join(','));
    // Every stored task froze the exact compiled work identity, never a re-derived one.
    assert.equal(tasks.map(task => task.workKey).join(','), previewPlan.work.map(work => work.workKey).join(','));
    const independent = tasks.filter(task => task.reviewerMemberId !== task.memberId);
    assert.equal(independent.length, tasks.length, 'Independent seats never review themselves');
    assert.equal(commission.plan.workPlanProof?.mode, 'blueprint_v1');
    assert.equal(previewPlan.workPlanProof.blueprintHash, commission.plan.workPlanProof?.blueprintHash,
      'The stored plan and the preview expose the same compiled blueprint hash');
  } finally {
    await f.dispose();
  }
});

test('a friend can independently review a deliverable before executing their own dependent work', options, async () => {
  const f = await makeTeamFixture();
  try {
    const t = await f.team();
    const friends = await rosterFriends(f);
    const config = classicConfig(f.connection.id, friends);
    const detail = await f.service.detail(f.owner, t.team.id);
    const saved = await f.service.save(f.owner, t.team.id, 'draft', { requestKey: randomUUID(), expectedSemanticRevision: detail.semanticRevision, config });
    const pp = await f.versions.publishPreview(f.owner, t.team.id, { requestKey: randomUUID(), expectedSemanticRevision: saved.semanticRevision });
    const published = await f.versions.publish(f.owner, t.team.id, { requestKey: randomUUID(), previewId: pp.previewId, previewHash: pp.previewHash });
    const account = await f.account();
    const bp = await f.versions.bindingPreview(f.owner, t.team.id, { requestKey: randomUUID(), action: 'assign', accountId: account.id,
      teamVersionId: published.version.id, expectedBindingRevision: published.team.bindingRevision, expectedAccountBindingId: null,
      executionChoice: 'keep_confirmed_rules', acknowledgePendingReapproval: true });
    const binding = await f.versions.binding(f.owner, t.team.id, { requestKey: randomUUID(), previewId: bp.previewId, previewHash: bp.previewHash });
    const request = { requestKey: randomUUID(), planMode: 'blueprint' as const, teamVersionId: published.version.id,
      bindingId: binding.binding!.id, expectedBindingRevision: binding.team.bindingRevision, objective: 'Fictional portfolio review',
      dataCutoffAt: null, deadlineAt: new Date(Date.now() + 3600000).toISOString(), inputRefs: [] as [],
      budget: { budgetMode: 'cost_and_calls' as const, ceiling: { amount: '8', currency: 'USD' }, callLimit: 8, paidRevisionLimit: 0 } };
    const preview = await f.commissions.preview(f.owner, t.team.id, request);
    await f.commissions.create(f.owner, t.team.id, { requestKey: randomUUID(), previewId: preview.previewId, previewHash: preview.previewHash });
    const [commission] = await f.db.select().from(teamCommissions).where(eq(teamCommissions.teamId, t.team.id));
    const worker = new TeamCommissionWorker(f.store, f.runtime, f.commissions);
    await worker.runOnce();
    await worker.runOnce();
    const [session] = await f.db.select().from(councilSessions).where(eq(councilSessions.teamCommissionId, commission.id));
    await f.db.update(councilSessions).set({ status: 'running' }).where(eq(councilSessions.id, session.id));
    const store = new CouncilWorkflowStore(f.db as never);
    await store.initialize({ ...session, status: 'running' }, teamTaskPlan(session.checkpoint!.teamContext!), () => []);
    const tasks = await store.list(f.owner, session.id, session.checkpoint!.cycleId);
    const financials = tasks.find(task => task.key === 'financials')!;
    const challenge = tasks.find(task => task.key === 'challenge')!;
    // The challenge seat is also the explicit independent reviewer of the financial deliverable...
    assert.equal(financials.reviewerMemberId, challenge.memberId);
    // ...which never turns into a self-review: the financial deliverable is executed by a different seat.
    assert.notEqual(financials.reviewerMemberId, financials.memberId);
    // The challenge work depends on the financial deliverable, so the shared seat reviews it as part of
    // acceptance before executing its own work; no deadlock and no identity duplication.
    assert.ok((challenge.dependencyWorkKeys ?? []).includes(financials.workKey));
    assert.equal(challenge.reviewerMemberId, memberIdOf(ids.lead));
  } finally {
    await f.dispose();
  }
});
