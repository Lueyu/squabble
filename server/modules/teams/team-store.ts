import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '../../common/platform';
import { teams, teamDrafts, teamVersions, teamAccountBindings, teamRequests, teamPreviews, teamCommissions } from '../../database/teams.schema';
import { lockTeamOwner, type TeamDatabase } from '../../database/team-context';
import { paperSnapshots } from '../../database/schema';
import { canonicalHash, COMPILER_VERSION, parseTeam, teamError, uuidSchema } from './team-contract';
import { teamCapabilities, requireTeamFeature } from './team-config';
import { semanticHash } from './team-graph';
import { combineTeamCosts, readTeamCommissionCost } from './team-cost';
import type { ConfirmPreview, TeamDetail, TeamGuardSet, TeamPreview, TeamVersion, TeamBinding, TeamCostSummary } from '../../../shared/team-workspace.interface';
export type TeamRow = typeof teams.$inferSelect;
export type CommissionRow = typeof teamCommissions.$inferSelect;
export function unknownCost(currency = 'USD'): TeamCostSummary {
    return { confirmed: { amount: null, currency }, reserved: { amount: null, currency }, estimatedMaximum: { amount: null, currency }, externalUsageUnknown: false, unknownAttemptIds: [] };
}
export function versionView(row: typeof teamVersions.$inferSelect): TeamVersion { return { ...row, createdAt: row.createdAt.toISOString() }; }
export function bindingView(row: typeof teamAccountBindings.$inferSelect): TeamBinding {
    return { ...row, state: row.state as TeamBinding['state'], executionChoice: row.executionChoice as TeamBinding['executionChoice'],
        effectiveFrom: row.effectiveFrom.toISOString(), effectiveTo: row.effectiveTo?.toISOString() ?? null };
}
@Injectable()
export class TeamStore {
    constructor(
    @Inject(DRIZZLE_DATABASE)
    readonly db: PostgresJsDatabase) { }
    async team(tx: TeamDatabase, owner: string, id: string, active = false): Promise<TeamRow> {
        parseTeam(uuidSchema, id);
        const [team] = await tx.select().from(teams).where(and(eq(teams.ownerId, owner), eq(teams.id, id))).for('update');
        if (!team)
            teamError('TEAM_NOT_FOUND');
        if (active && team.status !== 'active')
            teamError('TEAM_REVISION_CONFLICT', 'Archived teams are read only');
        return team;
    }
    async mutate<T>(owner: string, teamId: string | null, operation: string, input: {
        requestKey: string;
    }, action: (tx: TeamDatabase) => Promise<T>, identity: Record<string, unknown> = {}): Promise<T> {
        if (teamId)
            parseTeam(uuidSchema, teamId);
        const { requestKey, ...body } = input;
        const inputHash = canonicalHash({ operation, teamId, ...identity, body });
        return this.db.transaction(async (tx) => {
            await lockTeamOwner(tx, owner);
            const [receipt] = await tx.select().from(teamRequests).where(and(eq(teamRequests.ownerId, owner), eq(teamRequests.requestKey, requestKey)));
            if (receipt) {
                if (receipt.inputHash !== inputHash)
                    teamError('TEAM_REQUEST_KEY_CONFLICT');
                return receipt.result as T;
            }
            if (!['commission-cancel', 'commission-recover', 'commission-budget-limit', 'source-revoke'].includes(operation))
                requireTeamFeature();
            const result = await action(tx);
            const persisted = JSON.parse(JSON.stringify(result)) as T;
            await tx.insert(teamRequests).values({ ownerId: owner, requestKey, operation, teamId, inputHash, result: persisted, httpStatus: 200 });
            return persisted;
        });
    }
    async detail(owner: string, id: string, tx: TeamDatabase = this.db): Promise<TeamDetail> {
        const team = await this.team(tx, owner, id);
        const [draft] = await tx.select().from(teamDrafts).where(and(eq(teamDrafts.ownerId, owner), eq(teamDrafts.teamId, id)));
        if (!draft)
            teamError('TEAM_REFERENCE_NOT_FOUND');
        const [version] = team.currentVersionId ? await tx.select().from(teamVersions).where(and(eq(teamVersions.ownerId, owner), eq(teamVersions.id, team.currentVersionId))) : [];
        const [binding] = await tx.select().from(teamAccountBindings).where(and(eq(teamAccountBindings.ownerId, owner), eq(teamAccountBindings.teamId, id), eq(teamAccountBindings.state, 'active')));
        const commissions = await tx.select().from(teamCommissions).where(and(eq(teamCommissions.ownerId, owner), eq(teamCommissions.teamId, id)));
        const costs: TeamCostSummary[] = [];
        for (const commission of commissions)
            costs.push(await readTeamCommissionCost(tx, commission));
        const [nav] = team.accountId ? await tx.select().from(paperSnapshots).where(and(eq(paperSnapshots.owner, owner), eq(paperSnapshots.accountId, team.accountId))).orderBy(desc(paperSnapshots.valuedAt)).limit(1) : [];
        return { ...team, status: team.status as TeamDetail['status'], semanticRevision: draft.semanticRevision,
            currentVersion: version?.version ?? null, binding: binding ? bindingView(binding) : null, roleCount: draft.config.roles.length, departmentCount: draft.config.departments.length,
            hasDraft: !version || semanticHash(draft.config) !== version.semanticHash,
            connectionCount: new Set(draft.config.roles.flatMap(role => role.executor ? [role.executor.executionMode === 'local' ? 'local:' + role.executor.localAgentId : role.executor.executionMode + ':' + role.executor.connectionId] : [])).size,
            runningCommissionCount: commissions.filter(c => ['queued', 'running', 'awaiting_review', 'cancelling', 'uncertain'].includes(c.state)).length,
            cost: combineTeamCosts(costs), equityUsd: nav?.equity ?? null, createdAt: team.createdAt.toISOString(), updatedAt: team.updatedAt.toISOString(),
            draft: { semanticRevision: draft.semanticRevision, baseVersionId: draft.baseVersionId, config: draft.config }, publishedVersion: version ? versionView(version) : null, capabilities: teamCapabilities() };
    }
    async guards(tx: TeamDatabase, team: TeamRow): Promise<TeamGuardSet> {
        const [draft] = await tx.select().from(teamDrafts).where(eq(teamDrafts.teamId, team.id));
        const [binding] = await tx.select().from(teamAccountBindings).where(and(eq(teamAccountBindings.ownerId, team.ownerId), eq(teamAccountBindings.teamId, team.id), eq(teamAccountBindings.state, 'active')));
        return { semanticRevision: draft.semanticRevision, currentVersionId: team.currentVersionId, bindingRevision: team.bindingRevision, bindingId: binding?.id ?? null,
            scopeRevision: team.scopeRevision, accountPolicyRevision: null, accountAssignmentRevision: null, capabilityFingerprint: null, sourceFingerprints: [], executorFingerprints: [] };
    }
    async preview(tx: TeamDatabase, owner: string, team: TeamRow, kind: string, payload: Record<string, unknown>, guards: TeamGuardSet, warnings: TeamPreview['warnings'] = []): Promise<TeamPreview> {
        const id = randomUUID(), expiresAt = new Date(Date.now() + 15 * 60 * 1000);
        // Round-trip JSONB before hashing, preserving PostgreSQL's actual representation.
        await tx.insert(teamPreviews).values({ id, ownerId: owner, teamId: team.id, kind, payload, guards, previewHash: 'pending', compilerVersion: COMPILER_VERSION, expiresAt });
        const [stored] = await tx.select().from(teamPreviews).where(eq(teamPreviews.id, id));
        const previewHash = canonicalHash({ kind, payload: stored.payload, guards: stored.guards, compilerVersion: COMPILER_VERSION });
        await tx.update(teamPreviews).set({ previewHash }).where(eq(teamPreviews.id, id));
        return { previewId: id, previewHash, expiresAt: expiresAt.toISOString(), compilerVersion: COMPILER_VERSION, guards: stored.guards, result: stored.payload, warnings };
    }
    async consume(tx: TeamDatabase, owner: string, team: TeamRow, kind: string, input: ConfirmPreview) {
        const [preview] = await tx.select().from(teamPreviews).where(and(eq(teamPreviews.ownerId, owner), eq(teamPreviews.teamId, team.id), eq(teamPreviews.id, input.previewId))).for('update');
        if (!preview || preview.kind !== kind)
            teamError('TEAM_REFERENCE_NOT_FOUND');
        if (preview.consumedByRequestKey)
            teamError('TEAM_PREVIEW_CONSUMED');
        if (preview.compilerVersion !== COMPILER_VERSION || preview.previewHash !== input.previewHash || preview.expiresAt.getTime() <= Date.now())
            teamError('TEAM_PREVIEW_STALE');
        const current = await this.guards(tx, team);
        for (const key of ['semanticRevision', 'currentVersionId', 'bindingRevision', 'bindingId', 'scopeRevision'] as const)
            if (current[key] !== preview.guards[key])
                teamError('TEAM_PREVIEW_STALE', 'Team authority changed', { field: key });
        await tx.update(teamPreviews).set({ consumedByRequestKey: input.requestKey }).where(eq(teamPreviews.id, preview.id));
        return preview;
    }
    revision(actual: number, expected: number): void { if (actual !== expected)
        teamError('TEAM_REVISION_CONFLICT', 'Revision changed', { actualRevision: actual }); }
}
