import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { eq } from 'drizzle-orm';
import { councilMessages, councilReports } from '../../database/council.schema';
import { councilResearchTasks } from '../../database/research-workflow.schema';
import { teamCommissions } from '../../database/teams.schema';
import type { PortfolioStrategyAssignment } from '../../../shared/portfolio-workspace.interface';
import type { TeamDecisionRef } from '../../../shared/team-workspace.interface';
import { makeTeamFixture } from '../teams/team-test.fixture';
import { TeamCommissionWorker } from '../teams/team-commission.worker';
import { ResearchDocumentsService } from '../research-documents/research-documents.service';
import { UserInvestmentStrategyService } from './user-investment-strategy.service';
import { teamStrategyAuthority } from './team-strategy-transaction';

test('real report forks and revisions retain readable history but cannot launder team authority into an account strategy', async () => {
  const f = await makeTeamFixture();
  try {
    const created = await f.commission();
    await new TeamCommissionWorker(f.store, f.runtime, f.commissions).runOnce();
    const [commission] = await f.db.select().from(teamCommissions).where(eq(teamCommissions.id, created.created.commissionId));
    assert.ok(commission.sessionId);
    const attemptId = randomUUID();
    const [task] = await f.db.insert(councilResearchTasks).values({ owner: f.owner, sessionId: commission.sessionId!,
      cycleId: commission.cycleId!, revision: 1, key: 'summary', position: 0, memberId: commission.members[0].memberId,
      dependencies: [], state: 'accepted', skills: [], workKey: commission.plan.work[0].workKey, acceptedAttemptId: attemptId,
      attempts: [{ id: attemptId, revision: 1, kind: 'work', startedAt: new Date().toISOString(), state: 'succeeded',
        messageId: randomUUID(), dispatched: true }] }).returning();
    const [report] = await f.db.insert(councilReports).values({ owner: f.owner, sessionId: commission.sessionId!, version: 1,
      revision: 1, decision: 'wait', summary: 'Fictional cash-flow review: retain uncertainty and continue observation.',
      dissent: [], nextReviewCondition: 'Review the next fictional filing', evidence: [], engine: 'llm',
      publicationOutcome: 'succeeded', createdAt: new Date(Date.now() - 60000),
      coverage: { cycleId: commission.cycleId!, tasks: [{ id: task.id, key: 'summary', state: 'accepted', acceptedAttemptId: attemptId }] } as never }).returning();
    const documents = new ResearchDocumentsService(f.db);
    const strategies = new UserInvestmentStrategyService(f.db, documents, {} as never);
    const original = await f.db.transaction(tx => documents.importSourceInTransaction(tx, f.owner,
      { type: 'council', id: report.id }, { availableAt: report.createdAt.toISOString(), dataAsOf: report.createdAt.toISOString() }));
    const basis = { teamVersionId: commission.teamVersionId, bindingId: commission.bindingId,
      bindingRevision: commission.bindingRevision, commissionId: commission.id, sessionId: commission.sessionId!,
      cycleId: commission.cycleId!, workKey: task.workKey!, acceptedAttemptId: attemptId, reportVersionId: original.id,
      thesisVersions: [], sourceRefs: [] };
    const adopted = await f.decisions.create(f.owner, created.team.id, { requestKey: randomUUID(), expectedProposalRevision: 0,
      commissionId: commission.id, event: 'adopt', basis, reason: 'Explicitly adopt the original fictional team delivery' });
    const refs: TeamDecisionRef[] = [{ proposalId: adopted.proposalId, proposalRevision: adopted.proposalRevision, decisionId: adopted.id }];
    const allocation = async (versionId: string): Promise<PortfolioStrategyAssignment[]> => {
      const draft = await strategies.importSource(f.owner, { kind: 'report', versionId });
      return [{ strategyId: draft.id, strategyRevision: draft.revision, allocationPct: 100, enabled: true,
        snapshot: { sources: draft.sources } as never }];
    };
    await teamStrategyAuthority(f.db, f.owner, created.account.id, await allocation(original.id), refs);
    await assert.rejects(teamStrategyAuthority(f.db, f.owner, created.account.id, await allocation(original.id), []), /TEAM_REAPPROVAL_REQUIRED/);

    const acceptedMessageId = task.attempts[0].messageId;
    const staleMessageId = randomUUID();
    await f.db.insert(councilMessages).values([acceptedMessageId, staleMessageId].map(messageId => ({
      id: messageId, owner: f.owner, sessionId: commission.sessionId!, revision: 1, role: 'manager' as const,
      memberName: 'Fictional manager',
      content: messageId === acceptedMessageId ? 'Accepted fictional cash-flow conclusion.' : 'Different unaccepted fictional conclusion.',
      metadata: { phase: 'summary' as const },
    })));
    await f.db.update(councilResearchTasks).set({ attempts: [
      { ...task.attempts[0], id: randomUUID(), messageId: staleMessageId }, ...task.attempts,
    ] }).where(eq(councilResearchTasks.id, task.id));
    const messageAllocation = async (messageId: string): Promise<PortfolioStrategyAssignment[]> => {
      const draft = await strategies.importSource(f.owner, { kind: 'message', messageId });
      return [{ strategyId: draft.id, strategyRevision: draft.revision, allocationPct: 100, enabled: true,
        snapshot: { sources: draft.sources } as never }];
    };
    await teamStrategyAuthority(f.db, f.owner, created.account.id, await messageAllocation(acceptedMessageId), refs);
    await assert.rejects(teamStrategyAuthority(f.db, f.owner, created.account.id, await messageAllocation(staleMessageId), refs), /TEAM_REAPPROVAL_REQUIRED/);

    const fork = await documents.fork(f.owner, original.id, 'User-created branch of team research');
    const revisionDraft = await documents.createDraft(f.owner, original.id, { title: 'Edited team research',
      content: 'User-edited fictional conclusion that was not delivered by the team.', changeReason: 'Manual editing fixture' });
    const revision = await documents.publishDraft(f.owner, revisionDraft.id, revisionDraft.revision);
    const parentOnly = await documents.submit(f.owner, { idempotencyKey: randomUUID(), reportId: original.reportId,
      parentVersionId: original.id, title: 'Parent-only derived opinion', kind: 'council', content: 'Manual derived opinion',
      sections: [{ id: 'summary', title: 'Summary', content: 'Manual derived opinion' }], availableAt: new Date(Date.now() - 60000).toISOString() });
    const indirect = await documents.submit(f.owner, { idempotencyKey: randomUUID(), title: 'Indirect derived opinion', kind: 'council',
      content: 'Another manual opinion', sections: [{ id: 'summary', title: 'Summary', content: 'Another manual opinion' }],
      availableAt: new Date(Date.now() - 60000).toISOString(), snapshot: { continuationSummary: { reportReferences: [{ versionId: parentOnly.id }] } } });
    for (const derived of [fork, revision, parentOnly, indirect]) {
      assert.ok((await documents.getVersion(f.owner, derived.id)).content, 'Owner history remains readable');
      const allocations = await allocation(derived.id);
      for (const authority of [[], refs]) await assert.rejects(
        teamStrategyAuthority(f.db, f.owner, created.account.id, allocations, authority), /TEAM_REAPPROVAL_REQUIRED/);
    }
    const ordinary = await documents.submit(f.owner, { idempotencyKey: randomUUID(), title: 'Independent user research', kind: 'deep',
      content: 'Independent fictional research', sections: [{ id: 'summary', title: 'Summary', content: 'Independent fictional research' }],
      availableAt: new Date(Date.now() - 60000).toISOString() });
    const ordinaryFork = await documents.fork(f.owner, ordinary.id, 'Independent ordinary branch');
    await teamStrategyAuthority(f.db, f.owner, created.account.id, await allocation(ordinaryFork.id), []);
  } finally { await f.dispose(); }
});
