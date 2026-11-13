import { ConflictException, NotFoundException } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { teams, teamAccountBindings } from './teams.schema';
import { teamRunAgreements, teamRunCycles, teamRunAgreementRevisions } from './team-run.schema';
import type { TeamDatabase } from './team-context';
import type { TeamRunAuthority } from '../../shared/team-run.interface';
import { assertAgentRosterExecutionFence } from './agent-roster-context';
import { teamSourceGrants } from './teams.schema';
import type { ResearchSourceRef } from '../../shared/team-workspace.interface';
import { canonicalHash } from '../common/agent-contract';
import { teamCommissions } from './teams.schema';
import { councilSessions } from './council.schema';
import { hasCouncilDispatchProof } from './council-execution-proof';

export const TEAM_RUN_ARCHIVE_ONLY_STOP = 'AGENT_ARCHIVED_SETTLEMENT_ONLY';

export interface TeamRunArchiveSnapshot { id: string; revision: number; state: string }

/** Caller holds the existing owner lock before taking agreement rows. */
export async function readTeamRunArchiveSnapshot(tx: TeamDatabase, owner: string, teamId: string): Promise<TeamRunArchiveSnapshot | null> {
  const [agreement] = await tx.select().from(teamRunAgreements)
    .where(and(eq(teamRunAgreements.ownerId, owner), eq(teamRunAgreements.teamId, teamId))).for('update');
  return agreement ? { id: agreement.id, revision: agreement.revision, state: agreement.state } : null;
}

/** Team archival revokes standing authority without deleting dispatched work or its reservations. */
export async function pauseTeamRunForArchive(tx: TeamDatabase, owner: string, teamId: string, expected: unknown): Promise<void> {
  const [agreement] = await tx.select().from(teamRunAgreements)
    .where(and(eq(teamRunAgreements.ownerId, owner), eq(teamRunAgreements.teamId, teamId))).for('update');
  const current = agreement ? { id: agreement.id, revision: agreement.revision, state: agreement.state } : null;
  if (expected === undefined || canonicalHash(current) !== canonicalHash(expected)) {
    throw new ConflictException('TEAM_PREVIEW_STALE');
  }
  if (!agreement) return;
  const [paused] = await tx.update(teamRunAgreements).set({ state: 'paused', revision: agreement.revision + 1,
    suspensionReason: 'Team archived; automatic team research stopped', updatedAt: new Date() })
    .where(and(eq(teamRunAgreements.ownerId, owner), eq(teamRunAgreements.id, agreement.id))).returning();
  await tx.insert(teamRunAgreementRevisions).values({ ownerId: owner, agreementId: paused.id,
    revision: paused.revision, state: paused.state, accountId: paused.accountId, configuration: paused.configuration,
    members: paused.members, scopeRevision: paused.scopeRevision, confirmedBy: paused.confirmedBy,
    confirmedAt: paused.confirmedAt, suspensionReason: paused.suspensionReason });
  await tx.update(teamRunCycles).set({ state: 'cancelled', lastError: 'Team archived before dispatch', updatedAt: new Date() })
    .where(and(eq(teamRunCycles.ownerId, owner), eq(teamRunCycles.agreementId, paused.id),
      eq(teamRunCycles.state, 'reserved'), sql`${teamRunCycles.commissionId} IS NULL`));
}

export function isArchiveOnlyTeamRun(row: { state: string; suspensionReason: string | null }): boolean {
  return row.state === 'suspended' && row.suspensionReason === TEAM_RUN_ARCHIVE_ONLY_STOP;
}

async function permitsPriorArchiveReceipt(tx: TeamDatabase, owner: string, agreement: typeof teamRunAgreements.$inferSelect, revision: number): Promise<boolean> {
  if (!isArchiveOnlyTeamRun(agreement) || agreement.revision !== revision + 1) return false;
  const [prior] = await tx.select().from(teamRunAgreementRevisions).where(and(eq(teamRunAgreementRevisions.ownerId, owner),
    eq(teamRunAgreementRevisions.agreementId, agreement.id), eq(teamRunAgreementRevisions.revision, revision)));
  return Boolean(prior && prior.state === 'running' && prior.accountId === agreement.accountId && prior.scopeRevision === agreement.scopeRevision
    && canonicalHash(prior.configuration) === canonicalHash(agreement.configuration) && canonicalHash(prior.members) === canonicalHash(agreement.members));
}

/** Caller holds memory-owner → team-owner locks. Recheck at the actual effect, never trust an earlier worker read. */
export async function assertTeamRunAuthority(tx: TeamDatabase, owner: string, authority: TeamRunAuthority, accountId?: string, allowUncertain = false, allowArchivedSettlement = false) {
  const [agreement] = await tx.select().from(teamRunAgreements).where(and(eq(teamRunAgreements.ownerId, owner), eq(teamRunAgreements.id, authority.agreementId))).for('update');
  const [cycle] = await tx.select().from(teamRunCycles).where(and(eq(teamRunCycles.ownerId, owner), eq(teamRunCycles.id, authority.cycleId))).for('update');
  if (!agreement || !cycle || cycle.agreementId !== agreement.id || accountId && accountId !== agreement.accountId)
    throw new NotFoundException('TEAM_REFERENCE_NOT_FOUND');
  const archiveReceipt = allowArchivedSettlement && await permitsPriorArchiveReceipt(tx, owner, agreement, authority.revision);
  if ((!archiveReceipt && (agreement.state !== 'running' || agreement.revision !== authority.revision)) || cycle.agreementRevision !== authority.revision
    || !['reserved', 'researching', 'processing', ...(allowUncertain ? ['uncertain'] : [])].includes(cycle.state)) throw new ConflictException('TEAM_SCOPE_REVOKED');
  const [team] = await tx.select().from(teams).where(and(eq(teams.ownerId, owner), eq(teams.id, agreement.teamId)));
  const [binding] = await tx.select().from(teamAccountBindings).where(and(eq(teamAccountBindings.ownerId, owner), eq(teamAccountBindings.id, agreement.configuration.bindingId)));
  if (!team || team.status !== 'active' || team.currentVersionId !== agreement.configuration.teamVersionId || team.scopeRevision !== agreement.scopeRevision
    || team.bindingRevision !== agreement.configuration.expectedBindingRevision || !binding || binding.state !== 'active' || binding.teamId !== team.id || binding.accountId !== agreement.accountId)
    throw new ConflictException('TEAM_SCOPE_REVOKED');
  const grants = await tx.select().from(teamSourceGrants).where(and(eq(teamSourceGrants.ownerId, owner), eq(teamSourceGrants.teamId, agreement.teamId), eq(teamSourceGrants.state, 'active')));
  const [commission] = allowArchivedSettlement && cycle.commissionId ? await tx.select().from(teamCommissions).where(and(eq(teamCommissions.ownerId, owner), eq(teamCommissions.id, cycle.commissionId))) : [];
  const [session] = commission?.sessionId ? await tx.select().from(councilSessions).where(and(eq(councilSessions.owner, owner), eq(councilSessions.id, commission.sessionId))) : [];
  for (const member of agreement.members) {
    const selected = member.sourceGrantIds.map(id => grants.find(grant => grant.id === id));
    if (selected.some(grant => !grant)) throw new ConflictException('TEAM_SCOPE_REVOKED');
    const dispatchedReceipt = Boolean(session && await hasCouncilDispatchProof(tx, session, member.memberId, { publication: true }));
    await assertAgentRosterExecutionFence(tx, owner, [member], { allowedToolIds: member.allowedToolIds, allowArchivedSettlement: allowArchivedSettlement && dispatchedReceipt,
      sourceRefs: selected.map(grant => ({ kind: grant!.sourceKind as ResearchSourceRef['kind'], id: grant!.sourceId, revision: grant!.sourceRevision, availability: 'available' })) });
  }
  return { agreement, cycle };
}
/** Manual commissions are unchanged. Standing authority is revoked before any new paid call or publication. */
export async function assertTeamRunCommissionAuthority(tx: TeamDatabase, owner: string, commissionId: string, dispatch = false, publication = false): Promise<void> {
  const [cycle] = await tx.select().from(teamRunCycles).where(and(eq(teamRunCycles.ownerId, owner), eq(teamRunCycles.commissionId, commissionId)));
  if (!cycle) return;
  await assertTeamRunAuthority(tx, owner, { agreementId: cycle.agreementId, revision: cycle.agreementRevision, cycleId: cycle.id }, undefined, !dispatch, publication && !dispatch);
}
