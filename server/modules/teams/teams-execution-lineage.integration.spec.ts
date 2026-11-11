import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { and, eq } from 'drizzle-orm';
import type { BuilderProfile } from '../../../shared/api.interface';
import type { StrategyCandidate } from '../../../shared/strategy.interface';
import { councilReports, councilSessions } from '../../database/council.schema';
import { investmentPolicies } from '../../database/investment-policy.schema';
import { councilResearchTasks } from '../../database/research-workflow.schema';
import { paperAccounts, paperOrders, paperPositions, paperTrades } from '../../database/schema';
import { strategySignals } from '../../database/strategy.schema';
import { teamCommissions, teamDecisions, teamResearchLinks } from '../../database/teams.schema';
import { copyTeamExecutionLinks, recordTeamSignalLinks, recordTeamThesisVersionLink } from '../../database/team-execution-links';
import { DEFAULT_INVESTMENT_CONFIG } from '../paper-trading/investment-policy.rules';
import { StrategyStore } from '../paper-trading/strategy.store';
import { TeamCommissionWorker } from './team-commission.worker';
import { makeTeamFixture } from './team-test.fixture';

const options = { skip: !process.env.TEAM_TEST_DATABASE_URL };

test('actual signal claim and transactional execution links retain the original team through account handover', options, async () => {
  const f = await makeTeamFixture();
  try {
    const original = await f.commission();
    await new TeamCommissionWorker(f.store, f.runtime, f.commissions).runOnce();
    const [commission] = await f.db.select().from(teamCommissions).where(eq(teamCommissions.id, original.created.commissionId));
    assert.ok(commission.sessionId);
    const [session] = await f.db.select().from(councilSessions).where(eq(councilSessions.id, commission.sessionId));
    const attemptId = randomUUID();
    const basis = { teamVersionId: commission.teamVersionId, bindingId: commission.bindingId,
      bindingRevision: commission.bindingRevision, commissionId: commission.id, sessionId: session.id,
      cycleId: commission.cycleId!, workKey: commission.plan.work[0].workKey, acceptedAttemptId: attemptId,
      reportVersionId: null, thesisVersions: [], sourceRefs: [] };
    const [adopted] = await f.db.insert(teamDecisions).values({ ownerId: f.owner, teamId: original.team.id,
      accountId: original.account.id, commissionId: commission.id, proposalId: randomUUID(), proposalRevision: 1,
      event: 'adopt', actorType: 'user', actorId: f.owner, basis, reason: 'Fictional accepted decision', requestKey: randomUUID() }).returning();
    const config = { ...DEFAULT_INVESTMENT_CONFIG, teamDecisionRefs: [{ decisionId: adopted.id,
      proposalId: adopted.proposalId, proposalRevision: adopted.proposalRevision }] };
    const [policy] = await f.db.update(investmentPolicies).set({ status: 'running', baseConfig: config, effectiveConfig: config })
      .where(eq(investmentPolicies.accountId, original.account.id)).returning();
    await f.db.update(paperAccounts).set({ botEnabled: true }).where(eq(paperAccounts.id, original.account.id));
    await f.db.insert(paperPositions).values({ owner: f.owner, accountId: original.account.id,
      ticker: 'AAPL', shares: '2', avgCost: '10' });
    const profile: BuilderProfile = { id: randomUUID(), version: 1, status: 'active', config: session.profileSnapshot,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    const candidate: StrategyCandidate = { signalId: randomUUID(), planId: randomUUID(), planVersion: 1,
      ruleId: 'fictional-protection', parentPolicyId: policy.id, parentPolicyRevision: policy.revision,
      accountId: original.account.id, ticker: 'AAPL', market: 'US', side: 'sell', quantity: 1, price: 9,
      quoteAt: new Date().toISOString(), protectiveStop: true, reason: 'Fictional protective exit' };
    assert.equal(await new StrategyStore(f.db).claimSignal(f.owner, profile, candidate), true);
    assert.equal(await new StrategyStore(f.db).claimSignal(f.owner, profile, candidate), false, 'Duplicate claims are idempotent');
    const [signalLink] = await f.db.select().from(teamResearchLinks).where(eq(teamResearchLinks.kind, 'signal'));
    assert.equal(signalLink.targetId, candidate.signalId);
    assert.equal(signalLink.attemptId, attemptId);

    const replacement = await f.team('Replacement fixture team');
    const handover = await f.versions.bindingPreview(f.owner, replacement.team.id, { requestKey: randomUUID(), action: 'assign',
      accountId: original.account.id, teamVersionId: replacement.version.id, expectedBindingRevision: 0,
      expectedAccountBindingId: original.binding.id, executionChoice: 'keep_confirmed_rules', acknowledgePendingReapproval: true });
    await f.versions.binding(f.owner, replacement.team.id, { requestKey: randomUUID(), previewId: handover.previewId, previewHash: handover.previewHash });
    assert.equal((await f.service.detail(f.owner, replacement.team.id)).accountId, original.account.id);

    let orderId = '';
    let tradeId = '';
    await f.db.transaction(async tx => {
      const [order] = await tx.insert(paperOrders).values({ owner: f.owner, accountId: original.account.id,
        ticker: 'AAPL', side: 'sell', quantity: '1', status: 'filled', filledPrice: '9' }).returning();
      orderId = order.id;
      await copyTeamExecutionLinks(tx, f.owner, 'signal', candidate.signalId, 'order', order.id);
      await copyTeamExecutionLinks(tx, f.owner, 'signal', candidate.signalId, 'order', order.id);
      const [trade] = await tx.insert(paperTrades).values({ owner: f.owner, accountId: original.account.id, orderId,
        ticker: 'AAPL', side: 'sell', quantity: '1', price: '9', cashAfter: '100009' }).returning();
      tradeId = trade.id;
      await copyTeamExecutionLinks(tx, f.owner, 'order', order.id, 'trade', trade.id);
    });
    const execution = await f.db.select().from(teamResearchLinks);
    assert.equal(execution.length, 3, 'Signal/order/trade identities deduplicate exactly');
    assert.ok(execution.every(link => link.teamId === original.team.id && link.commissionId === commission.id
      && link.workKey === basis.workKey && link.attemptId === attemptId));
    assert.equal(execution.find(link => link.kind === 'trade')?.targetId, tradeId);
    assert.equal(execution.find(link => link.kind === 'trade')?.metadata.sourceId, orderId);
    assert.equal(execution.find(link => link.kind === 'order')?.metadata.sourceId, candidate.signalId);

    const unrelatedTarget = randomUUID();
    await copyTeamExecutionLinks(f.db, f.stranger, 'signal', candidate.signalId, 'order', unrelatedTarget);
    assert.equal((await f.db.select().from(teamResearchLinks).where(eq(teamResearchLinks.targetId, unrelatedTarget))).length, 0);
    await assert.rejects(recordTeamSignalLinks(f.db, f.stranger, config, randomUUID()), /TEAM_REFERENCE_NOT_FOUND/);

    const rolledBack = randomUUID();
    await assert.rejects(f.db.transaction(async tx => {
      await tx.insert(paperOrders).values({ id: rolledBack, owner: f.owner, accountId: original.account.id,
        ticker: 'AAPL', side: 'sell', quantity: '1' });
      await copyTeamExecutionLinks(tx, f.owner, 'signal', candidate.signalId, 'order', rolledBack);
      throw new Error('Fictional ledger failure');
    }), /Fictional ledger failure/);
    assert.equal((await f.db.select().from(paperOrders).where(eq(paperOrders.id, rolledBack))).length, 0);
    assert.equal((await f.db.select().from(teamResearchLinks).where(eq(teamResearchLinks.targetId, rolledBack))).length, 0);
    assert.equal((await f.db.select().from(strategySignals).where(eq(strategySignals.id, candidate.signalId))).length, 1);
    const missingDecision = { ...config, teamDecisionRefs: [{ ...config.teamDecisionRefs[0], decisionId: randomUUID() }] };
    await f.db.update(investmentPolicies).set({ baseConfig: missingDecision, effectiveConfig: missingDecision })
      .where(eq(investmentPolicies.id, policy.id));
    const failedClaim = { ...candidate, signalId: randomUUID(), planId: randomUUID() };
    await assert.rejects(new StrategyStore(f.db).claimSignal(f.owner, profile, failedClaim), /TEAM_REFERENCE_NOT_FOUND/);
    assert.equal((await f.db.select().from(strategySignals).where(eq(strategySignals.id, failedClaim.signalId))).length, 0,
      'A provenance failure rolls back the actual signal insertion');
  } finally { await f.dispose(); }
});

test('thesis versions use the report accepted attempt after later task retries and retain exact version identities', options, async () => {
  const f = await makeTeamFixture();
  try {
    const original = await f.commission();
    await new TeamCommissionWorker(f.store, f.runtime, f.commissions).runOnce();
    const [commission] = await f.db.select().from(teamCommissions).where(eq(teamCommissions.id, original.created.commissionId));
    assert.ok(commission.sessionId && commission.cycleId);
    const oldAttempt = randomUUID(), laterAttempt = randomUUID();
    const [task] = await f.db.insert(councilResearchTasks).values({ owner: f.owner, sessionId: commission.sessionId,
      cycleId: commission.cycleId, revision: 1, key: 'summary', position: 0, memberId: commission.members[0].memberId,
      dependencies: [], state: 'accepted', skills: [], workKey: commission.plan.work[0].workKey,
      acceptedAttemptId: laterAttempt, attempts: [oldAttempt, laterAttempt].map(id => ({ id, revision: 1, kind: 'work' as const,
        startedAt: new Date().toISOString(), state: 'succeeded' as const, dispatched: true, messageId: randomUUID() })) }).returning();
    const [report] = await f.db.insert(councilReports).values({ owner: f.owner, sessionId: commission.sessionId,
      version: 1, revision: 1, decision: 'wait', summary: 'Fictional fixed report', dissent: [], nextReviewCondition: 'Next fixture',
      evidence: [], engine: 'llm', researchVersionId: randomUUID(), coverage: { goal: 'comprehensive', cycleId: commission.cycleId,
        revision: 1, complete: true, tasks: [{ id: task.id, key: 'summary', state: 'accepted', acceptedAttemptId: oldAttempt }] } }).returning();
    const thesisId = randomUUID(), initialVersion = randomUUID(), editedVersion = randomUUID();
    await f.db.transaction(async tx => {
      await recordTeamThesisVersionLink(tx, f.owner, report, thesisId, initialVersion, 1, 'agent');
      await recordTeamThesisVersionLink(tx, f.owner, report, thesisId, editedVersion, 2, 'user');
      await recordTeamThesisVersionLink(tx, f.owner, report, thesisId, editedVersion, 2, 'user');
    });
    const links = await f.db.select().from(teamResearchLinks).where(eq(teamResearchLinks.kind, 'thesis_version'));
    assert.equal(links.length, 2);
    assert.ok(links.every(link => link.attemptId === oldAttempt && link.workKey === task.workKey
      && link.metadata.reportVersionId === report.researchVersionId && link.metadata.thesisId === thesisId));
    assert.equal(links.find(link => link.targetId === initialVersion)?.targetRevision, '1');
    assert.equal(links.find(link => link.targetId === editedVersion)?.targetRevision, '2');
    const foreignVersion = randomUUID();
    await recordTeamThesisVersionLink(f.db, f.stranger, report, thesisId, foreignVersion, 3, 'user');
    assert.equal((await f.db.select().from(teamResearchLinks).where(and(eq(teamResearchLinks.targetId, foreignVersion), eq(teamResearchLinks.ownerId, f.stranger)))).length, 0);
    await assert.rejects(recordTeamThesisVersionLink(f.db, f.owner,
      { ...report, coverage: { tasks: [{ id: task.id, key: 'summary', acceptedAttemptId: randomUUID() }] } },
      thesisId, randomUUID(), 4, 'user'), /TEAM_REFERENCE_NOT_FOUND/);
  } finally { await f.dispose(); }
});
