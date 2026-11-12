import { and, eq, inArray } from 'drizzle-orm';
import { NotFoundException, ConflictException } from '@nestjs/common';
import { paperAccounts, paperOrders, builderProfiles } from '../../database/schema';
import { investmentPolicies } from '../../database/investment-policy.schema';
import { portfolioStrategyAssignments } from '../../database/portfolio-workspace.schema';
import { strategyMandates } from '../../database/strategy-mandates.schema';
import { teamDecisions } from '../../database/teams.schema';
import type { TeamDatabase } from '../../database/team-context';
import { cancelInvestmentCandidates } from './investment-policy.service';
export async function teamAccountPolicySnapshot(tx: TeamDatabase, owner: string, accountId: string) {
    const [account] = await tx.select().from(paperAccounts).where(and(eq(paperAccounts.owner, owner), eq(paperAccounts.id, accountId))).for('update');
    if (!account)
        throw new NotFoundException('TEAM_REFERENCE_NOT_FOUND');
    const [policy] = await tx.select().from(investmentPolicies).where(and(eq(investmentPolicies.owner, owner), eq(investmentPolicies.accountId, accountId))).for('update');
    if (!account.isActive || policy?.status === 'archived')
        throw new ConflictException('TEAM_BINDING_CONFLICT');
    const assignments = await tx.select().from(portfolioStrategyAssignments).where(and(eq(portfolioStrategyAssignments.owner, owner), eq(portfolioStrategyAssignments.accountId, accountId)));
    const pending = await tx.select().from(teamDecisions).where(and(eq(teamDecisions.ownerId, owner), eq(teamDecisions.accountId, accountId)));
    const orders = await tx.select().from(paperOrders).where(and(eq(paperOrders.owner, owner), eq(paperOrders.accountId, accountId), inArray(paperOrders.status, ['pending', 'pending_approval', 'approved'])));
    return { revision: policy?.revision ?? null, assignmentRevision: policy?.revision ?? null,
        policySnapshot: { policy: policy ? { id: policy.id, revision: policy.revision, status: policy.status, baseConfig: policy.baseConfig, effectiveConfig: policy.effectiveConfig, constraintRecords: policy.constraintRecords, confirmedAt: policy.confirmedAt.toISOString() } : null, assignments, orders },
        pending: pending.filter(d => ['propose', 'observe', 'defer', 'adopt'].includes(d.event) && !pending.some(x => x.proposalId === d.proposalId && x.proposalRevision > d.proposalRevision)),
        confirmed: pending.filter(d => d.event === 'applied' && (policy?.baseConfig.teamDecisionRefs ?? []).some(ref => ref.decisionId === d.policyContext?.decisionId) && !pending.some(x => x.proposalId === d.proposalId && x.proposalRevision > d.proposalRevision && x.event === 'applied')),
        account: { id: account.id, name: account.name, cashBalance: account.cashBalance } };
}
export async function pauseTeamAccountInTransaction(tx: TeamDatabase, owner: string, accountId: string): Promise<Record<string, unknown>> {
    const snapshot = await teamAccountPolicySnapshot(tx, owner, accountId);
    await cancelInvestmentCandidates(tx, owner, accountId, 'Team handover paused all automation including protective orders');
    await tx.update(paperOrders).set({ status: 'cancelled', reason: 'Team authority paused all account orders including protective orders' })
        .where(and(eq(paperOrders.owner, owner), eq(paperOrders.accountId, accountId), inArray(paperOrders.status, ['pending', 'pending_approval', 'approved'])));
    await tx.update(paperAccounts).set({ botEnabled: false, updatedAt: new Date() }).where(and(eq(paperAccounts.owner, owner), eq(paperAccounts.id, accountId)));
    await tx.update(builderProfiles).set({ status: 'paused', updatedAt: new Date() }).where(and(eq(builderProfiles.owner, owner), eq(builderProfiles.accountId, accountId), eq(builderProfiles.status, 'active')));
    await tx.update(strategyMandates).set({ status: 'paused', updatedAt: new Date() }).where(and(eq(strategyMandates.owner, owner), eq(strategyMandates.accountId, accountId), eq(strategyMandates.status, 'published')));
    if (snapshot.revision !== null)
        await tx.update(investmentPolicies).set({ status: 'paused', revision: snapshot.revision + 1, updatedAt: new Date() }).where(and(eq(investmentPolicies.owner, owner), eq(investmentPolicies.accountId, accountId)));
    return { ...snapshot.policySnapshot, paused: true };
}
