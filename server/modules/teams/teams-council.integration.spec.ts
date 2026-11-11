import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import axios from 'axios';
import { eq } from 'drizzle-orm';
import { councilReports, councilSessions } from '../../database/council.schema';
import { dataLibrarySources, dataLibraryVersions } from '../../database/data-library.schema';
import { llmBudgetUsage } from '../../database/llm-budget.schema';
import { modelConnections } from '../../database/model-connections.schema';
import { teamCommissionJobs } from '../../database/teams.schema';
import type { ResearchSourceRef, TeamSemanticConfig, TeamWorkItem } from '../../../shared/team-workspace.interface';
import { CouncilService } from '../council/council.service';
import type { WorkflowCallbacks } from '../council/council.workflow';
import { LlmBudgetService } from '../llm-budget/llm-budget.service';
import { teamStrategyAuthority } from '../paper-trading/team-strategy-transaction';
import { StrategyModelService } from '../paper-trading/strategy-model.service';
import { UserInvestmentStrategyService } from '../paper-trading/user-investment-strategy.service';
import { LlmService, type ChatMessage } from '../research-core/llm.service';
import { ResearchDocumentsService } from '../research-documents/research-documents.service';
import { ModelConnectionsService } from '../settings/model-connections.service';
import { SettingsService } from '../settings/settings.service';
import { encryptSecret } from '../settings/settings-security';
import { TeamCommissionService } from './team-commission.service';
import { TeamCommissionWorker } from './team-commission.worker';
import { TeamRuntimeAdapter } from './team-runtime-adapter';
import { makeTeamFixture, teamErrorIs } from './team-test.fixture';

interface ProviderInput {
  task: { id: string; key: string; assignment: TeamWorkItem };
  member: { name: string };
  skills: Array<{ id: string; version: string; hash: string }>;
  evidence: Array<{ id: string }>;
  submitted?: unknown;
}
interface ProviderCall { input: ProviderInput; phase: 'work' | 'review' }
interface ProviderReply { text?: string; data?: unknown; usage?: 'known' | 'missing'; status?: number }
type Provider = (call: ProviderCall) => ProviderReply | Promise<ProviderReply>;
type CommissionDetail = Awaited<ReturnType<TeamCommissionService['detail']>>;
type DurableTask = CommissionDetail['tasks'][number];
interface CouncilInternals {
  jobs: Map<string, Promise<void>>;
  workflow: { callbacks: WorkflowCallbacks };
}

const fixtureAsOf = '2020-01-01T00:00:00.000Z';
const malformedText = 'private fixture provider response: malformed JSON';

function delivery(input: ProviderInput) {
  return { conclusion: `Finding: ${input.task.assignment.objective}`, evidenceIds: input.evidence.slice(0, 1).map(item => item.id),
    asOf: fixtureAsOf, currency: 'USD', units: 'USD', assumptions: [], gaps: [], skillVersions: input.skills,
    response: { thesis: 'Fictional evidence supports an observation', evidencePoints: ['Fictional evidence'],
      risks: ['Fictional uncertainty'], nextChecks: ['Review the next fixture version'] } };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function findTask(detail: Pick<CommissionDetail, 'tasks'>, objective: string): DurableTask {
  const task = detail.tasks?.find(item => item.assignment?.objective === objective);
  assert.ok(task, `Expected durable task for ${objective}`);
  return task;
}
function count(calls: ProviderCall[], objective: string, phase: ProviderCall['phase']) {
  return calls.filter(call => call.input.task.assignment.objective === objective && call.phase === phase).length;
}

/** Only the provider HTTP boundary is replaced. Council, settings, budget and PG writes are real. */
async function realCouncilFixture(t: TestContext, provider: Provider = () => ({})) {
  const f = await makeTeamFixture();
  const encryptionBefore = process.env.SETTINGS_ENCRYPTION_KEY;
  const encryptionKey = 'team-council-fictional-test-key';
  process.env.SETTINGS_ENCRYPTION_KEY = encryptionKey;
  const calls: ProviderCall[] = [];
  try {
    // Freeze decisions after PG-generated receipts; no sleeps or host/container clock races.
    const [clock] = await f.client<{ milliseconds: string }[]>`SELECT (extract(epoch FROM clock_timestamp()) * 1000)::text AS milliseconds`;
    t.mock.timers.enable({ apis: ['Date'], now: Math.ceil(Number(clock.milliseconds)) + 3600000 });
    await f.db.update(modelConnections).set({ baseUrl: 'https://8.8.8.8/v1',
      apiKeyEnc: encryptSecret('fictional-provider-key', encryptionKey) }).where(eq(modelConnections.id, f.connection.id));
    const budget = new LlmBudgetService(f.db);
    await budget.saveSettings(f.owner, { ...await budget.getSettings(f.owner), maxCallsPerTask: 40,
      dailyCallLimit: 100, perTaskTokenLimit: 200000, dailyTokenLimit: 500000, monthlyTokenLimit: 1000000 });
    const connections = new ModelConnectionsService(f.db);
    const settings = new SettingsService(f.db, undefined, connections);
    const llm = new LlmService(settings, budget);
    const http = t.mock.method(axios, 'post', async (url: string, body: { messages: ChatMessage[] }) => {
      assert.equal(url, 'https://8.8.8.8/v1/chat/completions', 'No real provider endpoint may be used');
      const message = body.messages.find(item => item.role === 'user');
      assert.ok(message);
      const input = JSON.parse(message.content) as ProviderInput;
      const call: ProviderCall = { input, phase: input.submitted ? 'review' : 'work' };
      calls.push(call);
      const reply = await provider(call);
      return { status: reply.status ?? 200, data: { model: 'fixture',
        choices: [{ finish_reason: 'stop', message: { content: reply.text ?? JSON.stringify(reply.data ??
          (call.phase === 'review' ? { accepted: true, feedback: 'Independently checked fixture evidence' } : delivery(input))) } }],
        ...(reply.usage === 'missing' ? {} : { usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } }) } };
    });
    const documents = new ResearchDocumentsService(f.db);
    const strategies = new UserInvestmentStrategyService(f.db, documents, new StrategyModelService(llm, undefined, budget));
    const council = new CouncilService(f.db, llm, undefined, undefined, undefined, undefined, budget,
      undefined, undefined, documents);
    const internals = council as unknown as CouncilInternals;
    const runtime = new TeamRuntimeAdapter(council);
    const commissions = new TeamCommissionService(f.store, runtime);
    const worker = new TeamCommissionWorker(f.store, runtime, commissions);

    async function create(options: { roles?: number; work?: (roles: string[]) => TeamWorkItem[];
      paidRevisionLimit?: number; inputRefs?: ResearchSourceRef[] } = {}) {
      const created = await f.service.create(f.owner, { requestKey: randomUUID(), name: 'Fictional real Council team' });
      const roles = Array.from({ length: options.roles ?? 1 }, () => randomUUID());
      const config: TeamSemanticConfig = { schemaVersion: 1, departments: [], relations: [],
        roles: roles.map(id => ({ id, departmentId: null, participation: 'enabled', responsibility: 'Check fictional evidence',
          expectedOutput: 'Structured evidence', executor: { executionMode: 'model', connectionId: f.connection.id,
            model: 'fixture', settings: {} }, allowedToolIds: [], sourceGrantIds: [] })),
        defaults: { leadRoleId: roles[0], parallelism: 1 } };
      const saved = await f.service.save(f.owner, created.id, 'draft', { requestKey: randomUUID(), expectedSemanticRevision: 1, config });
      const vp = await f.versions.publishPreview(f.owner, created.id, { requestKey: randomUUID(), expectedSemanticRevision: saved.semanticRevision });
      let team = await f.versions.publish(f.owner, created.id, { requestKey: randomUUID(), previewId: vp.previewId, previewHash: vp.previewHash });
      const account = await f.account();
      const inputRefs = options.inputRefs ?? [];
      const grantIds: string[] = [];
      for (const sourceRef of inputRefs) {
        const detail = await f.service.detail(f.owner, created.id);
        const granted = await f.sources.grant(f.owner, created.id, { requestKey: randomUUID(), expectedScopeRevision: detail.scopeRevision, sourceRef });
        grantIds.push(granted.grant.id);
      }
      if (grantIds.length) {
        const detail = await f.service.detail(f.owner, created.id);
        const scoped = { ...config, roles: config.roles.map(role => ({ ...role, sourceGrantIds: grantIds })) };
        const saved = await f.service.save(f.owner, created.id, 'draft', { requestKey: randomUUID(), expectedSemanticRevision: detail.semanticRevision, config: scoped });
        const preview = await f.versions.publishPreview(f.owner, created.id, { requestKey: randomUUID(), expectedSemanticRevision: saved.semanticRevision });
        team = await f.versions.publish(f.owner, created.id, { requestKey: randomUUID(), previewId: preview.previewId, previewHash: preview.previewHash });
      }
      const bp = await f.versions.bindingPreview(f.owner, created.id, { requestKey: randomUUID(), action: 'assign', accountId: account.id,
        teamVersionId: team.version.id, expectedBindingRevision: 0, expectedAccountBindingId: null,
        executionChoice: 'keep_confirmed_rules', acknowledgePendingReapproval: true });
      const bound = await f.versions.binding(f.owner, created.id, { requestKey: randomUUID(), previewId: bp.previewId, previewHash: bp.previewHash });
      assert.ok(bound.binding);
      const work = options.work?.(roles) ?? [workItem('summary', roles[0], 'summary')];
      const preview = await commissions.preview(f.owner, created.id, { requestKey: randomUUID(), teamVersionId: team.version.id,
        bindingId: bound.binding.id, expectedBindingRevision: bound.team.bindingRevision, leadRoleId: roles[0], participantRoleIds: roles,
        supervisorRoleIds: [], objective: 'Real durable Council fixture', expectedOutput: 'Evidence and report', dataCutoffAt: null,
        deadlineAt: new Date(Date.now() + 3600000).toISOString(), parallelism: 1, inputRefs, conflictResolutions: [], work,
        budget: { budgetMode: 'cost_and_calls', ceiling: { amount: '1', currency: 'USD' }, callLimit: 30,
          paidRevisionLimit: options.paidRevisionLimit ?? 0 } });
      const command = { requestKey: randomUUID(), previewId: preview.previewId, previewHash: preview.previewHash };
      const result = await commissions.create(f.owner, created.id, command);
      return { teamId: created.id, account, roles, command, result };
    }
    type Created = Awaited<ReturnType<typeof create>>;
    async function detail(created: Created) { return commissions.detail(f.owner, created.teamId, created.result.commissionId); }
    async function drain(created: Created) {
      for (let step = 0; step < 8; step++) {
        const pending = await f.db.select().from(teamCommissionJobs).where(eq(teamCommissionJobs.state, 'pending'));
        if (!pending.length) break;
        await worker.runOnce();
      }
      const row = await detail(created);
      assert.ok(row.sessionId, 'Real Council prepare must persist a session');
      await internals.jobs.get(`${f.owner}:${row.sessionId}`);
      await worker.project(row.id);
      return detail(created);
    }
    async function dispose() {
      http.mock.restore();
      if (encryptionBefore === undefined) delete process.env.SETTINGS_ENCRYPTION_KEY;
      else process.env.SETTINGS_ENCRYPTION_KEY = encryptionBefore;
      await f.dispose();
    }
    return { ...f, calls, council, strategies, internals, commissions, worker, create, detail, drain, dispose };
  } catch (error) {
    if (encryptionBefore === undefined) delete process.env.SETTINGS_ENCRYPTION_KEY;
    else process.env.SETTINGS_ENCRYPTION_KEY = encryptionBefore;
    await f.dispose();
    throw error;
  }
}

function workItem(objective: string, roleId: string, taskKind: TeamWorkItem['taskKind'] = 'specialist',
  dependencyWorkKeys: string[] = [], reviewerRoleId = roleId): TeamWorkItem {
  return { workKey: objective, roleId, taskKind, objective, expectedOutput: 'Structured evidence', dependencyWorkKeys,
    reviewerRoleId, reviewMode: reviewerRoleId === roleId ? 'self_check' : 'independent', inputRefs: [], requestedByRoleIds: [] };
}

test('real Council prepares a solo commission and repeated commands/status reads never dispatch again', async t => {
  const f = await realCouncilFixture(t);
  try {
    const created = await f.create();
    assert.equal(f.calls.length, 0, 'Preview/create are local durable commands');
    assert.deepEqual(await f.commissions.create(f.owner, created.teamId, created.command), created.result);
    const detail = await f.drain(created);
    assert.equal(detail.state, 'completed');
    assert.equal(f.calls.length, 1);
    const [session] = await f.db.select().from(councilSessions).where(eq(councilSessions.id, detail.sessionId!));
    assert.equal(session.profileSnapshot.council?.members.length, 1);
    assert.equal(session.teamCommissionId, detail.id);
    const [start] = (await f.db.select().from(teamCommissionJobs)).filter(job => job.kind === 'start');
    assert.ok(start);
    await f.council.runTeamSessionOnce(f.owner, start.id, detail.sessionId!);
    await f.worker.runOnce();
    for (let index = 0; index < 3; index++) {
      await f.detail(created);
      await f.council.getSession(f.owner, detail.sessionId!);
      await f.service.detail(f.owner, created.teamId);
    }
    assert.equal(f.calls.length, 1);
    assert.equal((await f.db.select().from(llmBudgetUsage)).length, 1);
    assert.equal((await f.db.select().from(councilReports)).length, 1);
    const [report] = await f.db.select().from(councilReports);
    await assert.rejects(f.council.draftReportRevision(f.owner, session.id, report.id, randomUUID(),
      { generate: true, requestId: randomUUID() }), /TEAM_RESEARCH_COMMAND_REQUIRED/);
    await assert.rejects(f.council.resumeDailyReport(f.owner, session.id,
      { requestKey: randomUUID(), expectedRevision: session.revision }), /TEAM_RESEARCH_COMMAND_REQUIRED/);
    await assert.rejects(f.council.attachPaperOrder(f.owner, report.id, randomUUID()), /TEAM_RESEARCH_COMMAND_REQUIRED/);
    assert.equal(f.calls.length, 1, 'Legacy endpoints cannot create unscoped work or attach an unrelated account');
  } finally { await f.dispose(); }
});

test('explicit specialist work identities and assigned reviewer survive the real workflow, including independent summary review', async t => {
  const f = await realCouncilFixture(t);
  try {
    const created = await f.create({ roles: 3, work: ([lead, specialist, reviewer]) => [
      workItem('historical cash flow', specialist, 'specialist', [], reviewer),
      workItem('current cash flow', specialist, 'specialist', [], reviewer),
      workItem('summary', lead, 'summary', ['historical cash flow', 'current cash flow'], reviewer),
    ] });
    const detail = await f.drain(created);
    assert.equal(detail.state, 'completed');
    assert.equal(detail.tasks?.length, 3);
    assert.equal(new Set(detail.tasks?.map(item => item.workKey)).size, 3);
    const reviewer = detail.members.find(member => member.roleId === created.roles[2]);
    assert.ok(reviewer);
    for (const objective of ['historical cash flow', 'current cash flow', 'summary']) {
      const task = findTask(detail, objective);
      assert.equal(task.state, 'accepted');
      assert.equal(task.reviewerMemberId, reviewer.memberId);
      assert.equal(count(f.calls, objective, 'work'), 1);
      assert.equal(count(f.calls, objective, 'review'), 1);
      assert.equal(f.calls.find(call => call.phase === 'review' && call.input.task.id === task.id)?.input.member.name, reviewer.label);
      assert.deepEqual(task.attempts.map(attempt => attempt.kind), ['work', 'review']);
    }
    assert.equal(f.calls.length, 6);
    const summary = findTask(detail, 'summary');
    assert.deepEqual(summary.dependencyWorkKeys?.sort(), detail.tasks?.filter(item => item.key === 'specialist').map(item => item.workKey).sort());
  } finally { await f.dispose(); }
});

test('one authorized business rework is shared by the entire commission', async t => {
  const f = await realCouncilFixture(t, call => call.phase === 'review' && call.input.task.key !== 'summary'
    ? { data: { accepted: false, feedback: 'Fixture evidence needs revision' } } : {});
  try {
    const created = await f.create({ roles: 2, paidRevisionLimit: 1, work: ([lead, specialist]) => [
      workItem('first branch', specialist, 'specialist', [], lead),
      workItem('second branch', specialist, 'specialist', [], lead),
      workItem('summary', lead, 'summary', ['first branch', 'second branch'], specialist),
    ] });
    const detail = await f.drain(created);
    assert.equal(detail.state, 'partial');
    assert.equal(detail.tasks?.reduce((sum, task) => sum + task.reworks, 0), 1);
    assert.equal(count(f.calls, 'first branch', 'work') + count(f.calls, 'second branch', 'work'), 3);
    assert.ok(detail.tasks?.filter(task => task.key === 'specialist').every(task => task.state === 'failed'));
    const failed = findTask(detail, 'first branch');
    await assert.rejects(f.commissions.control(f.owner, created.teamId, detail.id, 'recover', {
      requestKey: randomUUID(), expectedCommissionRevision: detail.commissionRevision, action: 'retry_work',
      workKey: failed.workKey!, attemptId: failed.attempts.at(-1)!.id, acknowledgePaidRetry: true, reason: 'No extra authority' }), teamErrorIs('TEAM_BUDGET_BLOCKED'));
  } finally { await f.dispose(); }
});

test('known malformed JSON retains raw response and usage; targeted paid retry replaces dependent summary and preserves accepted sibling', { timeout: 30000 }, async t => {
  const retryEntered = deferred(), releaseRetry = deferred();
  let firstBranchCalls = 0;
  const f = await realCouncilFixture(t, async call => {
    if (call.input.task.assignment.objective === 'repaired branch' && call.phase === 'work') {
      firstBranchCalls++;
      if (firstBranchCalls === 1) return { text: malformedText };
      retryEntered.resolve();
      await releaseRetry.promise;
    }
    return {};
  });
  try {
    const created = await f.create({ roles: 2, paidRevisionLimit: 1, work: ([lead, specialist]) => [
      workItem('repaired branch', specialist, 'specialist', [], lead),
      workItem('retained branch', specialist, 'specialist', [], lead),
      workItem('summary', lead, 'summary', ['repaired branch', 'retained branch'], specialist),
    ] });
    const partial = await f.drain(created);
    assert.equal(partial.state, 'partial');
    const failed = findTask(partial, 'repaired branch'), retained = findTask(partial, 'retained branch'), summary = findTask(partial, 'summary');
    const malformed = failed.attempts[0];
    assert.equal(failed.state, 'failed');
    assert.equal(malformed.state, 'failed');
    assert.equal(malformed.dispatched, true);
    assert.equal(malformed.savedResponse?.text, malformedText);
    assert.equal(malformed.tokens, 30);
    assert.equal(malformed.externalUsageUnknown, false);
    assert.ok(!failed.reason?.includes(malformedText), 'Private response is retained only in the private receipt');
    assert.equal(partial.cost.externalUsageUnknown, false);
    assert.ok((await f.db.select().from(llmBudgetUsage)).every(row => row.status === 'completed'));
    assert.ok(retained.acceptedAttemptId);
    assert.ok(summary.acceptedAttemptId);
    const beforeCheckCalls = f.calls.length;
    const check = { requestKey: randomUUID(), expectedCommissionRevision: partial.commissionRevision, action: 'check_existing' as const,
      workKey: failed.workKey!, attemptId: malformed.id };
    await f.commissions.control(f.owner, created.teamId, partial.id, 'recover', check);
    await f.commissions.control(f.owner, created.teamId, partial.id, 'recover', check);
    await f.drain(created);
    await f.council.getSession(f.owner, partial.sessionId!);
    assert.equal(f.calls.length, beforeCheckCalls, 'Known invalid output/status checks cannot replay a provider call');
    const current = await f.detail(created);
    const retry = { requestKey: randomUUID(), expectedCommissionRevision: current.commissionRevision, action: 'retry_work' as const,
      workKey: failed.workKey!, attemptId: malformed.id, acknowledgePaidRetry: true as const, reason: 'Explicit fictional repair' };
    await f.commissions.control(f.owner, created.teamId, partial.id, 'recover', retry);
    await f.commissions.control(f.owner, created.teamId, partial.id, 'recover', retry);
    await f.worker.runOnce();
    await retryEntered.promise;
    const during = await f.detail(created);
    assert.equal(findTask(during, 'summary').acceptedAttemptId, null);
    assert.equal(findTask(during, 'summary').delivery, null);
    assert.equal(findTask(during, 'retained branch').acceptedAttemptId, retained.acceptedAttemptId);
    assert.deepEqual(findTask(during, 'retained branch').attempts, retained.attempts);
    releaseRetry.resolve();
    const complete = await f.drain(created);
    assert.equal(complete.state, 'completed', JSON.stringify({ tasks: complete.tasks?.map(task => ({ objective: task.assignment?.objective,
      state: task.state, reason: task.reason, reworks: task.reworks, attempts: task.attempts.map(attempt => ({ kind: attempt.kind,
        state: attempt.state, error: attempt.error, tokens: attempt.tokens })) })), reports: (await f.council.getSession(f.owner, complete.sessionId!)).reports.map(report => ({ outcome: report.publicationOutcome })) }));
    assert.notEqual(findTask(complete, 'summary').acceptedAttemptId, summary.acceptedAttemptId);
    assert.equal(findTask(complete, 'retained branch').acceptedAttemptId, retained.acceptedAttemptId);
    assert.equal(count(f.calls, 'repaired branch', 'work'), 2);
    assert.equal(count(f.calls, 'retained branch', 'work'), 1);
    assert.equal(count(f.calls, 'summary', 'work'), 2);
    assert.equal((await f.db.select().from(councilReports)).length, 2, 'Historical partial report remains immutable');
  } finally { releaseRetry.resolve(); await f.dispose(); }
});

test('revocation after final delivery and before publication blocks a report and prevents completed commission', async t => {
  const f = await realCouncilFixture(t);
  try {
    const historical = new Date(fixtureAsOf);
    const [source] = await f.db.insert(dataLibrarySources).values({ owner: f.owner, kind: 'text', title: 'Fictional private source',
      format: 'text', createdAt: historical, updatedAt: historical }).returning();
    const [version] = await f.db.insert(dataLibraryVersions).values({ owner: f.owner, sourceId: source.id, version: 1,
      contentHash: 'fixture-source-hash', rawContent: 'Fictional historical body', extractedText: 'Fictional historical body',
      sections: [], byteLength: 25, observedAt: historical, extractionState: 'ready' }).returning();
    const sourceRef: ResearchSourceRef = { kind: 'document_version', id: version.id, revision: '1', availability: 'available' };
    const created = await f.create({ inputRefs: [sourceRef] });
    const publish = f.internals.workflow.callbacks.publish;
    let revoked = false;
    f.internals.workflow.callbacks.publish = async (...args) => {
      const grants = await f.sources.list(f.owner, created.teamId);
      const grant = grants.items.find(item => item.sourceRef.id === version.id);
      assert.ok(grant);
      const team = await f.service.detail(f.owner, created.teamId);
      await f.sources.revoke(f.owner, created.teamId, grant.id, { requestKey: randomUUID(), expectedScopeRevision: team.scopeRevision,
        reason: 'Revoked at final publication seam' });
      revoked = true;
      return publish(...args);
    };
    const detail = await f.drain(created);
    assert.equal(revoked, true);
    assert.equal(findTask(detail, 'summary').state, 'accepted', 'The race occurs after completed delivery');
    assert.equal(detail.state, 'blocked');
    assert.equal(detail.completedAt, null);
    assert.equal(detail.links.filter(link => link.kind === 'report_version').length, 0);
    const session = await f.council.getSession(f.owner, detail.sessionId!);
    assert.equal(session.reports.length, 0);
  } finally { await f.dispose(); }
});

test('produced report link names accepted work/attempt and can be adopted as strategy authority without model extraction', async t => {
  const f = await realCouncilFixture(t);
  try {
    const created = await f.create();
    const detail = await f.drain(created);
    const summary = findTask(detail, 'summary');
    const report = detail.links.find(link => link.kind === 'report_version' && link.relation === 'produced'
      && link.workKey === summary.workKey && link.attemptId === summary.acceptedAttemptId);
    assert.ok(report, 'The UI can select the exact accepted report basis');
    const basis = { teamVersionId: detail.teamVersionId, bindingId: detail.bindingId, bindingRevision: detail.bindingRevision,
      commissionId: detail.id, sessionId: detail.sessionId!, cycleId: detail.cycleId!, workKey: summary.workKey!,
      acceptedAttemptId: summary.acceptedAttemptId!, reportVersionId: report.targetId, thesisVersions: [],
      sourceRefs: summary.assignment!.inputRefs };
    const adopted = await f.decisions.create(f.owner, created.teamId, { requestKey: randomUUID(), expectedProposalRevision: 0,
      commissionId: detail.id, event: 'adopt', basis, reason: 'User adopts this fictional accepted report' });
    const draft = await f.strategies.importSource(f.owner, { kind: 'report', versionId: report.targetId });
    assert.equal(draft.sources[0].versionId, report.targetId);
    const reviewed = await f.strategies.preview(f.owner, draft.id, draft.revision);
    assert.equal(reviewed.preview?.canConfirm, true);
    const snapshot = await f.db.transaction(tx => f.strategies.accountSnapshot(tx, f.owner, draft.id, draft.revision));
    await teamStrategyAuthority(f.db, f.owner, created.account.id, [{ strategyId: draft.id, strategyRevision: draft.revision,
      allocationPct: 100, enabled: true, snapshot }],
      [{ proposalId: adopted.proposalId, proposalRevision: adopted.proposalRevision, decisionId: adopted.id }]);
    assert.equal(adopted.basis.reportVersionId, report.targetId);
    assert.equal(f.calls.length, 1, 'Adoption/application authority reuses the saved report');
  } finally { await f.dispose(); }
});

test('provider completion without usage remains estimated and unknown instead of confirmed zero cost', async t => {
  const f = await realCouncilFixture(t, () => ({ usage: 'missing' }));
  try {
    const created = await f.create();
    const detail = await f.drain(created);
    assert.equal(detail.state, 'completed', 'Usage uncertainty does not erase a valid delivered result');
    const attempts = detail.tasks!.flatMap(task => task.attempts);
    assert.ok(attempts.every(attempt => attempt.externalUsageUnknown));
    assert.equal(detail.cost.externalUsageUnknown, true);
    assert.deepEqual(detail.cost.unknownAttemptIds.sort(), attempts.map(attempt => attempt.id).sort());
    assert.equal(Number(detail.cost.confirmed.amount), 0);
    assert.ok(Number(detail.cost.reserved.amount) > 0);
    const usage = await f.db.select().from(llmBudgetUsage);
    assert.equal(usage.length, 1);
    assert.equal(usage[0].status, 'estimated');
    assert.ok(usage[0].chargedTokens > 0);
    await f.detail(created);
    await f.council.getSession(f.owner, detail.sessionId!);
    await f.worker.runOnce();
    assert.equal(f.calls.length, 1);
  } finally { await f.dispose(); }
});
