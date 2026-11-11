import { Injectable } from '@nestjs/common';
import { and, desc, eq, sql, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { teams, teamDrafts, teamVersions, teamAccountBindings, teamCommissions, teamDecisions } from '../../database/teams.schema';
import { TeamStore, bindingView, versionView } from './team-store';
import { TeamRuntimeAdapter } from './team-runtime-adapter';
import { canonicalHash, confirmSchema, parseTeam, requestKeySchema, revisionSchema, teamError, uuidSchema } from './team-contract';
import { validateTeamGraph, semanticHash } from './team-graph';
import { teamAccountPolicySnapshot, pauseTeamAccountInTransaction } from '../paper-trading/team-account-transaction';
import type { TeamDatabase } from '../../database/team-context';
const executionChoice = z.enum(['keep_confirmed_rules', 'pause_all']);
@Injectable()
export class TeamVersionService {
    constructor(private readonly store: TeamStore, private readonly runtime: TeamRuntimeAdapter) { }
    private async inflight(tx: TeamDatabase, owner: string, scope: {
        accountId?: string;
        teamId?: string;
    }) {
        const rows = await tx.select().from(teamCommissions).where(and(eq(teamCommissions.ownerId, owner), scope.accountId ? eq(teamCommissions.accountId, scope.accountId) : undefined, scope.teamId ? eq(teamCommissions.teamId, scope.teamId) : undefined, inArray(teamCommissions.state, ['queued', 'running', 'awaiting_review', 'blocked', 'uncertain', 'cancelling'])));
        return rows.sort((a, b) => a.id.localeCompare(b.id)).map(row => ({ id: row.id, teamId: row.teamId, accountId: row.accountId, state: row.state, teamVersionId: row.teamVersionId, objective: row.plan.objective,
            handoverEffect: 'stop_new_work_settle_dispatched', canRequestCancellation: true }));
    }
    async check(owner: string, id: string, input: unknown) {
        const request = parseTeam(z.object({ requestKey: requestKeySchema, semanticRevision: revisionSchema, roleIds: z.array(uuidSchema).max(30) }).strict(), input);
        return this.store.mutate(owner, id, 'connection-check', request, async (tx) => {
            const team = await this.store.detail(owner, id, tx);
            this.store.revision(team.semanticRevision, request.semanticRevision);
            const roles = team.draft.config.roles.filter(r => request.roleIds.includes(r.id));
            if (roles.length !== new Set(request.roleIds).size)
                teamError('TEAM_REFERENCE_NOT_FOUND');
            return { items: await this.runtime.check(tx, owner, roles), requestKey: request.requestKey };
        });
    }
    async publishPreview(owner: string, id: string, input: unknown) {
        const request = parseTeam(z.object({ requestKey: requestKeySchema, expectedSemanticRevision: revisionSchema }).strict(), input);
        return this.store.mutate(owner, id, 'publish-preview', request, async (tx) => {
            const team = await this.store.team(tx, owner, id, true);
            const [draft] = await tx.select().from(teamDrafts).where(eq(teamDrafts.teamId, id));
            this.store.revision(draft.semanticRevision, request.expectedSemanticRevision);
            validateTeamGraph(draft.config);
            const warnings = draft.config.roles.filter(r => r.participation === 'placeholder').map(r => ({ code: 'TEAM_ROLE_PLACEHOLDER', message: 'Placeholder role is excluded from execution', roleId: r.id }));
            return { ...await this.store.preview(tx, owner, team, 'publish', { config: draft.config, displaySnapshot: team.display, semanticRevision: draft.semanticRevision, semanticHash: semanticHash(draft.config) }, await this.store.guards(tx, team), warnings), requestKey: request.requestKey };
        });
    }
    async publish(owner: string, id: string, input: unknown) {
        const request = parseTeam(confirmSchema, input);
        return this.store.mutate(owner, id, 'publish', request, async (tx) => {
            const team = await this.store.team(tx, owner, id, true), preview = await this.store.consume(tx, owner, team, 'publish', request);
            const [draft] = await tx.select().from(teamDrafts).where(eq(teamDrafts.teamId, id));
            validateTeamGraph(draft.config);
            const [last] = await tx.select().from(teamVersions).where(and(eq(teamVersions.ownerId, owner), eq(teamVersions.teamId, id))).orderBy(desc(teamVersions.version)).limit(1);
            const hash = semanticHash(draft.config);
            const version = last?.semanticHash === hash ? last : (await tx.insert(teamVersions).values({ ownerId: owner, teamId: id, version: (last?.version ?? 0) + 1, semanticRevision: draft.semanticRevision, semanticHash: hash, config: draft.config, displaySnapshot: preview.payload.displaySnapshot as typeof team.display, createdBy: owner }).returning())[0];
            await tx.update(teams).set({ currentVersionId: version.id, updatedAt: new Date() }).where(eq(teams.id, id));
            await tx.update(teamDrafts).set({ baseVersionId: version.id }).where(eq(teamDrafts.teamId, id));
            return { version: versionView(version), team: await this.store.detail(owner, id, tx), requestKey: request.requestKey };
        });
    }
    async bindingPreview(owner: string, id: string, input: unknown) {
        const request = parseTeam(z.object({ requestKey: requestKeySchema, action: z.enum(['assign', 'release']), accountId: uuidSchema, teamVersionId: uuidSchema, expectedBindingRevision: revisionSchema, expectedAccountBindingId: uuidSchema.nullable(), executionChoice, acknowledgePendingReapproval: z.literal(true) }).strict(), input);
        return this.store.mutate(owner, id, 'binding-preview', request, async (tx) => {
            const team = await this.store.team(tx, owner, id, true);
            this.store.revision(team.bindingRevision, request.expectedBindingRevision);
            const [version] = await tx.select().from(teamVersions).where(and(eq(teamVersions.ownerId, owner), eq(teamVersions.teamId, id), eq(teamVersions.id, request.teamVersionId)));
            if (!version)
                teamError('TEAM_REFERENCE_NOT_FOUND');
            const [old] = await tx.select().from(teamAccountBindings).where(and(eq(teamAccountBindings.ownerId, owner), eq(teamAccountBindings.accountId, request.accountId), eq(teamAccountBindings.state, 'active')));
            if ((old?.id ?? null) !== request.expectedAccountBindingId)
                teamError('TEAM_BINDING_CONFLICT');
            if (request.action === 'release' && (!old || old.teamId !== id))
                teamError('TEAM_BINDING_CONFLICT');
            if (request.action === 'assign' && team.accountId && team.accountId !== request.accountId)
                teamError('TEAM_BINDING_CONFLICT', 'Release the old account first');
            const snapshot = await teamAccountPolicySnapshot(tx, owner, request.accountId), guards = await this.store.guards(tx, team);
            const inflightCommissions = await this.inflight(tx, owner, { accountId: request.accountId });
            guards.accountPolicyRevision = snapshot.revision;
            guards.accountAssignmentRevision = snapshot.assignmentRevision;
            return { ...await this.store.preview(tx, owner, team, 'binding', { ...request, previousBinding: old ? bindingView(old) : null, policySnapshot: snapshot.policySnapshot, inflightCommissions, pendingReapproval: snapshot.pending.map(d => ({ id: d.id, proposalId: d.proposalId, proposalRevision: d.proposalRevision })) }, guards), requestKey: request.requestKey };
        });
    }
    private async applyBinding(tx: TeamDatabase, owner: string, team: Awaited<ReturnType<TeamStore['team']>>, payload: Record<string, unknown>, kind: 'binding' | 'archive', requestKey: string) {
        const accountId = String(payload.accountId), choice = String(payload.executionChoice);
        const snapshot = await teamAccountPolicySnapshot(tx, owner, accountId);
        const currentInflight = await this.inflight(tx, owner, kind === 'archive' ? { teamId: team.id } : { accountId });
        const savedInflight = payload.inflightCommissions as {
            id: string;
        }[] | undefined;
        if (canonicalHash(currentInflight.map(row => row.id)) !== canonicalHash((savedInflight ?? []).map(row => row.id)))
            teamError('TEAM_PREVIEW_STALE', 'In-flight commissions changed');
        const pending = (payload.pendingReapproval ?? []) as {
            id: string;
            proposalId: string;
            proposalRevision: number;
        }[];
        const identity = (rows: {
            id: string;
            proposalId: string;
            proposalRevision: number;
        }[]) => rows.map(row => ({ id: row.id, proposalId: row.proposalId, proposalRevision: row.proposalRevision })).sort((a, b) => a.id.localeCompare(b.id));
        if (canonicalHash(identity(snapshot.pending)) !== canonicalHash(identity(pending)))
            teamError('TEAM_PREVIEW_STALE', 'Pending proposals changed');
        const [old] = await tx.select().from(teamAccountBindings).where(and(eq(teamAccountBindings.ownerId, owner), eq(teamAccountBindings.accountId, accountId), eq(teamAccountBindings.state, 'active'))).for('update');
        if ((old?.id ?? null) !== (payload.expectedAccountBindingId ?? null))
            teamError('TEAM_PREVIEW_STALE');
        if (old) {
            await tx.update(teamAccountBindings).set({ state: kind === 'archive' ? 'archived' : payload.action === 'release' ? 'released' : 'superseded', effectiveTo: sql `greatest(clock_timestamp(),${teamAccountBindings.effectiveFrom})`, updatedAt: new Date() }).where(eq(teamAccountBindings.id, old.id));
            if (old.teamId !== team.id)
                await tx.update(teams).set({ accountId: null, bindingRevision: (await this.store.team(tx, owner, old.teamId)).bindingRevision + 1, updatedAt: new Date() }).where(eq(teams.id, old.teamId));
            await tx.update(teamCommissions).set({ state: 'blocked', lastError: { code: 'TEAM_BINDING_CONFLICT' }, updatedAt: new Date() }).where(and(eq(teamCommissions.ownerId, owner), eq(teamCommissions.bindingId, old.id), eq(teamCommissions.state, 'queued')));
        }
        for (const decision of snapshot.pending) {
            await tx.insert(teamDecisions).values({ ownerId: owner, teamId: decision.teamId, accountId, commissionId: decision.commissionId, proposalId: decision.proposalId, proposalRevision: decision.proposalRevision + 1, event: 'requires_reapproval', actorType: 'system', actorId: owner, basis: decision.basis, reason: 'Account responsibility changed; pending proposal requires new approval', requestKey });
        }
        let binding: typeof teamAccountBindings.$inferSelect | null = null;
        if (kind === 'binding' && payload.action === 'assign') {
            [binding] = await tx.insert(teamAccountBindings).values({ ownerId: owner, teamId: team.id, accountId, bindingRevision: team.bindingRevision + 1, teamVersionId: String(payload.teamVersionId), state: 'active', effectiveFrom: sql `clock_timestamp()`, previousBindingId: old?.id ?? null, executionChoice: choice, policySnapshot: snapshot.policySnapshot }).returning();
        }
        if (choice === 'pause_all')
            await pauseTeamAccountInTransaction(tx, owner, accountId);
        else
            for (const prior of snapshot.confirmed) {
                // Continuation belongs to the old approval and never reassigns its provenance.
                const [last] = await tx.select().from(teamDecisions).where(and(eq(teamDecisions.ownerId, owner), eq(teamDecisions.proposalId, prior.proposalId))).orderBy(desc(teamDecisions.proposalRevision)).limit(1);
                await tx.insert(teamDecisions).values({ ownerId: owner, teamId: prior.teamId, accountId, commissionId: prior.commissionId, proposalId: prior.proposalId, proposalRevision: last.proposalRevision + 1, event: 'continue_policy', actorType: 'system', actorId: owner, basis: prior.basis, reason: 'Explicit handover keeps previously confirmed policy', policyContext: snapshot.policySnapshot, requestKey });
            }
        await tx.update(teams).set({ accountId: binding ? accountId : null, bindingRevision: team.bindingRevision + 1, updatedAt: new Date() }).where(eq(teams.id, team.id));
        return binding;
    }
    async binding(owner: string, id: string, input: unknown) {
        const request = parseTeam(confirmSchema, input);
        return this.store.mutate(owner, id, 'binding', request, async (tx) => {
            const team = await this.store.team(tx, owner, id, true), preview = await this.store.consume(tx, owner, team, 'binding', request);
            const snapshot = await teamAccountPolicySnapshot(tx, owner, String(preview.payload.accountId));
            if (snapshot.revision !== preview.guards.accountPolicyRevision)
                teamError('TEAM_PREVIEW_STALE');
            const binding = await this.applyBinding(tx, owner, team, preview.payload, 'binding', request.requestKey);
            return { team: await this.store.detail(owner, id, tx), binding: binding ? bindingView(binding) : null, requestKey: request.requestKey };
        });
    }
    async archivePreview(owner: string, id: string, input: unknown) {
        const request = parseTeam(z.object({ requestKey: requestKeySchema, expectedBindingRevision: revisionSchema, expectedCurrentVersionId: uuidSchema.nullable(), executionChoice: executionChoice.optional() }).strict(), input);
        return this.store.mutate(owner, id, 'archive-preview', request, async (tx) => {
            const team = await this.store.team(tx, owner, id, true);
            this.store.revision(team.bindingRevision, request.expectedBindingRevision);
            if (team.currentVersionId !== request.expectedCurrentVersionId)
                teamError('TEAM_REVISION_CONFLICT');
            const guards = await this.store.guards(tx, team);
            if (team.accountId && !request.executionChoice)
                teamError('TEAM_INVALID_INPUT', 'Choose whether confirmed rules continue');
            const snapshot = team.accountId ? await teamAccountPolicySnapshot(tx, owner, team.accountId) : null;
            const inflightCommissions = await this.inflight(tx, owner, { teamId: id });
            if (snapshot) {
                guards.accountPolicyRevision = snapshot.revision;
                guards.accountAssignmentRevision = snapshot.assignmentRevision;
            }
            return { ...await this.store.preview(tx, owner, team, 'archive', { ...request, accountId: team.accountId, expectedAccountBindingId: guards.bindingId, policySnapshot: snapshot?.policySnapshot ?? null, pendingReapproval: snapshot?.pending ?? [], inflightCommissions }, guards), requestKey: request.requestKey };
        });
    }
    async archive(owner: string, id: string, input: unknown) {
        const request = parseTeam(confirmSchema, input);
        return this.store.mutate(owner, id, 'archive', request, async (tx) => {
            const team = await this.store.team(tx, owner, id, true), preview = await this.store.consume(tx, owner, team, 'archive', request);
            if (!team.accountId) {
                const inflight = await this.inflight(tx, owner, { teamId: id });
                if (canonicalHash(inflight.map(row => row.id)) !== canonicalHash(((preview.payload.inflightCommissions ?? []) as {
                    id: string;
                }[]).map(row => row.id)))
                    teamError('TEAM_PREVIEW_STALE', 'In-flight commissions changed');
            }
            if (team.accountId) {
                const snapshot = await teamAccountPolicySnapshot(tx, owner, team.accountId);
                if (snapshot.revision !== preview.guards.accountPolicyRevision)
                    teamError('TEAM_PREVIEW_STALE');
                await this.applyBinding(tx, owner, team, preview.payload, 'archive', request.requestKey);
            }
            await tx.update(teams).set({ status: 'archived', updatedAt: new Date() }).where(eq(teams.id, id));
            await tx.update(teamCommissions).set({ state: 'blocked', lastError: { code: 'TEAM_SCOPE_REVOKED' }, updatedAt: new Date() }).where(and(eq(teamCommissions.ownerId, owner), eq(teamCommissions.teamId, id), eq(teamCommissions.state, 'queued')));
            return { team: await this.store.detail(owner, id, tx), binding: null, requestKey: request.requestKey };
        });
    }
}
