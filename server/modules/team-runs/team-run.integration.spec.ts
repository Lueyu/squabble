import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { makeTeamFixture } from '../teams/team-test.fixture';
import { AgentRosterService } from '../agent-roster/agent-roster.service';
import { TeamRunService } from './team-run.service';
import { TeamRunScheduler } from './team-run.scheduler';
import { TeamRunDelivery } from './team-run.delivery';
import { TradingMarketService } from '../paper-trading/trading-market.service';
import { ResearchDocumentsService } from '../research-documents/research-documents.service';
import { UserInvestmentStrategyService } from '../paper-trading/user-investment-strategy.service';
import { InvestmentPolicyService } from '../paper-trading/investment-policy.service';
import { PortfolioWorkspaceService } from '../paper-trading/portfolio-workspace.service';
import { SimulationExperimentsService } from '../paper-trading/simulation-experiments.service';
import { TeamCommissionWorker } from '../teams/team-commission.worker';
import { teamCommissions, teamDecisions } from '../../database/teams.schema';
import { teamRunAgreements, teamRunCycles } from '../../database/team-run.schema';
import { councilResearchTasks } from '../../database/research-workflow.schema';
import { councilReports, councilSessions } from '../../database/council.schema';
import { paperAccounts, paperOrders } from '../../database/schema';
import { investmentPolicies } from '../../database/investment-policy.schema';
import { portfolioCombinationDrafts, portfolioStrategyAssignments } from '../../database/portfolio-workspace.schema';
import { strategyMandates } from '../../database/strategy-mandates.schema';
import { assertTeamRunAuthority } from '../../database/team-run-authority';
import { assertTeamExecutionInTransaction, lockTeamOwner } from '../../database/team-context';
import type { TeamRunAgreementInput } from '../../../shared/team-run.interface';
import { CouncilService } from '../council/council.service';
import { TeamRuntimeAdapter } from '../teams/team-runtime-adapter';
import { TeamCommissionService, commissionContext } from '../teams/team-commission.service';
import { assertTeamRunCommissionAuthority } from '../../database/team-run-authority';

const options = { skip: !process.env.TEAM_TEST_DATABASE_URL };
async function setup() {
  const f = await makeTeamFixture(), team = await f.team(), roster = new AgentRosterService(f.db);
  const friend = await roster.create(f.owner, { requestKey: randomUUID(), name: 'Fictional analyst', instructions: 'Frozen base instructions',
    executor: { executionMode: 'model', connectionId: f.connection.id, model: 'slow' }, allowedToolIds: [], allowedSources: [] });
  const config = structuredClone(team.version.config);
  config.roles[0].agentId = friend.id; config.roles[0].agentVersionId = friend.currentVersionId;
  const saved = await f.service.save(f.owner, team.team.id, 'draft', { requestKey: randomUUID(), expectedSemanticRevision: team.team.semanticRevision, config });
  const pp = await f.versions.publishPreview(f.owner, team.team.id, { requestKey: randomUUID(), expectedSemanticRevision: saved.semanticRevision });
  const published = await f.versions.publish(f.owner, team.team.id, { requestKey: randomUUID(), previewId: pp.previewId, previewHash: pp.previewHash });
  const account = await f.account();
  const bp = await f.versions.bindingPreview(f.owner, team.team.id, { requestKey: randomUUID(), action: 'assign', accountId: account.id,
    teamVersionId: published.version.id, expectedBindingRevision: 0, expectedAccountBindingId: null, executionChoice: 'keep_confirmed_rules', acknowledgePendingReapproval: true });
  const binding = await f.versions.binding(f.owner, team.team.id, { requestKey: randomUUID(), previewId: bp.previewId, previewHash: bp.previewHash });
  const documents = new ResearchDocumentsService(f.db);
  const strategies = new UserInvestmentStrategyService(f.db, documents, { json: async () => { throw new Error('No provider call authorized in fictional fixture'); } } as never);
  const policies = new InvestmentPolicyService(f.db, new SimulationExperimentsService(f.db, {} as never, {} as never), strategies);
  const workspace = new PortfolioWorkspaceService(f.db, policies, strategies);
  const runs = new TeamRunService(f.store, f.commissions), delivery = new TeamRunDelivery(runs, f.decisions, strategies, workspace);
  const scheduler = new TeamRunScheduler(runs, new TradingMarketService({} as never), f.commissions, delivery);
  const input: TeamRunAgreementInput = { requestKey: randomUUID(), teamVersionId: published.version.id, bindingId: binding.binding!.id,
    expectedBindingRevision: binding.team.bindingRevision, objective: 'Fictional portfolio review', market: 'CN', budget: {
      perRun: { budgetMode: 'cost_and_calls', ceiling: { amount: '1', currency: 'USD' }, callLimit: 2, paidRevisionLimit: 0 },
      daily: { costUsd: '1', calls: 2 }, monthly: { costUsd: '2', calls: 4 } }, replacementPolicy: { kind: 'replace_combination', allocationPct: 50 }, inputRefs: [] };
  const preview = await runs.preview(f.owner, team.team.id, input);
  const agreement = await runs.confirm(f.owner, team.team.id, { requestKey: randomUUID(), previewId: preview.previewId, previewHash: preview.previewHash });
  const running = await runs.control(f.owner, team.team.id, 'start', { requestKey: randomUUID(), expectedRevision: agreement.revision });
  return { ...f, teamId: team.team.id, friend, roster, workspace, documents, strategies, runs, delivery, scheduler, running, account, initialPreview: preview,
    worker: new TeamCommissionWorker(f.store, f.runtime, f.commissions), input };
}
async function acceptedReport(f: Awaited<ReturnType<typeof setup>>, noTrade = false) {
  await f.scheduler.runOnce(new Date('2026-11-12T09:00:00Z'));
  await f.worker.runOnce();
  const [cycle] = await f.db.select().from(teamRunCycles).where(eq(teamRunCycles.agreementId, f.running.id));
  assert.ok(cycle.commissionId, JSON.stringify(cycle));
  const [commission] = await f.db.select().from(teamCommissions).where(eq(teamCommissions.id, cycle.commissionId));
  const attemptId = randomUUID();
  const [task] = await f.db.insert(councilResearchTasks).values({ owner: f.owner, sessionId: commission.sessionId!, cycleId: commission.cycleId!, revision: 1,
    key: 'summary', position: 0, memberId: commission.members[0].memberId, dependencies: [], state: 'accepted', skills: [], workKey: commission.plan.work[0].workKey,
    acceptedAttemptId: attemptId, attempts: [{ id: attemptId, revision: 1, kind: 'work', startedAt: new Date().toISOString(), state: 'succeeded', dispatched: true, messageId: randomUUID() }] }).returning();
  const coverage = { goal: 'comprehensive' as const, cycleId: commission.cycleId!, revision: 1, complete: true,
    tasks: [{ id: task.id, key: 'summary' as const, state: 'accepted' as const, acceptedAttemptId: attemptId }] };
  const [report] = await f.db.insert(councilReports).values({ owner: f.owner, sessionId: commission.sessionId!, revision: 1, version: 1,
    decision: 'wait', summary: 'Fictional research only', dissent: [], nextReviewCondition: 'Next review', publicationOutcome: 'succeeded', engine: 'llm', evidence: [], coverage }).returning();
  const text = 'AI proposal: AAPL at 100 buy 10 shares';
  const executionPlan = { schemaVersion: 1, parameterOrigin: noTrade ? 'system_observation' : 'ai_proposed', evidenceIds: noTrade ? [] : ['fixture-e1'], gaps: [], ...(noTrade ? { noTradeReason: 'Fictional observation only' } : {}),
    strategy: { title: 'Fictional plan', body: text, timezone: 'Asia/Shanghai', startsAt: new Date(Date.now() - 60000).toISOString(), endsAt: new Date(Date.now() + 86400000).toISOString(),
      ...(!noTrade ? { limits: { maxPositionPct: 10, maxOrderPct: 5, maxDailyIncreasePct: 5, maxDailyTurnoverPct: 20, minCashPct: 10, maxGrossExposurePct: 90 } } : {}),
      entries: [{ id: 'fictional', text, ticker: 'AAPL', sourceKeys: [], ...(!noTrade ? { directive: { ticker: 'AAPL', side: 'buy', trigger: { kind: 'price_lte', price: 100 }, quantity: 10,
        reviewedText: text, numericEvidence: [{ field: 'trigger.price', value: 100, quote: '100' }, { field: 'quantity', value: 10, quote: '10' }] } } : {}) }] } };
  const version = await f.documents.submit(f.owner, { idempotencyKey: randomUUID(), title: 'Fictional accepted report', kind: 'council', source: { type: 'council', id: report.id },
    content: 'Fictional readable report', sections: [{ id: 'execution-strategy', title: 'Execution proposal', content: text }],
    availableAt: new Date(Date.now() - 1000).toISOString(), snapshot: { executionPlan: executionPlan as never, evidence: [{ id: 'fixture-e1', content: 'Fictional bound proposal evidence' }] } });
  await f.db.update(councilReports).set({ researchVersionId: version.id }).where(eq(councilReports.id, report.id));
  await f.db.update(councilSessions).set({ status: 'completed' }).where(eq(councilSessions.id, commission.sessionId!));
  await f.worker.project(commission.id);
  return { cycle, commission, version, attemptId };
}

test('durable exact report automatically installs the actual paper bot with system attribution and preserves user draft', options, async () => {
  const f = await setup();
  try {
    assert.deepEqual(await f.runs.preview(f.owner, f.teamId, f.input), f.initialPreview, 'Agreement preview replay restores its saved authorization without regeneration');
    assert.ok((await f.client`SELECT to_regclass('team_run_agreement_revisions') AS relation`)[0].relation, 'Standing authority keeps immutable historical revisions');
    const history = await f.client`SELECT revision,state,member_snapshots FROM team_run_agreement_revisions ORDER BY revision`;
    assert.deepEqual(history.map(row => [row.revision, row.state]), [[1, 'confirmed'], [2, 'running']]);
    assert.equal(history[0].member_snapshots[0].agentInstructions, 'Frozen base instructions');
    await assert.rejects(f.client`UPDATE team_run_agreement_revisions SET state='paused' WHERE agreement_id=${f.running.id}`, /TEAM_IMMUTABLE_HISTORY/);
    await f.db.insert(portfolioCombinationDrafts).values({ owner: f.owner, accountId: f.account.id, expectedPolicyRevision: 1, allocations: [] });
    const result = await acceptedReport(f);
    await f.scheduler.runOnce(new Date('2026-11-12T09:00:00Z'));
    const [cycle] = await f.db.select().from(teamRunCycles);
    assert.equal(cycle.state, 'applied', cycle.lastError ?? '');
    const [account] = await f.db.select().from(paperAccounts).where(eq(paperAccounts.id, f.account.id));
    assert.equal(account.botEnabled, true);
    const [assignment] = await f.db.select().from(portfolioStrategyAssignments);
    assert.equal(assignment.snapshot.status, 'confirmed');
    assert.equal(assignment.snapshot.sources[0].versionId, result.version.id);
    assert.ok((await f.db.select().from(strategyMandates)).some(mandate => mandate.status === 'published'));
    const decisions = await f.db.select().from(teamDecisions);
    assert.ok(decisions.some(decision => decision.event === 'adopt' && decision.actorType === 'system' && decision.actorId === 'team-run:' + f.running.id));
    assert.ok(decisions.some(decision => decision.event === 'applied' && decision.policyContext?.teamRunAgreementId === f.running.id));
    assert.equal((await f.db.select().from(portfolioCombinationDrafts)).length, 1);
    const restarted = new TeamRunScheduler(f.runs, new TradingMarketService({} as never), f.commissions, f.delivery);
    await Promise.all([f.scheduler.runOnce(new Date('2026-11-12T10:00:00Z')), restarted.runOnce(new Date('2026-11-12T10:00:00Z'))]);
    assert.equal((await f.db.select().from(teamRunCycles)).length, 1);
    assert.equal((await f.db.select().from(teamCommissions)).length, 1);
  } finally { await f.dispose(); }
});

test('no-trade accepted reports remain observe and never enable the paper bot', options, async () => {
  const f = await setup();
  try {
    await acceptedReport(f, true); await f.scheduler.runOnce(new Date('2026-11-12T09:00:00Z'));
    assert.equal((await f.db.select().from(teamRunCycles))[0].state, 'observed');
    assert.equal((await f.db.select().from(teamDecisions))[0].event, 'observe');
    assert.equal((await f.db.select().from(portfolioStrategyAssignments)).length, 0);
    assert.equal((await f.db.select().from(paperAccounts).where(eq(paperAccounts.id, f.account.id)))[0].botEnabled, false);
  } finally { await f.dispose(); }
});

test('pause wins immediately before final automatic apply and cancels protective pending orders', options, async () => {
  const f = await setup();
  try {
    await acceptedReport(f);
    await f.db.insert(paperOrders).values({ owner: f.owner, accountId: f.account.id, ticker: 'AAPL', side: 'sell', quantity: '1', status: 'approved', reason: 'Fictional protective order' });
    const originalApply = f.workspace.apply.bind(f.workspace);
    let checked = false;
    f.workspace.apply = async (owner, accountId, input, authority) => {
      checked = true;
      await f.runs.control(f.owner, f.teamId, 'pause', { requestKey: randomUUID(), expectedRevision: f.running.revision });
      return originalApply(owner, accountId, input, authority);
    };
    await f.scheduler.runOnce(new Date('2026-11-12T09:00:00Z'));
    assert.equal(checked, true, JSON.stringify(await f.db.select().from(teamRunCycles)));
    assert.equal((await f.db.select().from(teamRunAgreements))[0].state, 'paused');
    assert.equal((await f.db.select().from(paperAccounts).where(eq(paperAccounts.id, f.account.id)))[0].botEnabled, false);
    assert.equal((await f.db.select().from(portfolioStrategyAssignments)).length, 0);
    assert.equal((await f.db.select().from(paperOrders))[0].status, 'cancelled');
    assert.equal((await f.db.select().from(teamDecisions)).filter(decision => decision.event === 'applied').length, 0);
  } finally { await f.dispose(); }
});

test('unknown commission survives restart without overlapping work or releasing reservations', options, async () => {
  const f = await setup();
  try {
    await f.scheduler.runOnce(new Date('2026-11-12T09:00:00Z'));
    const [cycle] = await f.db.select().from(teamRunCycles);
    assert.ok(cycle.commissionId, JSON.stringify(cycle));
    await f.db.update(teamCommissions).set({ state: 'uncertain' }).where(eq(teamCommissions.id, cycle.commissionId!));
    await f.scheduler.runOnce(new Date('2026-11-13T09:00:00Z'));
    assert.equal((await f.db.select().from(teamRunCycles)).length, 1);
    assert.equal((await f.db.select().from(teamRunCycles))[0].reservedCostUsd, '1.00000000');
    await f.runs.control(f.owner, f.teamId, 'pause', { requestKey: randomUUID(), expectedRevision: f.running.revision });
    await f.worker.runOnce();
    await assert.rejects(f.db.transaction(async tx => { await lockTeamOwner(tx, f.owner); return assertTeamRunAuthority(tx, f.owner,
      { agreementId: f.running.id, revision: f.running.revision, cycleId: cycle.id }); }), /TEAM_SCOPE_REVOKED/);
    const [policy] = await f.db.select().from(investmentPolicies).where(eq(investmentPolicies.accountId, f.account.id));
    assert.equal(policy.status, 'paused');
  } finally { await f.dispose(); }
});

test('monthly reservations persist across dates and concurrent schedulers cannot open duplicate or overlapping cycles', options, async () => {
  const f = await setup();
  try {
    const [agreement] = await f.db.select().from(teamRunAgreements);
    await Promise.all([f.scheduler.reserve(agreement, new Date('2026-11-12T09:00:00Z')), f.scheduler.reserve(agreement, new Date('2026-11-12T09:00:00Z'))]);
    assert.equal((await f.db.select().from(teamRunCycles)).length, 1);
    await f.scheduler.reserve(agreement, new Date('2026-11-13T09:00:00Z'));
    assert.equal((await f.db.select().from(teamRunCycles)).length, 1, 'A preceding unfinished cycle blocks tomorrow');
    await f.db.update(teamRunCycles).set({ state: 'observed' }).where(eq(teamRunCycles.agreementId, agreement.id));
    await f.scheduler.reserve(agreement, new Date('2026-11-13T09:00:00Z'));
    assert.equal((await f.db.select().from(teamRunCycles)).length, 2);
    await f.db.update(teamRunCycles).set({ state: 'observed' }).where(eq(teamRunCycles.agreementId, agreement.id));
    await f.scheduler.reserve(agreement, new Date('2026-11-16T09:00:00Z'));
    const cycles = await f.db.select().from(teamRunCycles);
    assert.equal(cycles.length, 2, 'Known and unknown maxima remain charged against the finite monthly authorization');
    assert.equal(cycles.reduce((sum, row) => sum + row.reservedCalls, 0), 4);
    assert.equal(cycles.reduce((sum, row) => sum + Number(row.reservedCostUsd), 0), 2);
  } finally { await f.dispose(); }
});

test('publishing a different team version suspends standing authority and stops the original account', options, async () => {
  const f = await setup();
  try {
    await f.db.update(paperAccounts).set({ botEnabled: true }).where(eq(paperAccounts.id, f.account.id));
    const detail = await f.service.detail(f.owner, f.teamId), config = structuredClone(detail.draft.config);
    config.roles[0].responsibility = 'Changed frozen role';
    const saved = await f.service.save(f.owner, f.teamId, 'draft', { requestKey: randomUUID(), expectedSemanticRevision: detail.semanticRevision, config });
    const preview = await f.versions.publishPreview(f.owner, f.teamId, { requestKey: randomUUID(), expectedSemanticRevision: saved.semanticRevision });
    await f.versions.publish(f.owner, f.teamId, { requestKey: randomUUID(), previewId: preview.previewId, previewHash: preview.previewHash });
    await f.scheduler.runOnce(new Date('2026-11-12T09:00:00Z'));
    const [agreement] = await f.db.select().from(teamRunAgreements);
    assert.equal(agreement.state, 'suspended');
    assert.equal((await f.db.select().from(paperAccounts).where(eq(paperAccounts.id, f.account.id)))[0].botEnabled, false);
    assert.equal((await f.db.select().from(teamRunCycles)).length, 0);
    await assert.rejects(f.runs.control(f.owner, f.teamId, 'resume', { requestKey: randomUUID(), expectedRevision: agreement.revision }));
    await assert.rejects(f.runs.status(f.stranger, f.teamId));
  } finally { await f.dispose(); }
});

test('automatic-team archive stops new authority while its already dispatched Council artifact settles into history', options, async t => {
  const f = await setup();
  let release!: () => void, started!: () => void;
  const providerWait = new Promise<void>(resolve => { release = resolve; });
  const dispatched = new Promise<void>(resolve => { started = resolve; });
  let calls = 0;
  const council = new CouncilService(f.db, { getInputLimit: async () => 32000, chatSlowJSON: async (prompt, _owner, callOptions) => {
    await callOptions.onDispatch(); calls++; started(); await providerWait;
    const input = JSON.parse(prompt[1].content);
    return { tokens: 5, tokensKnown: true, data: { conclusion: 'Original automatic-team dispatched artifact', evidenceIds: input.evidence.map(item => item.id),
      asOf: '2020-01-01T00:00:00.000Z', currency: 'USD', units: 'USD', assumptions: [], gaps: [], skillVersions: input.skills,
      response: { thesis: 'Original automatic-team dispatched artifact', evidencePoints: [], risks: [], nextChecks: [] } } };
  } } as never, undefined, undefined, undefined, undefined, undefined, undefined, undefined, f.documents);
  const runtime = new TeamRuntimeAdapter(council), commissions = new TeamCommissionService(f.store, runtime);
  const runs = new TeamRunService(f.store, commissions), worker = new TeamCommissionWorker(f.store, runtime, commissions);
  const scheduler = new TeamRunScheduler(runs, new TradingMarketService({} as never), commissions, new TeamRunDelivery(runs, f.decisions, f.strategies, f.workspace));
  try {
    const [clock] = await f.client<{ milliseconds: string }[]>`SELECT (extract(epoch FROM clock_timestamp()) * 1000)::text AS milliseconds`;
    t.mock.timers.enable({ apis: ['Date'], now: Math.ceil(Number(clock.milliseconds)) + 3600000 });
    await scheduler.runOnce(new Date('2026-11-12T09:00:00Z')); await worker.runOnce(); await worker.runOnce();
    await Promise.race([dispatched, Promise.all([...((council as unknown as { jobs: Map<string, Promise<void>> }).jobs.values())]).then(async () => {
      throw new Error('Provider was not dispatched: ' + JSON.stringify(await f.db.select().from(councilSessions)));
    })]);
    const [cycle] = await f.db.select().from(teamRunCycles).where(eq(teamRunCycles.agreementId, f.running.id));
    const [commission] = await f.db.select().from(teamCommissions).where(eq(teamCommissions.id, cycle.commissionId!));
    assert.equal((await f.db.select().from(councilResearchTasks).where(eq(councilResearchTasks.sessionId, commission.sessionId!)))[0].attempts[0].dispatched, true);
    await f.roster.archive(f.owner, f.friend.id, { requestKey: randomUUID(), expectedRevision: f.friend.revision });
    await scheduler.runOnce(new Date('2026-11-12T09:00:00Z'));
    assert.equal((await f.db.select().from(councilSessions).where(eq(councilSessions.id, commission.sessionId!)))[0].status, 'running', 'archive is not an explicit pause of an existing paid receipt');
    assert.equal((await f.db.select().from(teamCommissions).where(eq(teamCommissions.id, commission.id)))[0].cancelRequestedAt, null);
    release();
    await Promise.all([...((council as unknown as { jobs: Map<string, Promise<void>> }).jobs.values())]);
    await f.db.transaction(tx => assertTeamExecutionInTransaction(tx, f.owner, commissionContext(commission), { publication: true }));
    await worker.project(commission.id);
    const [task] = await f.db.select().from(councilResearchTasks).where(eq(councilResearchTasks.sessionId, commission.sessionId!));
    const [report] = await f.db.select().from(councilReports).where(eq(councilReports.sessionId, commission.sessionId!));
    assert.equal(task.state, 'accepted', JSON.stringify(task.attempts));
    assert.equal(report?.publicationOutcome, 'succeeded');
    assert.match(report.summary, /Original automatic-team dispatched artifact/u);
    assert.equal((await f.db.select().from(teamCommissions).where(eq(teamCommissions.id, commission.id)))[0].state, 'completed');
    await assert.rejects(f.db.transaction(tx => assertTeamRunCommissionAuthority(tx, f.owner, commission.id, true)), /TEAM_SCOPE_REVOKED|AGENT_ARCHIVED/u);
    await assert.rejects(f.db.transaction(tx => assertTeamRunAuthority(tx, f.owner, { agreementId: f.running.id, revision: f.running.revision, cycleId: cycle.id })), /TEAM_SCOPE_REVOKED/u);
    await scheduler.runOnce(new Date('2026-11-13T09:00:00Z'));
    const [settledCycle] = await f.db.select().from(teamRunCycles).where(eq(teamRunCycles.id, cycle.id));
    assert.equal(settledCycle.state, 'observed', settledCycle.lastError ?? '');
    assert.equal(settledCycle.reportVersionId, report.researchVersionId);
    assert.equal(calls, 1);
    assert.equal((await f.db.select().from(teamRunCycles)).length, 1);
    assert.equal((await f.db.select().from(teamCommissions)).length, 1);
    assert.equal((await f.db.select().from(portfolioStrategyAssignments)).length, 0);
    assert.equal((await f.db.select().from(teamDecisions)).filter(decision => ['adopt', 'applied'].includes(decision.event)).length, 0);
    assert.equal((await f.db.select().from(paperAccounts).where(eq(paperAccounts.id, f.account.id)))[0].botEnabled, false);
  } finally { release(); await Promise.allSettled([...((council as unknown as { jobs: Map<string, Promise<void>> }).jobs.values())]); await f.dispose(); }
});
