import { and, desc, eq } from 'drizzle-orm';
import { ConflictException } from '@nestjs/common';
import { teamCommissions, teamDecisions, teamResearchLinks } from '../../database/teams.schema';
import { councilMessages, councilReports, councilSessions } from '../../database/council.schema';
import { councilResearchTasks } from '../../database/research-workflow.schema';
import { assertTeamDecisionReferences, type TeamDatabase } from '../../database/team-context';
import { sourceFingerprint } from '../../database/team-source-context';
import { researchDocumentVersions } from '../../database/research-documents.schema';
import { researchThesisVersions } from '../../database/research-memory.schema';
import { teamCouncilMembers } from '../council/council.team';
import { deriveTeamDecisionLineage } from '../../database/team-decision-lineage';
import type { TeamDecisionRef, TeamExecutionContext } from '../../../shared/team-workspace.interface';
import type { PortfolioStrategyAssignment } from '../../../shared/portfolio-workspace.interface';
import { assertTeamStrategyReportAuthority } from './team-strategy-sources';
/** Validate both explicit approval and provenance. Omitting refs cannot turn team output into a legacy strategy. */
export async function teamStrategyAuthority(tx: TeamDatabase, owner: string, accountId: string, allocations: PortfolioStrategyAssignment[], refs: TeamDecisionRef[]) {
    if (new Set(refs.map(ref => ref.proposalId)).size !== refs.length)
        throw new ConflictException('TEAM_REAPPROVAL_REQUIRED');
    await assertTeamDecisionReferences(tx, owner, accountId, refs);
    const decisions = [];
    const contexts: TeamExecutionContext[] = [];
    for (const ref of refs) {
        const [decision] = await tx.select().from(teamDecisions).where(and(eq(teamDecisions.ownerId, owner), eq(teamDecisions.id, ref.decisionId)));
        const [latest] = await tx.select().from(teamDecisions).where(and(eq(teamDecisions.ownerId, owner), eq(teamDecisions.proposalId, ref.proposalId))).orderBy(desc(teamDecisions.proposalRevision)).limit(1);
        if (latest?.event === 'requires_reapproval' || latest?.event === 'reject')
            throw new ConflictException('TEAM_REAPPROVAL_REQUIRED');
        const [commission] = await tx.select().from(teamCommissions).where(and(eq(teamCommissions.ownerId, owner), eq(teamCommissions.id, decision.basis.commissionId)));
        if (!commission || commission.accountId !== accountId)
            throw new ConflictException('TEAM_REAPPROVAL_REQUIRED');
        await deriveTeamDecisionLineage(tx, owner, commission, decision.basis);
        for (const source of decision.basis.sourceRefs)
            await sourceFingerprint(tx, owner, source, commission.plan.dataCutoffAt);
        if (decision.basis.reportVersionId) {
            const [v] = await tx.select().from(researchDocumentVersions).where(and(eq(researchDocumentVersions.owner, owner), eq(researchDocumentVersions.id, decision.basis.reportVersionId)));
            if (!v)
                throw new ConflictException('TEAM_SOURCE_UNAVAILABLE');
            await sourceFingerprint(tx, owner, { kind: 'report_version', id: v.id, revision: String(v.version), availability: 'available' });
        }
        for (const thesis of decision.basis.thesisVersions) {
            const [v] = await tx.select().from(researchThesisVersions).where(and(eq(researchThesisVersions.owner, owner), eq(researchThesisVersions.id, thesis.versionId), eq(researchThesisVersions.thesisId, thesis.thesisId)));
            if (!v || v.status !== 'confirmed')
                throw new ConflictException('TEAM_REAPPROVAL_REQUIRED');
            await sourceFingerprint(tx, owner, { kind: 'thesis_version', id: v.id, revision: String(v.version), availability: 'available' });
        }
        decisions.push(decision);
        if (!contexts.some(c => c.commissionId === commission.id))
            contexts.push({ audience: 'team', ownerId: owner, teamId: commission.teamId, teamVersionId: commission.teamVersionId, commissionId: commission.id,
                accountId, bindingId: commission.bindingId, bindingRevision: commission.bindingRevision, scopeRevision: commission.scopeRevision,
                deadlineAt: commission.plan.deadlineAt, dataCutoffAt: commission.plan.dataCutoffAt, plan: commission.plan, members: commission.members, inputSnapshot: commission.inputSnapshot });
    }
    const adoptedOutputs = new Set(decisions.filter(decision => decision.commissionId && decision.basis.reportVersionId)
        .map(decision => `${decision.commissionId}:${decision.basis.reportVersionId}`));
    for (const allocation of allocations) {
        for (const source of allocation.snapshot.sources) {
            if (source.versionId) await assertTeamStrategyReportAuthority(tx, owner, source.versionId, adoptedOutputs);
            const [report] = source.versionId ? await tx.select().from(councilReports).where(and(eq(councilReports.owner, owner), eq(councilReports.researchVersionId, source.versionId))) : [];
            const [message] = source.kind === 'message' && source.messageId ? await tx.select().from(councilMessages)
                .where(and(eq(councilMessages.owner, owner), eq(councilMessages.id, source.messageId))) : [];
            if (source.kind === 'message' && (!message || source.sessionId && message.sessionId !== source.sessionId))
                throw new ConflictException('TEAM_REAPPROVAL_REQUIRED');
            const sessionId = report?.sessionId ?? message?.sessionId ?? source.sessionId;
            const [session] = sessionId ? await tx.select().from(councilSessions).where(and(eq(councilSessions.owner, owner), eq(councilSessions.id, sessionId))) : [];
            const commissionId = session?.teamCommissionId ?? session?.teamContext?.commissionId ?? session?.checkpoint?.teamContext?.commissionId;
            if (commissionId) {
                if (source.kind === 'message') {
                    let accepted = false;
                    for (const decision of decisions.filter(item => item.commissionId === commissionId && item.basis.sessionId === sessionId)) {
                        const basis = decision.basis;
                        const [task] = await tx.select().from(councilResearchTasks).where(and(eq(councilResearchTasks.owner, owner),
                            eq(councilResearchTasks.sessionId, basis.sessionId), eq(councilResearchTasks.cycleId, basis.cycleId),
                            eq(councilResearchTasks.workKey, basis.workKey)));
                        const attempt = task?.attempts.find(item => item.id === basis.acceptedAttemptId);
                        if (task?.state === 'accepted' && task.acceptedAttemptId === basis.acceptedAttemptId
                            && attempt?.kind === 'work' && attempt.state === 'succeeded' && attempt.messageId === message?.id) accepted = true;
                    }
                    if (!accepted) throw new ConflictException('TEAM_REAPPROVAL_REQUIRED');
                }
                else if (!decisions.some(decision => decision.commissionId === commissionId && decision.basis.reportVersionId === source.versionId))
                    throw new ConflictException('TEAM_REAPPROVAL_REQUIRED');
            }
        }
    }
    const memberIds = new Set(contexts.flatMap(c => [c.plan.leadRoleId, ...c.plan.work.map(w => w.reviewerRoleId)]));
    const members = contexts.flatMap(c => teamCouncilMembers(c).filter(m => c.members.some(s => s.memberId === m.id && memberIds.has(s.roleId))));
    return { contexts, members: [...new Map(members.map(m => [m.id, m])).values()] };
}
export async function recordTeamStrategyApplied(tx: TeamDatabase, owner: string, accountId: string, policyRevision: number, allocations: PortfolioStrategyAssignment[], refs: TeamDecisionRef[], requestKey: string): Promise<void> {
    for (const ref of refs) {
        const [origin] = await tx.select().from(teamDecisions).where(and(eq(teamDecisions.ownerId, owner), eq(teamDecisions.id, ref.decisionId)));
        const [last] = await tx.select().from(teamDecisions).where(and(eq(teamDecisions.ownerId, owner), eq(teamDecisions.proposalId, ref.proposalId))).orderBy(desc(teamDecisions.proposalRevision)).limit(1);
        await tx.insert(teamDecisions).values({ ownerId: owner, teamId: origin.teamId, accountId, commissionId: origin.commissionId, proposalId: origin.proposalId, proposalRevision: last.proposalRevision + 1, event: 'applied', actorType: 'system', actorId: owner, basis: origin.basis, reason: 'User confirmed the account strategy combination', policyContext: { policyRevision, decisionId: origin.id, allocations: allocations.map(a => ({ strategyId: a.strategyId, strategyRevision: a.strategyRevision, allocationPct: a.allocationPct, enabled: a.enabled })) }, requestKey });
        for (const allocation of allocations)
            if (origin.commissionId)
                await tx.insert(teamResearchLinks).values({ ownerId: owner, teamId: origin.teamId, commissionId: origin.commissionId, kind: 'strategy_revision', targetId: allocation.strategyId, targetRevision: String(allocation.strategyRevision), relation: 'executed', workKey: origin.basis.workKey, attemptId: origin.basis.acceptedAttemptId, metadata: { accountId, policyRevision, decisionId: origin.id } }).onConflictDoNothing();
    }
}
