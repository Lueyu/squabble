import { Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { TeamStore } from '../teams/team-store';
import { TeamCommissionService } from '../teams/team-commission.service';
import { canonicalHash, confirmSchema, parseTeam, requestKeySchema, revisionSchema, teamError } from '../teams/team-contract';
import { teamAccountBindings, teamCommissions, teamRequests, teamSourceGrants } from '../../database/teams.schema';
import { teamRunAgreements, teamRunCycles, teamRunAgreementRevisions } from '../../database/team-run.schema';
import { teamAccountPolicySnapshot, pauseTeamAccountInTransaction } from '../paper-trading/team-account-transaction';
import { lockTeamOwner, type TeamDatabase } from '../../database/team-context';
import { lockMemoryOwner } from '../research-memory/research-memory.fence';
import { assertAgentRosterExecutionFence } from '../../database/agent-roster-context';
import { paperAccounts } from '../../database/schema';
import { investmentPolicies } from '../../database/investment-policy.schema';
import { compileRunCommission, teamRunInputSchema } from './team-run.rules';
import type { TeamRunAgreement, TeamRunConfiguration, TeamRunCycle, TeamRunStatus } from '../../../shared/team-run.interface';
import type { TeamMemberSnapshot, TeamPreview } from '../../../shared/team-workspace.interface';
import { isArchiveOnlyTeamRun, TEAM_RUN_ARCHIVE_ONLY_STOP } from '../../database/team-run-authority';
import type { ResearchSourceRef } from '../../../shared/team-workspace.interface';

export type AgreementRow = typeof teamRunAgreements.$inferSelect;
export type RunCycleRow = typeof teamRunCycles.$inferSelect;
export const activeCycleStates = ['reserved', 'researching', 'processing', 'uncertain'];
export function agreementView(row: AgreementRow): TeamRunAgreement {
  return { ...row, state: row.state as TeamRunAgreement['state'], confirmedAt: row.confirmedAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
    externalCostUnknown: row.configuration.budget.perRun.budgetMode === 'calls_only' || row.members.some(member => member.executor.executionMode !== 'model') };
}
export function cycleView(row: RunCycleRow): TeamRunCycle {
  return { ...row, state: row.state as TeamRunCycle['state'], createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
}

/** Agreement authoring never dispatches research; start only enables the durable scheduler. */
@Injectable()
export class TeamRunService {
  constructor(readonly store: TeamStore, private readonly commissions: TeamCommissionService) {}
  private async recordRevision(tx: TeamDatabase, row: AgreementRow): Promise<void> {
    await tx.insert(teamRunAgreementRevisions).values({ ownerId: row.ownerId, agreementId: row.id, revision: row.revision, state: row.state,
      accountId: row.accountId, configuration: row.configuration, members: row.members, scopeRevision: row.scopeRevision,
      confirmedBy: row.confirmedBy, confirmedAt: row.confirmedAt, suspensionReason: row.suspensionReason });
  }
  private async pauseLiveAccount(tx: TeamDatabase, owner: string, accountId: string): Promise<void> {
    const [account] = await tx.select().from(paperAccounts).where(and(eq(paperAccounts.owner, owner), eq(paperAccounts.id, accountId))).for('update');
    const [policy] = await tx.select().from(investmentPolicies).where(and(eq(investmentPolicies.owner, owner), eq(investmentPolicies.accountId, accountId)));
    // Archive already closes the account. It must still be possible to suspend its old agreement after the binding is released.
    if (account?.isActive && policy?.status !== 'archived') await pauseTeamAccountInTransaction(tx, owner, accountId);
  }
  async row(tx: TeamDatabase, owner: string, teamId: string) {
    await this.store.team(tx, owner, teamId);
    const [row] = await tx.select().from(teamRunAgreements).where(and(eq(teamRunAgreements.ownerId, owner), eq(teamRunAgreements.teamId, teamId))).for('update');
    return row ?? null;
  }
  async status(owner: string, teamId: string): Promise<TeamRunStatus> {
    const agreement = await this.row(this.store.db, owner, teamId);
    const cycles = await this.store.db.select().from(teamRunCycles).where(and(eq(teamRunCycles.ownerId, owner), eq(teamRunCycles.teamId, teamId))).orderBy(desc(teamRunCycles.createdAt)).limit(30);
    return { agreement: agreement ? agreementView(agreement) : null, recentCycles: cycles.map(cycleView) };
  }
  async preview(owner: string, teamId: string, input: unknown) {
    const request = parseTeam(teamRunInputSchema, input), { requestKey, ...configuration } = request;
    const [prior] = await this.store.db.select().from(teamRequests).where(and(eq(teamRequests.ownerId, owner), eq(teamRequests.requestKey, requestKey)));
    if (prior) {
      if (prior.inputHash !== canonicalHash({ operation: 'run-preview', teamId, body: configuration })) teamError('TEAM_REQUEST_KEY_CONFLICT');
      return prior.result as TeamPreview;
    }
    const detail = await this.store.detail(owner, teamId);
    if (!detail.publishedVersion || detail.currentVersionId !== request.teamVersionId) teamError('TEAM_PREVIEW_STALE');
    const roles = detail.publishedVersion.config.roles.filter(role => role.participation === 'enabled');
    if (roles.some(role => !role.agentId || !role.agentVersionId)) teamError('TEAM_REAPPROVAL_REQUIRED', 'Assign a persistent friend to every enabled role before automatic runs');
    // Reuse the actual bounded-commission preview for source, executor, budget and account authorization checks.
    const commission = await this.commissions.preview(owner, teamId, compileRunCommission(detail.publishedVersion.config, configuration, 'run-probe:' + randomUUID(), new Date()));
    return this.store.mutate(owner, teamId, 'run-preview', request, async tx => {
      const team = await this.store.team(tx, owner, teamId, true);
      const guards = await this.store.guards(tx, team);
      for (const field of ['currentVersionId', 'bindingRevision', 'bindingId', 'scopeRevision'] as const)
        if (guards[field] !== commission.guards[field]) teamError('TEAM_PREVIEW_STALE');
      return this.store.preview(tx, owner, team, 'run-agreement', { configuration, accountId: commission.result.accountId, members: commission.result.members }, commission.guards,
        [...commission.warnings, { code: 'TEAM_RUN_REPLACES_COMBINATION', message: 'Every executable cycle replaces this paper account combination at the authorized allocation; user drafts are preserved.' },
          ...(request.budget.perRun.budgetMode === 'calls_only' ? [{ code: 'TEAM_EXTERNAL_COST_UNKNOWN', message: 'External charges are unknown. Finite call limits and conservative monetary reservations apply; actual external fees cannot be guaranteed.' }] : [])]);
    });
  }
  async confirm(owner: string, teamId: string, input: unknown) {
    const request = parseTeam(confirmSchema, input);
    return this.store.mutate(owner, teamId, 'run-confirm', request, async tx => {
      const team = await this.store.team(tx, owner, teamId, true), preview = await this.store.consume(tx, owner, team, 'run-agreement', request);
      const configuration = preview.payload.configuration as TeamRunConfiguration, members = preview.payload.members as TeamMemberSnapshot[], accountId = String(preview.payload.accountId);
      const account = await teamAccountPolicySnapshot(tx, owner, accountId);
      if (account.revision === null) teamError('TEAM_REAPPROVAL_REQUIRED', 'Adopt an account policy before authorizing autonomous paper execution');
      if (account.revision !== preview.guards.accountPolicyRevision) teamError('TEAM_PREVIEW_STALE');
      for (const member of members) await assertAgentRosterExecutionFence(tx, owner, [member], { allowedToolIds: member.allowedToolIds });
      const previous = await this.row(tx, owner, teamId);
      const active = await tx.select().from(teamRunCycles).where(and(eq(teamRunCycles.ownerId, owner), eq(teamRunCycles.teamId, teamId), inArray(teamRunCycles.state, activeCycleStates)));
      if (active.length) teamError('TEAM_EXECUTION_UNCERTAIN', 'Settle or cancel the existing cycle before changing standing authority');
      const value = { ownerId: owner, teamId, accountId, configuration, members, scopeRevision: team.scopeRevision, revision: (previous?.revision ?? 0) + 1,
        state: 'confirmed', confirmedBy: owner, confirmedAt: new Date(), updatedAt: new Date(), suspensionReason: null };
      const [saved] = previous ? await tx.update(teamRunAgreements).set(value).where(eq(teamRunAgreements.id, previous.id)).returning()
        : await tx.insert(teamRunAgreements).values(value).returning();
      await this.recordRevision(tx, saved);
      return agreementView(saved);
    });
  }
  async control(owner: string, teamId: string, kind: 'start' | 'pause' | 'resume', input: unknown) {
    const request = parseTeam(z.object({ requestKey: requestKeySchema, expectedRevision: revisionSchema }).strict(), input);
    const result = await this.store.mutate(owner, teamId, 'run-' + kind, request, async tx => {
      const row = await this.row(tx, owner, teamId);
      if (!row) teamError('TEAM_REFERENCE_NOT_FOUND');
      this.store.revision(row.revision, request.expectedRevision);
      if (kind !== 'pause') {
        if (row.state === 'suspended') teamError('TEAM_REAPPROVAL_REQUIRED');
        if (kind === 'start' && row.state !== 'confirmed' || kind === 'resume' && row.state !== 'paused') teamError('TEAM_REVISION_CONFLICT');
        if (await this.authorityChanged(tx, row)) teamError('TEAM_REAPPROVAL_REQUIRED');
        const active = await tx.select().from(teamRunCycles).where(and(eq(teamRunCycles.agreementId, row.id), inArray(teamRunCycles.state, activeCycleStates)));
        if (active.length) teamError('TEAM_EXECUTION_UNCERTAIN');
      }
      const [saved] = await tx.update(teamRunAgreements).set({ revision: row.revision + 1, state: kind === 'pause' ? 'paused' : 'running', updatedAt: new Date() }).where(eq(teamRunAgreements.id, row.id)).returning();
      await this.recordRevision(tx, saved);
      if (kind === 'pause') {
        // TeamStore acquires the same memory-owner row before the team advisory lock. No gap can admit a final apply.
        await this.pauseLiveAccount(tx, owner, row.accountId);
        await tx.update(teamRunCycles).set({ state: 'cancelled', lastError: 'Standing agreement paused', updatedAt: new Date() })
          .where(and(eq(teamRunCycles.agreementId, row.id), eq(teamRunCycles.state, 'reserved'), sql`${teamRunCycles.commissionId} IS NULL`));
      }
      return agreementView(saved);
    });
    if (kind === 'pause') await this.cancelInactive(owner, teamId);
    return result;
  }
  private async authorityChange(tx: TeamDatabase, row: AgreementRow): Promise<'unchanged' | 'archive_only' | 'revoked'> {
    const team = await this.store.team(tx, row.ownerId, row.teamId);
    const [binding] = await tx.select().from(teamAccountBindings).where(and(eq(teamAccountBindings.ownerId, row.ownerId), eq(teamAccountBindings.id, row.configuration.bindingId)));
    if (team.status !== 'active' || team.currentVersionId !== row.configuration.teamVersionId || team.bindingRevision !== row.configuration.expectedBindingRevision
      || team.scopeRevision !== row.scopeRevision || !binding || binding.state !== 'active' || binding.accountId !== row.accountId) return 'revoked';
    const grants = await tx.select().from(teamSourceGrants).where(and(eq(teamSourceGrants.ownerId, row.ownerId), eq(teamSourceGrants.teamId, row.teamId), eq(teamSourceGrants.state, 'active')));
    let archived = false;
    for (const member of row.members) {
      const selected = member.sourceGrantIds.map(id => grants.find(grant => grant.id === id));
      if (selected.some(grant => !grant)) return 'revoked';
      const options = { allowedToolIds: member.allowedToolIds, sourceRefs: selected.map(grant => ({ kind: grant!.sourceKind as ResearchSourceRef['kind'],
        id: grant!.sourceId, revision: grant!.sourceRevision, availability: 'available' as const })) };
      try { await assertAgentRosterExecutionFence(tx, row.ownerId, [member], options); }
      catch (error) {
        const response = error && typeof error === 'object' && 'getResponse' in error && typeof error.getResponse === 'function'
          ? error.getResponse() as { code?: string } : undefined;
        if (response?.code !== 'AGENT_ARCHIVED') return 'revoked';
        try { await assertAgentRosterExecutionFence(tx, row.ownerId, [member], { ...options, allowArchivedSettlement: true }); }
        catch { return 'revoked'; }
        archived = true;
      }
    }
    return archived ? 'archive_only' : 'unchanged';
  }
  async authorityChanged(tx: TeamDatabase, row: AgreementRow): Promise<boolean> {
    return await this.authorityChange(tx, row) !== 'unchanged';
  }
  async reconcileAuthority(row: AgreementRow): Promise<void> {
    if (!['running', 'confirmed'].includes(row.state) && !isArchiveOnlyTeamRun(row)) return;
    await this.store.db.transaction(async tx => {
      await lockMemoryOwner(tx, row.ownerId); await lockTeamOwner(tx, row.ownerId);
      const current = await this.row(tx, row.ownerId, row.teamId);
      if (!current || !['running', 'confirmed'].includes(current.state) && !isArchiveOnlyTeamRun(current)) return;
      const change = await this.authorityChange(tx, current);
      if (change === 'unchanged' || isArchiveOnlyTeamRun(current) && change === 'archive_only') return;
      const [saved] = await tx.update(teamRunAgreements).set({ state: 'suspended', revision: current.revision + 1,
        suspensionReason: change === 'archive_only' ? TEAM_RUN_ARCHIVE_ONLY_STOP : 'Team version, binding, source scope or friend authority changed', updatedAt: new Date() }).where(eq(teamRunAgreements.id, current.id)).returning();
      await this.recordRevision(tx, saved);
      // The old account remains stopped even when a handover has already changed the active binding.
      await this.pauseLiveAccount(tx, row.ownerId, current.accountId);
      await tx.update(teamRunCycles).set({ state: 'cancelled', lastError: 'Standing agreement suspended', updatedAt: new Date() })
        .where(and(eq(teamRunCycles.agreementId, current.id), eq(teamRunCycles.state, 'reserved'), sql`${teamRunCycles.commissionId} IS NULL`));
    });
  }
  /** Reconcile cancellation through the existing durable commission command. Unknown dispatch remains reserved. */
  async cancelInactive(owner: string, teamId: string): Promise<void> {
    const agreement = await this.row(this.store.db, owner, teamId);
    if (!agreement || ['running', 'confirmed'].includes(agreement.state) || isArchiveOnlyTeamRun(agreement)) return;
    const rows = await this.store.db.select().from(teamCommissions).where(and(eq(teamCommissions.ownerId, owner), eq(teamCommissions.teamId, teamId),
      inArray(teamCommissions.state, ['queued', 'running', 'awaiting_review', 'partial', 'blocked', 'failed', 'uncertain'])));
    for (const row of rows) {
      if (row.cancelRequestedAt && row.state === 'uncertain') continue;
      try { await this.commissions.control(owner, teamId, row.id, 'cancel', { requestKey: 'run-pause:' + agreement.id + ':' + agreement.revision + ':' + row.id,
        expectedCommissionRevision: row.commissionRevision, reason: 'Standing paper-team authority is paused or suspended' }); }
      catch { /* The next durable scheduler pass observes an advanced revision and retries cancellation only. */ }
    }
  }
}
