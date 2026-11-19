import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { TeamRunService } from './team-run.service';
import { TeamRunScheduler } from './team-run.scheduler';
import { TeamRunDelivery } from './team-run.delivery';
import { TradingMarketService } from '../paper-trading/trading-market.service';
import { TeamCommissionWorker } from '../teams/team-commission.worker';
import { copyTeamExecutionLinks, recordTeamSignalLinks } from '../../database/team-execution-links';
import { researchDocumentVersions } from '../../database/research-documents.schema';
import { DEFAULT_INVESTMENT_CONFIG } from '../paper-trading/investment-policy.rules';
import { teamCommissions, teamDecisions, teamResearchLinks } from '../../database/teams.schema';
import { teamRunAgreements, teamRunCycles } from '../../database/team-run.schema';
import { councilResearchTasks } from '../../database/research-workflow.schema';
import { councilReports, councilSessions } from '../../database/council.schema';
import { paperAccounts, paperOrders, paperTrades } from '../../database/schema';
import { investmentPolicies } from '../../database/investment-policy.schema';
import { portfolioCombinationDrafts, portfolioStrategyAssignments } from '../../database/portfolio-workspace.schema';
import { strategyMandates } from '../../database/strategy-mandates.schema';
import { assertTeamRunAuthority } from '../../database/team-run-authority';
import { assertTeamExecutionInTransaction, lockTeamOwner } from '../../database/team-context';
import { CouncilService } from '../council/council.service';
import { TeamRuntimeAdapter } from '../teams/team-runtime-adapter';
import { TeamCommissionService, commissionContext } from '../teams/team-commission.service';
import { assertTeamRunCommissionAuthority } from '../../database/team-run-authority';
import { setup, acceptedReport, deliverReport } from './team-run-test.fixture';

const options = { skip: !process.env.TEAM_TEST_DATABASE_URL };

test('explicit immediate startup reserves once before close and preserves the frozen agreement choice', options, async () => {
  const f = await setup('immediate');
  try {
    assert.deepEqual(f.initialPreview.result.configuration, f.running.configuration);
    assert.equal(f.running.configuration.initialRun, 'immediate');
    const restarted = new TeamRunScheduler(f.runs, new TradingMarketService({} as never), f.commissions, f.delivery);
    await Promise.all([
      f.scheduler.runOnce(new Date('2026-11-12T03:00:00Z')),
      restarted.runOnce(new Date('2026-11-12T03:00:00Z')),
    ]);
    const cycles = await f.db.select().from(teamRunCycles);
    assert.equal(cycles.length, 1);
    assert.equal(cycles[0].tradingDate, '2026-11-12');
    assert.equal((await f.db.select().from(teamCommissions)).length, 1);
    await f.db.update(teamRunCycles).set({ state: 'observed' }).where(eq(teamRunCycles.id, cycles[0].id));
    const [agreement] = await f.db.select().from(teamRunAgreements);
    await restarted.reserve(agreement, new Date('2026-11-12T09:00:00Z'));
    await restarted.reserve(agreement, new Date('2026-11-13T03:00:00Z'));
    assert.equal((await f.db.select().from(teamRunCycles)).length, 1, 'The initial reservation consumes its daily slot, and later days wait for close');
    await restarted.reserve(agreement, new Date('2026-11-13T09:00:00Z'));
    assert.equal((await f.db.select().from(teamRunCycles)).length, 2);
  } finally { await f.dispose(); }
});

test('a running agreement retains its exact legacy friend after the directory folds it into the built-in roster', options, async () => {
  const f = await setup('immediate', 'CN', undefined, 'recommended');
  try {
    const [before] = await f.db.select().from(teamRunAgreements);
    assert.equal(before.state, 'running');
    assert.equal(before.members[0].rosterAgentId, f.friend.id);
    assert.equal(before.members[0].rosterAgentVersionId, f.friend.currentVersionId);

    const roster = await f.roster.list(f.owner);
    assert.equal(roster.items.length, 12);
    assert.ok(roster.items.every(friend => friend.id !== f.friend.id && friend.origin === 'builtin'));
    await f.runs.reconcileAuthority(before);
    await f.scheduler.runOnce(new Date('2026-11-12T03:00:00Z'));

    const [after] = await f.db.select().from(teamRunAgreements);
    assert.deepEqual(after, before);
    const [commission] = await f.db.select().from(teamCommissions);
    assert.equal(commission.members[0].rosterAgentId, f.friend.id);
    assert.equal(commission.members[0].rosterAgentVersionId, f.friend.currentVersionId);
  } finally { await f.dispose(); }
});

test('unknown native fees preserve automatic next-dispatch authority while an uncertain result blocks it', options, async () => {
  const f = await setup('immediate');
  try {
    const now = new Date('2026-11-12T03:00:00Z');
    await f.scheduler.runOnce(now);
    await f.worker.runOnce();
    await f.worker.runOnce();
    const [cycle] = await f.db.select().from(teamRunCycles).where(eq(teamRunCycles.agreementId, f.running.id));
    const [commission] = await f.db.select().from(teamCommissions).where(eq(teamCommissions.id, cycle.commissionId!));
    const attempt = { id: randomUUID(), revision: 1, kind: 'work' as const, startedAt: new Date().toISOString(),
      state: 'running' as const, dispatched: true, messageId: randomUUID(), remoteTaskId: randomUUID(), externalUsageUnknown: true };
    const [task] = await f.db.insert(councilResearchTasks).values({ owner: f.owner, sessionId: commission.sessionId!,
      cycleId: commission.cycleId!, revision: 1, key: 'summary', position: 0, memberId: commission.members[0].memberId,
      dependencies: [], state: 'running', skills: [], workKey: commission.plan.work[0].workKey, attempts: [attempt] }).returning();

    await f.worker.project(commission.id);
    await f.scheduler.advance(cycle);
    assert.equal((await f.db.select().from(teamCommissions).where(eq(teamCommissions.id, commission.id)))[0].state, 'running');
    assert.equal((await f.db.select().from(teamRunCycles).where(eq(teamRunCycles.id, cycle.id)))[0].state, 'researching');
    await f.db.transaction(tx => assertTeamRunCommissionAuthority(tx, f.owner, commission.id, true));
    const detail = await f.commissions.detail(f.owner, f.teamId, commission.id);
    assert.equal(detail.cost.externalUsageUnknown, true, 'Execution progress does not invent confirmed external charges');
    assert.ok(detail.cost.unknownAttemptIds.includes(attempt.id));

    await f.db.update(councilResearchTasks).set({ state: 'uncertain', attempts: [{ ...attempt, state: 'uncertain' }] })
      .where(eq(councilResearchTasks.id, task.id));
    await f.worker.project(commission.id);
    await f.scheduler.advance(cycle);
    assert.equal((await f.db.select().from(teamCommissions).where(eq(teamCommissions.id, commission.id)))[0].state, 'uncertain');
    assert.equal((await f.db.select().from(teamRunCycles).where(eq(teamRunCycles.id, cycle.id)))[0].state, 'uncertain');
    await assert.rejects(f.db.transaction(tx => assertTeamRunCommissionAuthority(tx, f.owner, commission.id, true)), /TEAM_SCOPE_REVOKED/u);
    assert.equal(f.counters.starts, 1, 'Projection never resends an existing provider command');
  } finally { await f.dispose(); }
});

test('legacy omission and explicit scheduled startup both wait for the after-close window', options, async () => {
  for (const mode of [undefined, 'scheduled'] as const) {
    const f = await setup(mode);
    try {
      await f.scheduler.runOnce(new Date('2026-11-12T03:00:00Z'));
      assert.equal((await f.db.select().from(teamRunCycles)).length, 0);
      await f.scheduler.runOnce(new Date('2026-11-12T09:00:00Z'));
      assert.equal((await f.db.select().from(teamRunCycles)).length, 1);
    } finally { await f.dispose(); }
  }
});

test('pause and resume do not grant a second immediate run even after the original reservation was cancelled', options, async () => {
  const f = await setup('immediate');
  try {
    const [original] = await f.db.select().from(teamRunAgreements);
    await f.scheduler.reserve(original, new Date('2026-11-12T03:00:00Z'));
    const paused = await f.runs.control(f.owner, f.teamId, 'pause', { requestKey: randomUUID(), expectedRevision: original.revision });
    await f.runs.control(f.owner, f.teamId, 'resume', { requestKey: randomUUID(), expectedRevision: paused.revision });
    await f.scheduler.runOnce(new Date('2026-11-13T03:00:00Z'));
    const cycles = await f.db.select().from(teamRunCycles);
    assert.equal(cycles.length, 1);
    assert.equal(cycles[0].state, 'cancelled');
    await f.scheduler.runOnce(new Date('2026-11-13T09:00:00Z'));
    assert.equal((await f.db.select().from(teamRunCycles)).length, 2);
  } finally { await f.dispose(); }
});

test('a newly confirmed authority may run initially without confusing earlier control revisions', options, async () => {
  const f = await setup('immediate');
  try {
    const [original] = await f.db.select().from(teamRunAgreements);
    await f.scheduler.reserve(original, new Date('2026-11-12T03:00:00Z'));
    await f.db.update(teamRunCycles).set({ state: 'observed' }).where(eq(teamRunCycles.agreementId, original.id));
    const preview = await f.runs.preview(f.owner, f.teamId, { ...f.input, requestKey: randomUUID() });
    const confirmed = await f.runs.confirm(f.owner, f.teamId, { requestKey: randomUUID(), previewId: preview.previewId, previewHash: preview.previewHash });
    const running = await f.runs.control(f.owner, f.teamId, 'start', { requestKey: randomUUID(), expectedRevision: confirmed.revision });
    await f.scheduler.runOnce(new Date('2026-11-13T03:00:00Z'));
    const cycles = await f.db.select().from(teamRunCycles);
    assert.equal(cycles.length, 2);
    assert.ok(cycles.some(cycle => cycle.agreementRevision === running.revision));
  } finally { await f.dispose(); }
});

test('immediate research uses verified holiday dates but never an unknown calendar', options, async () => {
  const f = await setup('immediate', 'US');
  try {
    const [agreement] = await f.db.select().from(teamRunAgreements);
    await f.scheduler.reserve(agreement, new Date('2027-01-04T15:00:00Z'));
    assert.equal((await f.db.select().from(teamRunCycles)).length, 0);
    await f.scheduler.reserve(agreement, new Date('2026-11-14T15:00:00Z'));
    const [cycle] = await f.db.select().from(teamRunCycles);
    assert.equal(cycle?.tradingDate, '2026-11-14', 'A holiday research reservation does not open the paper market');
    assert.equal((await f.db.select().from(paperAccounts).where(eq(paperAccounts.id, f.account.id)))[0].botEnabled, false);
  } finally { await f.dispose(); }
});

test('unknown immediate delivery keeps its durable cycle and never opens another initial reservation', options, async () => {
  const f = await setup('immediate');
  try {
    await f.scheduler.runOnce(new Date('2026-11-12T03:00:00Z'));
    const [cycle] = await f.db.select().from(teamRunCycles);
    assert.ok(cycle?.commissionId);
    await f.db.update(teamCommissions).set({ state: 'uncertain' }).where(eq(teamCommissions.id, cycle.commissionId));
    const restarted = new TeamRunScheduler(f.runs, new TradingMarketService({} as never), f.commissions, f.delivery);
    await restarted.runOnce(new Date('2026-11-13T03:00:00Z'));
    assert.equal((await f.db.select().from(teamRunCycles)).length, 1);
    assert.equal((await f.db.select().from(teamCommissions)).length, 1);
    assert.equal((await f.db.select().from(teamRunCycles))[0].state, 'uncertain');
  } finally { await f.dispose(); }
});

test('new immediate consent cannot bypass earlier conservative monthly reservations', options, async () => {
  const f = await setup('immediate');
  try {
    const [agreement] = await f.db.select().from(teamRunAgreements);
    await f.scheduler.reserve(agreement, new Date('2026-11-12T03:00:00Z'));
    await f.db.update(teamRunCycles).set({ state: 'observed' }).where(eq(teamRunCycles.agreementId, agreement.id));
    await f.scheduler.reserve(agreement, new Date('2026-11-13T09:00:00Z'));
    await f.db.update(teamRunCycles).set({ state: 'observed' }).where(eq(teamRunCycles.agreementId, agreement.id));
    const preview = await f.runs.preview(f.owner, f.teamId, { ...f.input, requestKey: randomUUID() });
    const confirmed = await f.runs.confirm(f.owner, f.teamId, { requestKey: randomUUID(), previewId: preview.previewId, previewHash: preview.previewHash });
    await f.runs.control(f.owner, f.teamId, 'start', { requestKey: randomUUID(), expectedRevision: confirmed.revision });
    await f.scheduler.runOnce(new Date('2026-11-16T03:00:00Z'));
    const cycles = await f.db.select().from(teamRunCycles);
    assert.equal(cycles.length, 2, 'The first cycle of a new consent still fits the same monthly ledger');
    assert.equal(cycles.reduce((sum, cycle) => sum + Number(cycle.reservedCostUsd), 0), 2);
    assert.equal((await f.db.select().from(teamCommissions)).length, 0);
  } finally { await f.dispose(); }
});

test('explicitly uncapped research keeps unknown cost reservations and does not invent external fee uncertainty', options, async () => {
  const f = await setup('immediate', 'CN', {
    perRun: { budgetMode: 'calls_only', ceiling: { amount: null, currency: 'USD' }, callLimit: 2, paidRevisionLimit: 0 },
    daily: { costUsd: null, calls: null }, monthly: { costUsd: null, calls: null },
  });
  try {
    assert.equal(f.running.externalCostUnknown, false, 'No chosen monetary cap is distinct from an opaque external executor');
    assert.ok(!f.initialPreview.warnings.some(warning => warning.code === 'TEAM_EXTERNAL_COST_UNKNOWN'));
    const [agreement] = await f.db.select().from(teamRunAgreements);
    for (const instant of ['2026-11-12T03:00:00Z', '2026-11-13T09:00:00Z', '2026-11-16T09:00:00Z']) {
      await f.scheduler.reserve(agreement, new Date(instant));
      await f.db.update(teamRunCycles).set({ state: 'observed' }).where(eq(teamRunCycles.agreementId, agreement.id));
    }
    const cycles = await f.db.select().from(teamRunCycles);
    assert.equal(cycles.length, 3, 'No implicit daily/monthly cap is invented');
    assert.ok(cycles.every(cycle => cycle.reservedCostUsd === null && cycle.reservedCalls === 2));
    const finite = { ...f.input, requestKey: randomUUID(), budget: {
      perRun: { budgetMode: 'cost_and_calls', ceiling: { amount: '1', currency: 'USD' }, callLimit: 2, paidRevisionLimit: 0 },
      daily: { costUsd: '1', calls: 2 }, monthly: { costUsd: '10', calls: 20 },
    } };
    const preview = await f.runs.preview(f.owner, f.teamId, finite);
    const confirmed = await f.runs.confirm(f.owner, f.teamId, { requestKey: randomUUID(), previewId: preview.previewId, previewHash: preview.previewHash });
    await f.runs.control(f.owner, f.teamId, 'start', { requestKey: randomUUID(), expectedRevision: confirmed.revision });
    await f.scheduler.runOnce(new Date('2026-11-17T03:00:00Z'));
    assert.equal((await f.db.select().from(teamRunCycles)).length, 3, 'Earlier unknown monthly cost is not treated as zero under a newly finite cap');
  } finally { await f.dispose(); }
});

test('durable exact report automatically installs the actual paper bot with system attribution and preserves user draft', options, async () => {
  const f = await setup('immediate');
  try {
    assert.deepEqual(await f.runs.preview(f.owner, f.teamId, f.input), f.initialPreview, 'Agreement preview replay restores its saved authorization without regeneration');
    assert.ok((await f.client`SELECT to_regclass('team_run_agreement_revisions') AS relation`)[0].relation, 'Standing authority keeps immutable historical revisions');
    const history = await f.client`SELECT revision,state,member_snapshots FROM team_run_agreement_revisions ORDER BY revision`;
    assert.deepEqual(history.map(row => [row.revision, row.state]), [[1, 'confirmed'], [2, 'running']]);
    assert.equal(history[0].member_snapshots[0].agentInstructions, 'Frozen base instructions');
    await assert.rejects(f.client`UPDATE team_run_agreement_revisions SET state='paused' WHERE agreement_id=${f.running.id}`, /TEAM_IMMUTABLE_HISTORY/);
    await f.db.insert(portfolioCombinationDrafts).values({ owner: f.owner, accountId: f.account.id, expectedPolicyRevision: 1, allocations: [] });
    const result = await acceptedReport(f, false, new Date('2026-11-12T03:00:00Z'));
    await f.scheduler.runOnce(new Date('2026-11-12T03:00:00Z'));
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

test('team removal wins before final automatic apply without deleting the accepted report', options, async () => {
  const f = await setup();
  try {
    const accepted = await acceptedReport(f);
    const originalApply = f.workspace.apply.bind(f.workspace);
    let archived = false;
    f.workspace.apply = async (owner, accountId, input, authority) => {
      const current = await f.service.detail(f.owner, f.teamId);
      const preview = await f.versions.archivePreview(f.owner, f.teamId, { requestKey: randomUUID(), expectedBindingRevision: current.bindingRevision,
        expectedCurrentVersionId: current.currentVersionId, executionChoice: 'pause_all' });
      await f.versions.archive(f.owner, f.teamId, { requestKey: randomUUID(), previewId: preview.previewId, previewHash: preview.previewHash });
      archived = true;
      return originalApply(owner, accountId, input, authority);
    };
    await f.scheduler.runOnce(new Date('2026-11-12T09:00:00Z'));
    assert.equal(archived, true);
    assert.equal((await f.service.detail(f.owner, f.teamId)).status, 'archived');
    assert.equal((await f.db.select().from(teamRunAgreements))[0].state, 'paused');
    assert.equal((await f.db.select().from(paperAccounts).where(eq(paperAccounts.id, f.account.id)))[0].botEnabled, false);
    assert.equal((await f.db.select().from(portfolioStrategyAssignments)).length, 0);
    assert.equal((await f.db.select().from(teamDecisions)).filter(row => row.event === 'applied').length, 0);
    assert.equal((await f.db.select().from(councilReports).where(eq(councilReports.researchVersionId, accepted.version.id))).length, 1);
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

test('run overview keeps the exact report, policy installation and historical fill independent through handover and deletion', options, async () => {
  const f = await setup('immediate');
  try {
    assert.deepEqual(await f.runs.fills(f.owner, f.teamId), []);
    assert.equal((await f.runs.research(f.owner, f.teamId)).report, null);
    const { version, commission } = await acceptedReport(f);
    await f.scheduler.runOnce(new Date('2026-11-12T09:00:00Z'));
    const [cycle] = await f.db.select().from(teamRunCycles);
    assert.equal(cycle.state, 'applied', cycle.lastError ?? '');
    const report = (await f.runs.research(f.owner, f.teamId)).report;
    assert.equal(report?.versionId, version.id);
    assert.equal(report.commissionId, commission.id);
    assert.equal(report.applied?.revision, cycle.policyRevision);
    assert.equal(report.source, 'automatic');
    assert.deepEqual(await f.runs.fills(f.owner, f.teamId), [], 'Installation cannot create a fill in the read model');

    const other = await f.commission();
    const [decision] = await f.db.select().from(teamDecisions).where(eq(teamDecisions.id, cycle.decisionId!));
    const ref = { decisionId: decision.id, proposalId: decision.proposalId, proposalRevision: decision.proposalRevision };
    const signal = randomUUID();
    const filledAt = new Date('2026-11-12T16:00:00Z');
    const createdAt = new Date('2026-11-12T16:05:00Z');
    const [order] = await f.db.insert(paperOrders).values({ owner: f.owner, accountId: f.account.id, ticker: 'TEST',
      side: 'buy', quantity: '7', status: 'filled', filledAt }).returning();
    await recordTeamSignalLinks(f.db, f.owner, { ...DEFAULT_INVESTMENT_CONFIG, teamDecisionRefs: [ref] }, signal);
    await copyTeamExecutionLinks(f.db, f.owner, 'signal', signal, 'order', order.id);
    const [fill, wrongAccount] = await f.db.insert(paperTrades).values([f.account.id, other.account.id].map(accountId => ({
      owner: f.owner, accountId, ticker: 'TEST', side: 'buy', quantity: '7', price: '13.25', orderId: order.id, cashAfter: '800', createdAt,
    }))).returning();
    await copyTeamExecutionLinks(f.db, f.owner, 'order', order.id, 'trade', fill.id);
    await copyTeamExecutionLinks(f.db, f.owner, 'order', order.id, 'trade', wrongAccount.id);
    const [link] = await f.db.select().from(teamResearchLinks).where(eq(teamResearchLinks.targetId, fill.id));
    await f.db.insert(teamResearchLinks).values({ ...link, id: randomUUID(), targetRevision: 'legacy duplicate' });
    const legacy = { id: randomUUID(), filledAt: null, createdAt: new Date('2026-11-12T15:30:00Z') };
    const earlier = { id: randomUUID(), filledAt: new Date('2026-11-12T15:00:00Z'), createdAt: new Date('2026-11-12T16:40:00Z') };
    for (const item of [legacy, earlier]) {
      const [extraOrder] = await f.db.insert(paperOrders).values({ owner: f.owner, accountId: f.account.id, ticker: 'TEST',
        side: 'buy', quantity: '1', status: 'filled', filledAt: item.filledAt }).returning();
      await copyTeamExecutionLinks(f.db, f.owner, 'signal', signal, 'order', extraOrder.id);
      await f.db.insert(paperTrades).values({ id: item.id, owner: f.owner, accountId: f.account.id, orderId: extraOrder.id,
        ticker: 'TEST', side: 'buy', quantity: '1', price: '13.25', cashAfter: '800', createdAt: item.createdAt });
      await copyTeamExecutionLinks(f.db, f.owner, 'order', extraOrder.id, 'trade', item.id);
    }
    const replacement = await f.team('Handover recipient');
    const handover = await f.versions.bindingPreview(f.owner, replacement.team.id, { requestKey: randomUUID(), action: 'assign',
      accountId: f.account.id, teamVersionId: replacement.version.id, expectedBindingRevision: 0,
      expectedAccountBindingId: commission.bindingId, executionChoice: 'keep_confirmed_rules', acknowledgePendingReapproval: true });
    await f.versions.binding(f.owner, replacement.team.id, { requestKey: randomUUID(), previewId: handover.previewId, previewHash: handover.previewHash });
    const rows = await f.runs.fills(f.owner, f.teamId);
    assert.deepEqual(rows.map(row => [row.id, row.accountId, row.quantity, row.price]), [
      [fill.id, f.account.id, '7', '13.25'], [legacy.id, f.account.id, '1', '13.25'],
    ]);
    assert.deepEqual(rows.map(row => [row.filledAt, row.createdAt]), [
      [filledAt.toISOString(), createdAt.toISOString()], [null, legacy.createdAt.toISOString()],
    ]);
    assert.deepEqual(await f.runs.fills(f.owner, replacement.team.id), []);
    for (let pass = 0; pass < 8; pass++) {
      await f.worker.runOnce();
      const [prepared] = await f.db.select({ sessionId: teamCommissions.sessionId }).from(teamCommissions)
        .where(eq(teamCommissions.id, other.created.commissionId));
      if (prepared.sessionId) break;
    }
    const manual = await deliverReport(f, other.created.commissionId);
    const manualReport = (await f.runs.research(f.owner, other.team.id)).report;
    assert.equal(manualReport?.source, 'manual');
    assert.equal(manualReport.versionId, manual.version.id);
    assert.equal((await f.runs.research(f.owner, f.teamId)).report?.versionId, version.id);
    await f.db.update(councilSessions).set({ deletedAt: new Date() }).where(eq(councilSessions.id, manual.commission.sessionId!));
    assert.equal((await f.runs.research(f.owner, other.team.id)).report, null);
    await assert.rejects(f.runs.fills(f.stranger, f.teamId), /TEAM_NOT_FOUND/);
    await assert.rejects(f.runs.research(f.stranger, f.teamId), /TEAM_NOT_FOUND/);

    await f.db.update(researchDocumentVersions).set({ deletedAt: new Date() }).where(eq(researchDocumentVersions.id, version.id));
    assert.equal((await f.runs.research(f.owner, f.teamId)).report, null);
    const history = await f.commissions.detail(f.owner, f.teamId, commission.id);
    assert.equal(history.links.find(item => item.targetId === version.id)?.reportAvailable, false);
    assert.deepEqual(await f.runs.fills(f.owner, f.teamId), rows);
  } finally { await f.dispose(); }
});

test('revoking a frozen source grant removes report and decision actions while preserving the exact delivery receipts', options, async () => {
  const f = await setup();
  try {
    const input = await f.documents.submit(f.owner, { idempotencyKey: randomUUID(), title: 'Commission input', kind: 'deep',
      content: 'Source facts', sections: [{ id: 'summary', title: 'Source', content: 'Source facts' }], availableAt: new Date(Date.now() - 1000).toISOString() });
    const ref = { kind: 'report_version' as const, id: input.id, revision: String(input.version), availability: 'available' as const };
    const manual = await f.commission([ref]);
    await f.worker.runOnce();
    const { version, commission, attemptId } = await deliverReport(f, manual.created.commissionId);
    const teamId = commission.teamId;
    const decision = await f.decisions.create(f.owner, teamId, { requestKey: randomUUID(), commissionId: commission.id,
      expectedProposalRevision: 0, event: 'observe', reason: 'Retain evidence for review',
      basis: { teamVersionId: commission.teamVersionId, bindingId: commission.bindingId, bindingRevision: commission.bindingRevision,
        commissionId: commission.id, sessionId: commission.sessionId, cycleId: commission.cycleId, workKey: commission.plan.work[0].workKey,
        acceptedAttemptId: attemptId, reportVersionId: version.id, thesisVersions: [], sourceRefs: [ref] } });
    const receipt = async () => {
      const detail = await f.commissions.detail(f.owner, teamId, commission.id);
      const link = detail.links.find(item => item.kind === 'report_version' && item.targetId === version.id);
      assert.ok(link);
      assert.equal(link.attemptId, attemptId);
      const page = await f.decisions.list(f.owner, teamId, { proposalId: decision.proposalId });
      assert.equal(page.items[0].id, decision.id);
      assert.equal(page.items[0].basis.reportVersionId, version.id);
      assert.equal(page.items[0].reportAvailable, link.reportAvailable);
      assert.equal(detail.decisions.find(item => item.id === decision.id)?.reportAvailable, link.reportAvailable);
      return link;
    };
    const before = await receipt();
    assert.equal(before.reportAvailable, true);
    assert.equal((await f.runs.research(f.owner, teamId)).report?.versionId, version.id);
    const [grantId] = commission.members[0].sourceGrantIds;
    const revoked = await f.sources.revoke(f.owner, teamId, grantId, { requestKey: randomUUID(),
      expectedScopeRevision: commission.scopeRevision, reason: 'Withdraw this research input' });
    assert.deepEqual(await receipt(), { ...before, reportAvailable: false });
    assert.equal((await f.runs.research(f.owner, teamId)).report, null);
    await f.sources.grant(f.owner, teamId, { requestKey: randomUUID(), expectedScopeRevision: revoked.scopeRevision, sourceRef: ref });
    assert.deepEqual(await receipt(), { ...before, reportAvailable: false });
  } finally { await f.dispose(); }
});
