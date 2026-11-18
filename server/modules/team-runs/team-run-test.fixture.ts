import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { makeTeamFixture } from '../teams/team-test.fixture';
import { AgentRosterService } from '../agent-roster/agent-roster.service';
import { commissionContext } from '../teams/team-commission.service';
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
import { teamCommissions } from '../../database/teams.schema';
import { teamRunCycles } from '../../database/team-run.schema';
import { councilResearchTasks } from '../../database/research-workflow.schema';
import { councilReports, councilSessions } from '../../database/council.schema';
import type { TeamRunAgreementInput } from '../../../shared/team-run.interface';

export async function setup(initialRun?: 'immediate' | 'scheduled', market: TeamRunAgreementInput['market'] = 'CN', budget?: TeamRunAgreementInput['budget']) {
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
    expectedBindingRevision: binding.team.bindingRevision, objective: 'Fictional portfolio review', market,
    ...(initialRun ? { initialRun } : {}), budget: {
      perRun: { budgetMode: 'cost_and_calls', ceiling: { amount: '1', currency: 'USD' }, callLimit: 2, paidRevisionLimit: 0 },
      daily: { costUsd: '1', calls: 2 }, monthly: { costUsd: '2', calls: 4 } }, replacementPolicy: { kind: 'replace_combination', allocationPct: 50 }, inputRefs: [] };
  if (budget) input.budget = budget;
  const preview = await runs.preview(f.owner, team.team.id, input);
  const agreement = await runs.confirm(f.owner, team.team.id, { requestKey: randomUUID(), previewId: preview.previewId, previewHash: preview.previewHash });
  const running = await runs.control(f.owner, team.team.id, 'start', { requestKey: randomUUID(), expectedRevision: agreement.revision });
  return { ...f, teamId: team.team.id, friend, roster, workspace, documents, strategies, runs, delivery, scheduler, running, account, initialPreview: preview,
    worker: new TeamCommissionWorker(f.store, f.runtime, f.commissions), input };
}
export async function acceptedReport(f: Awaited<ReturnType<typeof setup>>, noTrade = false, now = new Date('2026-11-12T09:00:00Z')) {
  await f.scheduler.runOnce(now);
  await f.worker.runOnce();
  const [cycle] = await f.db.select().from(teamRunCycles).where(eq(teamRunCycles.agreementId, f.running.id));
  assert.ok(cycle.commissionId, JSON.stringify(cycle));
  return { cycle, ...await deliverReport(f, cycle.commissionId, noTrade) };
}

export async function deliverReport(f: Awaited<ReturnType<typeof setup>>, commissionId: string, noTrade = false) {
  const [commission] = await f.db.select().from(teamCommissions).where(eq(teamCommissions.id, commissionId));
  assert.ok(commission.sessionId && commission.cycleId, 'Prepare the original commission before recording its delivery');
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
    availableAt: new Date(Date.now() - 1000).toISOString(), snapshot: { teamExecutionContext: commissionContext(commission), executionPlan: executionPlan as never, evidence: [{ id: 'fixture-e1', content: 'Fictional bound proposal evidence' }] } });
  await f.db.update(councilReports).set({ researchVersionId: version.id }).where(eq(councilReports.id, report.id));
  await f.db.update(councilSessions).set({ status: 'completed' }).where(eq(councilSessions.id, commission.sessionId!));
  await f.worker.project(commission.id);
  return { commission, version, attemptId };
}
