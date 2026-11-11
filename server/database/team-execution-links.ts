import { and, eq } from 'drizzle-orm';
import type { InvestmentConfig } from '../../shared/investment-policy.interface';
import { teamDecisions, teamResearchLinks } from './teams.schema';
import type { TeamDatabase } from './team-context';
import { councilSessions } from './council.schema';
import { councilResearchTasks } from './research-workflow.schema';

/** Called inside the same transaction that creates a signal from a confirmed policy. */
export async function recordTeamSignalLinks(tx: TeamDatabase, owner: string, config: InvestmentConfig, signalId: string): Promise<void> {
  for (const ref of config.teamDecisionRefs ?? []) {
    const [decision] = await tx.select().from(teamDecisions).where(and(eq(teamDecisions.ownerId, owner), eq(teamDecisions.id, ref.decisionId)));
    if (!decision?.commissionId) throw new Error('TEAM_REFERENCE_NOT_FOUND');
    await tx.insert(teamResearchLinks).values({ ownerId: owner, teamId: decision.teamId, commissionId: decision.commissionId,
      kind: 'signal', targetId: signalId, targetRevision: null, relation: 'executed', workKey: decision.basis.workKey,
      attemptId: decision.basis.acceptedAttemptId, metadata: { decisionId: decision.id, proposalId: decision.proposalId,
        proposalRevision: decision.proposalRevision, teamVersionId: decision.basis.teamVersionId } }).onConflictDoNothing();
  }
}

/** Copy exact existing provenance, never infer attribution from the account's current team. */
export async function copyTeamExecutionLinks(tx: TeamDatabase, owner: string, from: 'signal' | 'order', sourceId: string,
  to: 'order' | 'trade', targetId: string): Promise<void> {
  const links = await tx.select().from(teamResearchLinks).where(and(eq(teamResearchLinks.ownerId, owner),
    eq(teamResearchLinks.kind, from), eq(teamResearchLinks.targetId, sourceId)));
  for (const link of links) await tx.insert(teamResearchLinks).values({ ownerId: owner, teamId: link.teamId,
    commissionId: link.commissionId, kind: to, targetId, targetRevision: null, relation: 'executed',
    workKey: link.workKey, attemptId: link.attemptId, metadata: { ...link.metadata, sourceKind: from, sourceId } }).onConflictDoNothing();
}

/** A thesis version is linked in its creation transaction, even if archival finishes after the commission. */
export async function recordTeamThesisVersionLink(tx: TeamDatabase, owner: string,
  report: { id: string; sessionId: string; researchVersionId?: string | null;
    coverage?: { tasks: Array<{ id: string; key: string; acceptedAttemptId: string | null }> } | null },
  thesisId: string, versionId: string, version: number, actor: 'agent' | 'user'): Promise<void> {
  const [session] = await tx.select().from(councilSessions).where(and(eq(councilSessions.owner, owner), eq(councilSessions.id, report.sessionId)));
  const context = session?.teamContext ?? session?.checkpoint?.teamContext;
  if (!context) return;
  const accepted = report.coverage?.tasks.find(task => task.key === 'summary' && task.acceptedAttemptId);
  if (!accepted) throw new Error('TEAM_REFERENCE_NOT_FOUND');
  const [task] = await tx.select().from(councilResearchTasks).where(and(eq(councilResearchTasks.owner, owner), eq(councilResearchTasks.id, accepted.id)));
  if (!task?.workKey || !task.attempts.some(attempt => attempt.id === accepted.acceptedAttemptId && attempt.state === 'succeeded')) throw new Error('TEAM_REFERENCE_NOT_FOUND');
  await tx.insert(teamResearchLinks).values({ ownerId: owner, teamId: context.teamId, commissionId: context.commissionId,
    kind: 'thesis_version', targetId: versionId, targetRevision: String(version), relation: 'produced', workKey: task.workKey,
    attemptId: accepted.acceptedAttemptId, metadata: { thesisId, reportId: report.id, reportVersionId: report.researchVersionId, actor } }).onConflictDoNothing();
}
