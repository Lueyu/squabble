import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { makeTeamFixture, teamErrorIs } from './team-test.fixture';
import { teamAccountBindings, teamCommissions, teamVersions } from '../../database/teams.schema';
import { teamRunAgreements, teamRunAgreementRevisions, teamRunCycles } from '../../database/team-run.schema';
import { paperAccounts, paperOrders, paperTrades, paperSnapshots } from '../../database/schema';
import { investmentPolicies } from '../../database/investment-policy.schema';
import { councilReports } from '../../database/council.schema';
import { TeamRunService } from '../team-runs/team-run.service';
import { TeamCommissionWorker } from './team-commission.worker';
import { assertTeamRunCommissionAuthority } from '../../database/team-run-authority';
import { assertTeamExecutionInTransaction } from '../../database/team-context';
import { commissionContext } from './team-commission.service';
import type { TeamExecutionChoice } from '../../../shared/team-workspace.interface';

const options = { skip: !process.env.TEAM_TEST_DATABASE_URL };

async function setup(cycleState: 'reserved' | 'uncertain' = 'reserved') {
  const f = await makeTeamFixture();
  try {
  const c = await f.commission();
  const worker = new TeamCommissionWorker(f.store, f.runtime, f.commissions);
  await worker.runOnce(); await worker.runOnce();
  const [commission] = await f.db.select().from(teamCommissions).where(eq(teamCommissions.id, c.created.commissionId));
  const [agreement] = await f.db.insert(teamRunAgreements).values({
    ownerId: f.owner, teamId: c.team.id, accountId: c.account.id, revision: 1, state: 'running',
    scopeRevision: c.team.scopeRevision, members: commission.members, confirmedBy: f.owner,
    configuration: { teamVersionId: c.version.id, bindingId: c.binding.id, expectedBindingRevision: 1,
      objective: 'Fictional retained team research', market: 'CN', cadence: { kind: 'after_close', delayMinutes: 60 },
      budget: { perRun: { ...commission.budgetLimit, ceiling: { amount: '1', currency: 'USD' } },
        daily: { costUsd: '2', calls: 4 }, monthly: { costUsd: '20', calls: 40 } },
      replacementPolicy: { kind: 'replace_combination', allocationPct: 50 }, inputRefs: [] },
  }).returning();
  await f.db.insert(teamRunAgreementRevisions).values({ ownerId: f.owner, agreementId: agreement.id,
    revision: 1, state: 'running', accountId: agreement.accountId, configuration: agreement.configuration,
    members: agreement.members, scopeRevision: agreement.scopeRevision, confirmedBy: f.owner, confirmedAt: agreement.confirmedAt });
  const [cycle] = await f.db.insert(teamRunCycles).values({ ownerId: f.owner, teamId: c.team.id,
    agreementId: agreement.id, agreementRevision: 1, tradingDate: '2026-11-13', state: cycleState,
    commissionId: cycleState === 'uncertain' ? commission.id : null, reservedCostUsd: '1', reservedCalls: 2 }).returning();
  await f.db.update(paperAccounts).set({ botEnabled: true }).where(eq(paperAccounts.id, c.account.id));
  return { ...f, c, commission, agreement, cycle, runs: new TeamRunService(f.store, f.commissions) };
  } catch (error) { await f.dispose(); throw error; }
}

async function preview(f: Awaited<ReturnType<typeof setup>>, choice: TeamExecutionChoice = 'pause_all') {
  const current = await f.service.detail(f.owner, f.c.team.id);
  return f.versions.archivePreview(f.owner, current.id, { requestKey: randomUUID(),
    expectedBindingRevision: current.bindingRevision, expectedCurrentVersionId: current.currentVersionId, executionChoice: choice });
}

test('removal atomically pauses agreement and protective orders while preserving account, trades, reports and versions', options, async () => {
  const f = await setup();
  try {
    const [filled] = await f.db.insert(paperOrders).values({ owner: f.owner, accountId: f.c.account.id,
      ticker: 'DEMO', side: 'buy', quantity: '1', status: 'filled', reason: 'Retained historical fill' }).returning();
    const [trade] = await f.db.insert(paperTrades).values({ owner: f.owner, accountId: f.c.account.id,
      orderId: filled.id, ticker: 'DEMO', side: 'buy', quantity: '1', price: '20', cashAfter: '9980' }).returning();
    const [snapshot] = await f.db.insert(paperSnapshots).values({ owner: f.owner, accountId: f.c.account.id,
      snapshotDate: '2026-11-12', equity: '10000', cash: '9980', positionsValue: '20' }).returning();
    const [report] = await f.db.insert(councilReports).values({ owner: f.owner, sessionId: f.commission.sessionId!,
      revision: 1, version: 1, decision: 'wait', summary: 'Retained fictional research', engine: 'llm',
      dissent: [], evidence: [], nextReviewCondition: 'Retained historical condition' }).returning();
    await f.db.insert(paperOrders).values(['pending', 'pending_approval', 'approved'].map(status => ({
      owner: f.owner, accountId: f.c.account.id, ticker: 'DEMO', side: 'sell', quantity: '1', status, reason: 'Fictional protective order' })));
    const p = await preview(f);
    assert.deepEqual(p.result.runAgreement, { id: f.agreement.id, revision: 1, state: 'running' });
    const input = { requestKey: randomUUID(), previewId: p.previewId, previewHash: p.previewHash };
    const removed = await f.versions.archive(f.owner, f.c.team.id, input);
    assert.equal(removed.team.status, 'archived');
    assert.equal(removed.team.accountId, null);
    assert.deepEqual(await f.versions.archive(f.owner, f.c.team.id, input), removed, 'same confirmed intent replays its receipt');
    assert.equal((await f.db.select().from(teamRunAgreements))[0].state, 'paused');
    assert.deepEqual((await f.db.select().from(teamRunAgreementRevisions)).map(row => [row.revision, row.state]), [[1, 'running'], [2, 'paused']]);
    assert.equal((await f.db.select().from(teamRunCycles).where(eq(teamRunCycles.id, f.cycle.id)))[0].state, 'cancelled');
    assert.equal((await f.db.select().from(paperAccounts).where(eq(paperAccounts.id, f.c.account.id)))[0].botEnabled, false);
    const orders = await f.db.select().from(paperOrders);
    assert.equal(orders.find(row => row.id === filled.id)!.status, 'filled');
    assert.ok(orders.filter(row => row.id !== filled.id).every(row => row.status === 'cancelled'));
    assert.equal((await f.db.select().from(paperTrades).where(eq(paperTrades.id, trade.id))).length, 1);
    assert.equal((await f.db.select().from(paperSnapshots).where(eq(paperSnapshots.id, snapshot.id))).length, 1);
    assert.equal((await f.db.select().from(councilReports).where(eq(councilReports.id, report.id))).length, 1);
    assert.equal((await f.db.select().from(teamVersions).where(eq(teamVersions.id, f.c.version.id))).length, 1);
    assert.equal((await f.service.list(f.owner, { status: 'active' })).items.length, 0);
    assert.equal((await f.service.list(f.owner, { status: 'archived' })).items[0].id, f.c.team.id);
    await assert.rejects(f.db.transaction(tx => assertTeamExecutionInTransaction(tx, f.owner, commissionContext(f.commission), { dispatch: true })), /TEAM_SCOPE_REVOKED/);
    await assert.rejects(f.db.transaction(tx => assertTeamExecutionInTransaction(tx, f.owner, commissionContext(f.commission), { publication: true })), /TEAM_SCOPE_REVOKED/);
    const successor = await f.team('A different retained team');
    await assert.rejects(f.versions.archive(f.owner, successor.team.id, input), teamErrorIs('TEAM_REQUEST_KEY_CONFLICT'));
  } finally { await f.dispose(); }
});

test('archival does not relabel an uncertain dispatched cycle or release its reserved usage', options, async () => {
  const f = await setup('uncertain');
  try {
    const p = await preview(f);
    await f.versions.archive(f.owner, f.c.team.id, { requestKey: randomUUID(), previewId: p.previewId, previewHash: p.previewHash });
    const [cycle] = await f.db.select().from(teamRunCycles).where(eq(teamRunCycles.id, f.cycle.id));
    assert.equal(cycle.state, 'uncertain');
    assert.equal(Number(cycle.reservedCostUsd), 1);
    assert.equal(cycle.reservedCalls, 2);
    await assert.rejects(f.db.transaction(tx => assertTeamRunCommissionAuthority(tx, f.owner, f.commission.id, true)), /TEAM_SCOPE_REVOKED/);
    await assert.rejects(f.db.transaction(tx => assertTeamRunCommissionAuthority(tx, f.owner, f.commission.id, false, true)), /TEAM_SCOPE_REVOKED/);
  } finally { await f.dispose(); }
});

test('a published version change after review cannot be removed using the stale preview', options, async () => {
  const f = await setup();
  try {
    const p = await preview(f);
    const current = await f.service.detail(f.owner, f.c.team.id);
    const config = structuredClone(current.draft.config);
    config.roles[0].responsibility = 'A newly published fictional responsibility';
    const saved = await f.service.save(f.owner, current.id, 'draft', { requestKey: randomUUID(), expectedSemanticRevision: current.semanticRevision, config });
    const pp = await f.versions.publishPreview(f.owner, current.id, { requestKey: randomUUID(), expectedSemanticRevision: saved.semanticRevision });
    await f.versions.publish(f.owner, current.id, { requestKey: randomUUID(), previewId: pp.previewId, previewHash: pp.previewHash });
    await assert.rejects(f.versions.archive(f.owner, current.id, { requestKey: randomUUID(), previewId: p.previewId, previewHash: p.previewHash }), teamErrorIs('TEAM_PREVIEW_STALE'));
    assert.equal((await f.service.detail(f.owner, current.id)).status, 'active');
  } finally { await f.dispose(); }
});

test('removing a formerly bound team does not stop the successor already running on its old account', options, async () => {
  const f = await setup();
  try {
    const successor = await f.team('Already active successor');
    const bp = await f.versions.bindingPreview(f.owner, successor.team.id, { requestKey: randomUUID(), action: 'assign',
      accountId: f.c.account.id, teamVersionId: successor.version.id, expectedBindingRevision: 0, expectedAccountBindingId: f.c.binding.id,
      executionChoice: 'keep_confirmed_rules', acknowledgePendingReapproval: true });
    await f.versions.binding(f.owner, successor.team.id, { requestKey: randomUUID(), previewId: bp.previewId, previewHash: bp.previewHash });
    const [order] = await f.db.insert(paperOrders).values({ owner: f.owner, accountId: f.c.account.id,
      ticker: 'DEMO', side: 'sell', quantity: '1', status: 'approved', reason: 'New team protective order' }).returning();
    const p = await preview(f);
    assert.equal(p.result.accountId, null);
    await f.versions.archive(f.owner, f.c.team.id, { requestKey: randomUUID(), previewId: p.previewId, previewHash: p.previewHash });
    await f.runs.reconcileAuthority(f.agreement);
    await f.runs.control(f.owner, f.c.team.id, 'pause', { requestKey: randomUUID(), expectedRevision: 2 });
    assert.equal((await f.db.select().from(paperAccounts).where(eq(paperAccounts.id, f.c.account.id)))[0].botEnabled, true);
    assert.equal((await f.db.select().from(paperOrders).where(eq(paperOrders.id, order.id)))[0].status, 'approved');
  } finally { await f.dispose(); }
});

test('archive is owner scoped and an agreement change invalidates its exact reviewed snapshot', options, async () => {
  const f = await setup();
  try {
    const p = await preview(f);
    await assert.rejects(f.versions.archive(f.stranger, f.c.team.id, { requestKey: randomUUID(), previewId: p.previewId, previewHash: p.previewHash }), teamErrorIs('TEAM_NOT_FOUND'));
    await f.runs.control(f.owner, f.c.team.id, 'pause', { requestKey: randomUUID(), expectedRevision: 1 });
    await assert.rejects(f.versions.archive(f.owner, f.c.team.id, { requestKey: randomUUID(), previewId: p.previewId, previewHash: p.previewHash }), /TEAM_PREVIEW_STALE/);
    assert.equal((await f.service.detail(f.owner, f.c.team.id)).status, 'active');
  } finally { await f.dispose(); }
});

test('an unbound unpublished draft can be removed without an agreement or account', options, async () => {
  const f = await makeTeamFixture();
  try {
    const created = await f.service.create(f.owner, { requestKey: randomUUID(), name: 'Unused fictional draft' });
    const p = await f.versions.archivePreview(f.owner, created.id, { requestKey: randomUUID(), expectedBindingRevision: 0, expectedCurrentVersionId: null, executionChoice: 'pause_all' });
    assert.equal(p.result.runAgreement, null);
    const result = await f.versions.archive(f.owner, created.id, { requestKey: randomUUID(), previewId: p.previewId, previewHash: p.previewHash });
    assert.equal(result.team.status, 'archived');
    assert.equal((await f.db.select().from(paperAccounts)).length, 0);
  } finally { await f.dispose(); }
});

test('advanced keep-confirmed archive still stops the team agreement without stopping explicit existing policy', options, async () => {
  const f = await setup();
  try {
    const p = await preview(f, 'keep_confirmed_rules');
    await f.versions.archive(f.owner, f.c.team.id, { requestKey: randomUUID(), previewId: p.previewId, previewHash: p.previewHash });
    assert.equal((await f.db.select().from(teamRunAgreements))[0].state, 'paused');
    assert.equal((await f.db.select().from(paperAccounts).where(eq(paperAccounts.id, f.c.account.id)))[0].botEnabled, true);
  } finally { await f.dispose(); }
});

test('old paused or delayed authority cannot stop an account handed to a later team', options, async () => {
  const f = await setup();
  try {
    const p = await preview(f);
    await f.versions.archive(f.owner, f.c.team.id, { requestKey: randomUUID(), previewId: p.previewId, previewHash: p.previewHash });
    const successor = await f.team('Successor team');
    const bp = await f.versions.bindingPreview(f.owner, successor.team.id, { requestKey: randomUUID(), action: 'assign',
      accountId: f.c.account.id, teamVersionId: successor.version.id, expectedBindingRevision: 0, expectedAccountBindingId: null,
      executionChoice: 'keep_confirmed_rules', acknowledgePendingReapproval: true });
    await f.versions.binding(f.owner, successor.team.id, { requestKey: randomUUID(), previewId: bp.previewId, previewHash: bp.previewHash });
    await f.db.update(paperAccounts).set({ botEnabled: true }).where(eq(paperAccounts.id, f.c.account.id));
    await f.db.update(investmentPolicies).set({ status: 'running' }).where(eq(investmentPolicies.accountId, f.c.account.id));
    const [order] = await f.db.insert(paperOrders).values({ owner: f.owner, accountId: f.c.account.id,
      ticker: 'DEMO', side: 'sell', quantity: '1', status: 'approved', reason: 'Successor protective order' }).returning();
    await f.runs.reconcileAuthority(f.agreement);
    await f.runs.control(f.owner, f.c.team.id, 'pause', { requestKey: randomUUID(), expectedRevision: 2 });
    assert.equal((await f.db.select().from(paperAccounts).where(eq(paperAccounts.id, f.c.account.id)))[0].botEnabled, true);
    assert.equal((await f.db.select().from(paperOrders).where(eq(paperOrders.id, order.id)))[0].status, 'approved');
    assert.equal((await f.db.select().from(teamAccountBindings).where(and(eq(teamAccountBindings.teamId, successor.team.id), eq(teamAccountBindings.state, 'active')))).length, 1);
  } finally { await f.dispose(); }
});
