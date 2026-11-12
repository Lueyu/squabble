import { and, eq, sql } from 'drizzle-orm';
import { ConflictException, NotFoundException } from '@nestjs/common';
import type { PostgresJsDatabase } from '../common/platform';
import { teams, teamAccountBindings, teamCommissions, teamDecisions, teamSourceGrants } from './teams.schema';
import type { TeamDecisionRef, TeamExecutionContext } from '../../shared/team-workspace.interface';
import { researchMemoryPreferences } from './research-memory.schema';
import { sourceFingerprint } from './team-source-context';
import { desc } from 'drizzle-orm';
import { modelConnections } from './model-connections.schema';
import { createHash } from 'node:crypto';
import type { InvestmentConfig } from '../../shared/investment-policy.interface';
import { researchDocumentVersions } from './research-documents.schema';
import { researchThesisVersions } from './research-memory.schema';
import { assertTeamRunCommissionAuthority } from './team-run-authority';
import { assertAgentRosterExecutionFence } from './agent-roster-context';
import { readA2aConnectionFingerprint } from './a2a-agent-context';
import { councilSessions } from './council.schema';
import { hasCouncilDispatchProof } from './council-execution-proof';
export type TeamDatabase = Pick<PostgresJsDatabase, 'select' | 'insert' | 'update' | 'execute'>;
/** Owner lock serializes request receipts and all team authority changes. Acquire before entity rows. */
export async function lockTeamOwner(tx: TeamDatabase, owner: string): Promise<void> {
    await tx.insert(researchMemoryPreferences).values({ owner }).onConflictDoNothing();
    await tx.select().from(researchMemoryPreferences).where(eq(researchMemoryPreferences.owner, owner)).for('update');
    await tx.execute(sql `SELECT pg_advisory_xact_lock(hashtextextended(${owner}, 734961))`);
}
/** Old unscoped records remain compatible; a supplied team context never falls back to owner scope. */
export async function assertTeamExecutionFence(tx: TeamDatabase, owner: string, context: TeamExecutionContext | null | undefined, options: {
    allowSettlement?: boolean;
    allowPublication?: boolean;
} = {}): Promise<void> {
    if (!context)
        return;
    if (context.ownerId !== owner || context.audience !== 'team')
        throw new NotFoundException('TEAM_REFERENCE_NOT_FOUND');
    const [team] = await tx.select().from(teams).where(and(eq(teams.ownerId, owner), eq(teams.id, context.teamId)));
    const [commission] = await tx.select().from(teamCommissions).where(and(eq(teamCommissions.ownerId, owner), eq(teamCommissions.id, context.commissionId)));
    if (!team || !commission || commission.teamId !== team.id || commission.teamVersionId !== context.teamVersionId
        || commission.accountId !== context.accountId || commission.bindingId !== context.bindingId
        || commission.bindingRevision !== context.bindingRevision || commission.scopeRevision !== context.scopeRevision
        || commission.plan.deadlineAt !== context.deadlineAt || commission.plan.dataCutoffAt !== context.dataCutoffAt
        || teamCanonicalHash(commission.plan) !== teamCanonicalHash(context.plan)
        || teamCanonicalHash(commission.members) !== teamCanonicalHash(context.members)
        || teamCanonicalHash(commission.inputSnapshot) !== teamCanonicalHash(context.inputSnapshot))
        throw new NotFoundException('TEAM_REFERENCE_NOT_FOUND');
    if (options.allowSettlement)
        return;
    for (const member of context.members) {
        const [session] = options.allowPublication && commission.sessionId ? await tx.select().from(councilSessions)
            .where(and(eq(councilSessions.owner, owner), eq(councilSessions.id, commission.sessionId))) : [];
        const allowArchivedSettlement = Boolean(session && await hasCouncilDispatchProof(tx, session, member.memberId, { publication: true }));
        const grants = await tx.select().from(teamSourceGrants).where(and(eq(teamSourceGrants.ownerId, owner), eq(teamSourceGrants.teamId, context.teamId)));
        const refs = member.sourceGrantIds.map(id => grants.find(grant => grant.id === id && grant.state === 'active'));
        if (refs.some(ref => !ref)) throw new ConflictException('TEAM_SCOPE_REVOKED');
        await assertAgentRosterExecutionFence(tx, owner, [member], { allowedToolIds: member.allowedToolIds, dataCutoffAt: context.dataCutoffAt, allowArchivedSettlement,
            sourceRefs: refs.map(ref => ({ kind: ref!.sourceKind as 'report_version' | 'thesis_version' | 'document_version' | 'data_snapshot', id: ref!.sourceId, revision: ref!.sourceRevision, availability: 'available' })) });
    }
    const [binding] = await tx.select().from(teamAccountBindings).where(and(eq(teamAccountBindings.ownerId, owner), eq(teamAccountBindings.id, context.bindingId)));
    if (team.status !== 'active' || team.scopeRevision !== context.scopeRevision || team.bindingRevision !== context.bindingRevision
        || !binding || binding.state !== 'active' || binding.teamId !== team.id || binding.accountId !== context.accountId
        || commission.cancelRequestedAt || ['blocked', 'cancelled', 'cancelling', 'failed'].includes(commission.state)
        || commission.state === 'completed' && !options.allowPublication
        || Date.now() >= new Date(context.deadlineAt).getTime())
        throw new ConflictException('TEAM_SCOPE_REVOKED');
    for (const grantId of new Set(context.members.flatMap(m => m.sourceGrantIds))) {
        const [grant] = await tx.select().from(teamSourceGrants).where(and(eq(teamSourceGrants.ownerId, owner), eq(teamSourceGrants.teamId, team.id), eq(teamSourceGrants.id, grantId)));
        if (!grant || grant.state !== 'active')
            throw new ConflictException('TEAM_SCOPE_REVOKED');
        await sourceFingerprint(tx, owner, { kind: grant.sourceKind as 'report_version' | 'thesis_version' | 'document_version' | 'data_snapshot', id: grant.sourceId, revision: grant.sourceRevision, availability: 'available' }, context.dataCutoffAt);
    }
    for (const member of context.members) {
        const executor = member.executor;
        if (executor.executionMode === 'a2a') {
            const fingerprint = await readA2aConnectionFingerprint(tx, owner, executor.connectionId);
            if (!member.a2aFingerprint || teamCanonicalHash(fingerprint) !== member.executorConfigRevision
                || teamCanonicalHash(fingerprint) !== teamCanonicalHash(member.a2aFingerprint)) throw new ConflictException('TEAM_CAPABILITY_UNAVAILABLE');
            continue;
        }
        if (executor.executionMode !== 'model')
            continue;
        const [connection] = await tx.select().from(modelConnections).where(and(eq(modelConnections.owner, owner), eq(modelConnections.id, executor.connectionId)));
        if (!connection)
            throw new ConflictException('TEAM_CAPABILITY_UNAVAILABLE');
        const fingerprint = teamCanonicalHash({ id: connection.id, updatedAt: connection.updatedAt, model: executor.model, settings: executor.settings });
        if (fingerprint !== member.executorConfigRevision)
            throw new ConflictException('TEAM_CAPABILITY_UNAVAILABLE');
    }
}
function teamCanonicalHash(value: unknown): string {
    function canonical(v: unknown): unknown {
        if (v instanceof Date)
            return v.toISOString();
        if (Array.isArray(v))
            return v.map(canonical);
        if (v && typeof v === 'object')
            return Object.fromEntries(Object.entries(v).filter(([, nested]) => nested !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, nested]) => [k, canonical(nested)]));
        return v;
    }
    return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
export async function listTeamSourceGrants(tx: TeamDatabase, owner: string, teamId: string) {
    const grants = await tx.select().from(teamSourceGrants).where(and(eq(teamSourceGrants.ownerId, owner), eq(teamSourceGrants.teamId, teamId), eq(teamSourceGrants.state, 'active')));
    const visible: typeof grants = [];
    for (const grant of grants) {
        try {
            await sourceFingerprint(tx, owner, { kind: grant.sourceKind as 'report_version' | 'thesis_version' | 'document_version' | 'data_snapshot', id: grant.sourceId, revision: grant.sourceRevision, availability: 'available' });
            visible.push(grant);
        }
        catch { /* Unavailable source IDs confer no read authority. */ }
    }
    return visible;
}
export async function assertTeamExecutionInTransaction(tx: TeamDatabase, owner: string, context: TeamExecutionContext | null | undefined, options: {
    dispatch?: boolean;
    settlement?: boolean;
    publication?: boolean;
} = {}): Promise<void> {
    if (!context)
        return;
    if (options.dispatch && process.env.TEAM_RESEARCH_ENABLED !== 'true')
        throw new ConflictException('TEAM_CAPABILITY_UNAVAILABLE');
    if (options.dispatch)
        await lockTeamOwner(tx, owner);
    await assertTeamExecutionFence(tx, owner, context, { allowSettlement: options.settlement, allowPublication: options.publication });
    if (!options.settlement)
        await assertTeamRunCommissionAuthority(tx, owner, context.commissionId, options.dispatch, options.publication);
    if (!options.dispatch)
        return;
    const [commission] = await tx.select().from(teamCommissions).where(and(eq(teamCommissions.ownerId, owner), eq(teamCommissions.id, context.commissionId))).for('update');
    if (!commission)
        throw new NotFoundException('TEAM_REFERENCE_NOT_FOUND');
    const rows = await tx.execute(sql `SELECT count(*)::int AS calls FROM council_research_tasks t CROSS JOIN LATERAL jsonb_array_elements(t.attempts) a
    WHERE t.owner=${owner} AND t.session_id=${commission.sessionId}::uuid AND (a->>'dispatched')::boolean IS TRUE`);
    if (Number(rows[0]?.calls ?? 0) >= commission.budgetLimit.callLimit)
        throw new ConflictException('TEAM_BUDGET_BLOCKED');
    if (commission.budgetLimit.ceiling.amount !== null) {
        const frozenRates = commission.inputSnapshot.costRates as {
            inputUsdPerMillion: string;
            outputUsdPerMillion: string;
        } | null;
        if (!frozenRates)
            throw new ConflictException('TEAM_BUDGET_BLOCKED');
        const costs = await tx.execute(sql `SELECT s.input_usd_per_million IS NULL OR s.output_usd_per_million IS NULL AS unknown,
      s.input_usd_per_million IS DISTINCT FROM ${frozenRates.inputUsdPerMillion}::numeric OR s.output_usd_per_million IS DISTINCT FROM ${frozenRates.outputUsdPerMillion}::numeric AS rates_changed,
      coalesce((SELECT sum((u.input_tokens*s.input_usd_per_million+
        CASE WHEN u.status IN ('reserved','failed_unknown') THEN u.max_output_tokens ELSE u.output_tokens END*s.output_usd_per_million)/1000000)
        FROM llm_budget_usage u WHERE u.owner=s.owner AND u.task_id=${commission.rootBudgetTaskId}),0) > ${commission.budgetLimit.ceiling.amount}::numeric AS blocked
      FROM (SELECT ${owner}::uuid AS owner) o LEFT JOIN llm_budget_settings s ON s.owner=o.owner`);
        if (costs[0]?.unknown !== false || costs[0]?.blocked === true || costs[0]?.rates_changed === true)
            throw new ConflictException('TEAM_BUDGET_BLOCKED');
    }
}
export async function releaseTeamAccountBinding(tx: TeamDatabase, owner: string, accountId: string): Promise<void> {
    const bindings = await tx.select().from(teamAccountBindings).where(and(eq(teamAccountBindings.ownerId, owner), eq(teamAccountBindings.accountId, accountId), eq(teamAccountBindings.state, 'active'))).for('update');
    for (const binding of bindings) {
        await tx.update(teamAccountBindings).set({ state: 'archived', effectiveTo: sql `greatest(clock_timestamp(),${teamAccountBindings.effectiveFrom})`, updatedAt: new Date() }).where(eq(teamAccountBindings.id, binding.id));
        await tx.update(teams).set({ accountId: null, bindingRevision: sql `${teams.bindingRevision} + 1`, updatedAt: new Date() }).where(and(eq(teams.ownerId, owner), eq(teams.id, binding.teamId)));
        await tx.update(teamCommissions).set({ state: 'blocked', lastError: { code: 'TEAM_BINDING_CONFLICT' }, updatedAt: new Date() })
            .where(and(eq(teamCommissions.ownerId, owner), eq(teamCommissions.teamId, binding.teamId), eq(teamCommissions.state, 'queued')));
    }
}
export async function assertTeamDecisionReferences(tx: TeamDatabase, owner: string, accountId: string, refs: TeamDecisionRef[]): Promise<void> {
    for (const ref of refs) {
        const [decision] = await tx.select().from(teamDecisions).where(and(eq(teamDecisions.ownerId, owner), eq(teamDecisions.id, ref.decisionId)));
        if (!decision || decision.accountId !== accountId || decision.proposalId !== ref.proposalId || decision.proposalRevision !== ref.proposalRevision || decision.event !== 'adopt')
            throw new ConflictException('TEAM_REAPPROVAL_REQUIRED');
        const [binding] = await tx.select().from(teamAccountBindings).where(and(eq(teamAccountBindings.ownerId, owner), eq(teamAccountBindings.id, decision.basis.bindingId)));
        if (!binding || binding.state !== 'active' || binding.accountId !== accountId || binding.teamId !== decision.teamId)
            throw new ConflictException('TEAM_REAPPROVAL_REQUIRED');
    }
}
/** Confirmed rules retain their original attribution after an explicit continuation. Research deadlines do not stop protective rules. */
export async function assertConfirmedTeamPolicyAuthority(tx: TeamDatabase, owner: string, accountId: string, config: Pick<InvestmentConfig, 'teamDecisionRefs' | 'teamExecutionContexts'>): Promise<void> {
    if (!config.teamDecisionRefs?.length)
        return;
    for (const ref of config.teamDecisionRefs) {
        const [origin] = await tx.select().from(teamDecisions).where(and(eq(teamDecisions.ownerId, owner), eq(teamDecisions.id, ref.decisionId)));
        if (!origin || origin.accountId !== accountId || origin.event !== 'adopt' || origin.proposalId !== ref.proposalId || origin.proposalRevision !== ref.proposalRevision)
            throw new ConflictException('TEAM_REAPPROVAL_REQUIRED');
        const events = await tx.select().from(teamDecisions).where(and(eq(teamDecisions.ownerId, owner), eq(teamDecisions.proposalId, origin.proposalId))).orderBy(desc(teamDecisions.proposalRevision));
        const applied = events.find(event => event.event === 'applied' && event.policyContext?.decisionId === origin.id);
        if (!applied)
            throw new ConflictException('TEAM_REAPPROVAL_REQUIRED');
        const context = config.teamExecutionContexts?.find(item => item.commissionId === origin.commissionId);
        if (!context || context.ownerId !== owner || context.accountId !== accountId || context.teamId !== origin.teamId || context.teamVersionId !== origin.basis.teamVersionId)
            throw new ConflictException('TEAM_SCOPE_REVOKED');
        const [binding] = await tx.select().from(teamAccountBindings).where(and(eq(teamAccountBindings.ownerId, owner), eq(teamAccountBindings.id, context.bindingId)));
        if (!binding)
            throw new ConflictException('TEAM_SCOPE_REVOKED');
        if (binding.state !== 'active' && !events.some(event => event.event === 'continue_policy' && event.proposalRevision > applied.proposalRevision))
            throw new ConflictException('TEAM_REAPPROVAL_REQUIRED');
        for (const grantId of new Set(context.members.flatMap(member => member.sourceGrantIds))) {
            const [grant] = await tx.select().from(teamSourceGrants).where(and(eq(teamSourceGrants.ownerId, owner), eq(teamSourceGrants.teamId, context.teamId), eq(teamSourceGrants.id, grantId), eq(teamSourceGrants.state, 'active')));
            if (!grant)
                throw new ConflictException('TEAM_SCOPE_REVOKED');
            await sourceFingerprint(tx, owner, { kind: grant.sourceKind as 'report_version' | 'thesis_version' | 'document_version' | 'data_snapshot', id: grant.sourceId, revision: grant.sourceRevision, availability: 'available' }, context.dataCutoffAt);
        }
        for (const source of origin.basis.sourceRefs)
            await sourceFingerprint(tx, owner, source, context.dataCutoffAt);
        if (origin.basis.reportVersionId) {
            const [version] = await tx.select().from(researchDocumentVersions).where(and(eq(researchDocumentVersions.owner, owner), eq(researchDocumentVersions.id, origin.basis.reportVersionId)));
            if (!version)
                throw new ConflictException('TEAM_SOURCE_UNAVAILABLE');
            await sourceFingerprint(tx, owner, { kind: 'report_version', id: version.id, revision: String(version.version), availability: 'available' });
        }
        for (const ref of origin.basis.thesisVersions) {
            const [version] = await tx.select().from(researchThesisVersions).where(and(eq(researchThesisVersions.owner, owner), eq(researchThesisVersions.id, ref.versionId), eq(researchThesisVersions.thesisId, ref.thesisId)));
            if (!version)
                throw new ConflictException('TEAM_SOURCE_UNAVAILABLE');
            await sourceFingerprint(tx, owner, { kind: 'thesis_version', id: version.id, revision: String(version.version), availability: 'available' });
        }
    }
}
