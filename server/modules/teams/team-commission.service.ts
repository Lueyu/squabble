import { readTeamCommissionCost } from './team-cost';
import { Injectable } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { teamAccountBindings, teamCommissions, teamCommissionJobs, teamVersions, teamSourceGrants, teamResearchLinks, teamDecisions } from '../../database/teams.schema';
import { paperPositions } from '../../database/schema';
import { councilResearchTasks } from '../../database/research-workflow.schema';
import { llmBudgetSettings } from '../../database/llm-budget.schema';
import { assertTeamExecutionInTransaction, type TeamDatabase } from '../../database/team-context';
import { sourceFingerprint } from '../../database/team-source-context';
import { freezeTeamMemberGrants } from '../../database/team-member-sources';
import { TeamStore, type CommissionRow, unknownCost } from './team-store';
import { TeamRuntimeAdapter } from './team-runtime-adapter';
import { budgetSchema, commissionFields, compileTeamPlan } from './team-graph';
import { canonicalHash, compareDecimal, confirmSchema, parseTeam, requestKeySchema, revisionSchema, moneySchema, sourceRefSchema, teamError, uuidSchema, pageFields, decodeTeamCursor, encodeTeamCursor } from './team-contract';
import { requireTeamFeature } from './team-config';
import { teamAccountPolicySnapshot } from '../paper-trading/team-account-transaction';
import type { TeamBudget, TeamCommission, TeamCommissionPlan, TeamExecutionContext, TeamMemberSnapshot, TeamSemanticConfig, ResearchSourceRef, RecoveryInput, TeamCostSummary } from '../../../shared/team-workspace.interface';
export function commissionContext(row: CommissionRow): TeamExecutionContext {
    return { audience: 'team', ownerId: row.ownerId, teamId: row.teamId, teamVersionId: row.teamVersionId, commissionId: row.id, accountId: row.accountId,
        bindingId: row.bindingId, bindingRevision: row.bindingRevision, scopeRevision: row.scopeRevision, deadlineAt: row.plan.deadlineAt, dataCutoffAt: row.plan.dataCutoffAt,
        plan: row.plan, members: row.members, inputSnapshot: row.inputSnapshot };
}
@Injectable()
export class TeamCommissionService {
    constructor(readonly store: TeamStore, private readonly runtime: TeamRuntimeAdapter) { }
    async row(tx: TeamDatabase, owner: string, teamId: string, id: string): Promise<CommissionRow> {
        parseTeam(uuidSchema, id);
        await this.store.team(tx, owner, teamId);
        const [commission] = await tx.select().from(teamCommissions).where(and(eq(teamCommissions.ownerId, owner), eq(teamCommissions.teamId, teamId), eq(teamCommissions.id, id))).for('update');
        if (!commission)
            teamError('TEAM_REFERENCE_NOT_FOUND');
        return commission;
    }
    cost(tx: TeamDatabase, row: CommissionRow) { return readTeamCommissionCost(tx, row); }
    async view(tx: TeamDatabase, row: CommissionRow): Promise<TeamCommission> {
        return { ...row, state: row.state as TeamCommission['state'], cost: await this.cost(tx, row), createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
            cancelRequestedAt: row.cancelRequestedAt?.toISOString() ?? null, completedAt: row.completedAt?.toISOString() ?? null };
    }
    async preview(owner: string, id: string, input: unknown) {
        const request = parseTeam(z.object({ requestKey: requestKeySchema, teamVersionId: uuidSchema, bindingId: uuidSchema, expectedBindingRevision: revisionSchema, ...commissionFields, inputRefs: z.array(sourceRefSchema).max(100) }).strict(), input);
        return this.store.mutate(owner, id, 'commission-preview', request, async (tx) => {
            requireTeamFeature(true);
            const team = await this.store.team(tx, owner, id, true);
            this.store.revision(team.bindingRevision, request.expectedBindingRevision);
            const [binding] = await tx.select().from(teamAccountBindings).where(and(eq(teamAccountBindings.ownerId, owner), eq(teamAccountBindings.teamId, id), eq(teamAccountBindings.id, request.bindingId), eq(teamAccountBindings.state, 'active')));
            if (!binding)
                teamError('TEAM_BINDING_CONFLICT');
            const [version] = await tx.select().from(teamVersions).where(and(eq(teamVersions.ownerId, owner), eq(teamVersions.teamId, id), eq(teamVersions.id, request.teamVersionId)));
            if (!version)
                teamError('TEAM_REFERENCE_NOT_FOUND');
            const now = new Date(), dataCutoffAt = request.dataCutoffAt ?? now.toISOString();
            if (new Date(dataCutoffAt).getTime() > now.getTime() || new Date(request.deadlineAt).getTime() <= now.getTime())
                teamError('TEAM_PLAN_INVALID', 'Invalid data cutoff or deadline');
            const account = await teamAccountPolicySnapshot(tx, owner, binding.accountId);
            const positions = await tx.select().from(paperPositions).where(and(eq(paperPositions.owner, owner), eq(paperPositions.accountId, binding.accountId)));
            const [rates] = await tx.select().from(llmBudgetSettings).where(eq(llmBudgetSettings.owner, owner));
            const costRates = rates && rates.inputUsdPerMillion !== null && rates.outputUsdPerMillion !== null ? { inputUsdPerMillion: rates.inputUsdPerMillion, outputUsdPerMillion: rates.outputUsdPerMillion } : null;
            const inputSnapshot = { account: account.account, positions, policyRevision: account.revision, inputRefs: request.inputRefs, costRates, capturedAt: now.toISOString() };
            const rawPlan: TeamCommissionPlan = { schemaVersion: 1, leadRoleId: request.leadRoleId, participantRoleIds: request.participantRoleIds, objective: request.objective, expectedOutput: request.expectedOutput,
                dataCutoffAt, deadlineAt: request.deadlineAt, supervisorRoleIds: request.supervisorRoleIds, work: request.work as TeamCommissionPlan['work'],
                parallelism: request.parallelism, conflictResolutions: request.conflictResolutions, budget: request.budget as TeamBudget };
            const plan = compileTeamPlan(version.config, rawPlan, inputSnapshot);
            const selected = version.config.roles.filter(r => plan.participantRoleIds.includes(r.id));
            const checks = await this.runtime.check(tx, owner, selected);
            if (checks.some(c => c.status !== 'supported'))
                teamError('TEAM_CAPABILITY_UNAVAILABLE', 'Selected executor capability is not currently verified', { checks });
            const hasLocal = selected.some(r => r.executor?.executionMode === 'local');
            if (plan.budget.ceiling.currency !== 'USD')
                teamError('TEAM_BUDGET_BLOCKED', 'This runtime accounts for research costs in USD');
            if (rates?.enabled && plan.budget.callLimit > rates.maxCallsPerTask)
                teamError('TEAM_BUDGET_BLOCKED', 'Plan exceeds the current owner call authorization');
            if (plan.budget.budgetMode === 'cost_and_calls') {
                if (!costRates)
                    teamError('TEAM_BUDGET_BLOCKED', 'Configure observable model cost rates before authorizing a monetary ceiling');
            }
            if (hasLocal && plan.budget.budgetMode === 'cost_and_calls')
                teamError('TEAM_BUDGET_BLOCKED', 'Native provider cost cannot be guaranteed; explicitly authorize calls-only mode');
            if (plan.budget.budgetMode === 'calls_only' && (!account.policySnapshot.policy || account.policySnapshot.policy.baseConfig.budget.maxCallsPerTask < plan.budget.callLimit))
                teamError('TEAM_BUDGET_BLOCKED', 'Account call authorization is absent or lower than this plan');
            const guards = await this.store.guards(tx, team);
            guards.accountPolicyRevision = account.revision;
            guards.accountAssignmentRevision = account.assignmentRevision;
            guards.executorFingerprints = checks.map(c => ({ roleId: c.roleId, fingerprint: c.fingerprint! }));
            guards.capabilityFingerprint = canonicalHash(guards.executorFingerprints);
            const grants = await tx.select().from(teamSourceGrants).where(and(eq(teamSourceGrants.ownerId, owner), eq(teamSourceGrants.teamId, id), eq(teamSourceGrants.state, 'active')));
            for (const role of selected)
                for (const grantId of role.sourceGrantIds)
                    if (!grants.some(g => g.id === grantId))
                        teamError('TEAM_SCOPE_REVOKED');
            const refs = [...request.inputRefs, ...plan.work.flatMap(w => w.inputRefs)] as ResearchSourceRef[];
            for (const ref of refs) {
                const grant = grants.find(g => g.sourceKind === ref.kind && g.sourceId === ref.id && g.sourceRevision === ref.revision);
                if (!grant)
                    teamError('TEAM_SCOPE_REVOKED', 'Input source requires an explicit active team grant');
                const fingerprint = await sourceFingerprint(tx, owner, ref, dataCutoffAt);
                if (!guards.sourceFingerprints.some(s => s.sourceId === ref.id && s.revision === ref.revision))
                    guards.sourceFingerprints.push({ sourceId: ref.id, revision: ref.revision, fingerprint });
            }
            const memberGrants = freezeTeamMemberGrants(selected, plan, request.inputRefs, grants);
            const members: TeamMemberSnapshot[] = selected.map(role => ({ roleId: role.id, memberId: role.id.replaceAll('-', ''), teamVersionId: version.id,
                label: version.displaySnapshot.roleLabels[role.id] ?? role.id, responsibility: role.responsibility, expectedOutput: role.expectedOutput, executor: role.executor!,
                executorConfigRevision: checks.find(c => c.roleId === role.id)!.fingerprint!, capabilityFingerprint: checks.find(c => c.roleId === role.id)!.fingerprint!,
                allowedToolIds: role.allowedToolIds, sourceGrantIds: memberGrants.get(role.id)!, scopeRevision: team.scopeRevision }));
            const warnings = hasLocal ? [{ code: 'TEAM_EXTERNAL_COST_UNKNOWN', message: 'Call count is bounded; external provider fees remain unknown' }] : [];
            const identities = selected.map(({ executor }) => executor!.executionMode === 'model' ? 'model:' + executor!.connectionId : 'local:' + executor!.localAgentId);
            if (new Set(identities).size !== identities.length)
                warnings.push({ code: 'TEAM_SHARED_EXECUTOR', message: 'Multiple roles share an execution connection; distinct roles do not establish independent models' });
            if (plan.parallelism === 2 && selected.some((role, index) => role.executor?.executionMode === 'local' && identities.indexOf(identities[index]) !== index))
                teamError('TEAM_PLAN_INVALID', 'A shared local executor requires parallelism 1');
            return { ...await this.store.preview(tx, owner, team, 'commission', { plan, inputSnapshot, members, accountId: binding.accountId, bindingId: binding.id, teamVersionId: version.id }, guards, warnings), requestKey: request.requestKey };
        });
    }
    async create(owner: string, id: string, input: unknown) {
        const request = parseTeam(confirmSchema, input);
        return this.store.mutate(owner, id, 'commission-create', request, async (tx) => {
            requireTeamFeature(true);
            const team = await this.store.team(tx, owner, id, true), preview = await this.store.consume(tx, owner, team, 'commission', request);
            const plan = preview.payload.plan as TeamCommissionPlan, members = preview.payload.members as TeamMemberSnapshot[];
            if (Date.now() >= new Date(plan.deadlineAt).getTime())
                teamError('TEAM_PREVIEW_STALE');
            const account = await teamAccountPolicySnapshot(tx, owner, String(preview.payload.accountId));
            if (account.revision !== preview.guards.accountPolicyRevision)
                teamError('TEAM_PREVIEW_STALE');
            const [rates] = await tx.select().from(llmBudgetSettings).where(eq(llmBudgetSettings.owner, owner));
            const costRates = rates && rates.inputUsdPerMillion !== null && rates.outputUsdPerMillion !== null ? { inputUsdPerMillion: rates.inputUsdPerMillion, outputUsdPerMillion: rates.outputUsdPerMillion } : null;
            if (canonicalHash(costRates) !== canonicalHash((preview.payload.inputSnapshot as Record<string, unknown>).costRates))
                teamError('TEAM_PREVIEW_STALE', 'Cost rate assumptions changed');
            const roles: TeamSemanticConfig['roles'] = members.map(m => ({ id: m.roleId, departmentId: null, participation: 'enabled', responsibility: m.responsibility, expectedOutput: m.expectedOutput, executor: m.executor, allowedToolIds: m.allowedToolIds, sourceGrantIds: m.sourceGrantIds }));
            const checks = await this.runtime.check(tx, owner, roles);
            if (checks.some(c => c.status !== 'supported' || preview.guards.executorFingerprints.find(f => f.roleId === c.roleId)?.fingerprint !== c.fingerprint))
                teamError('TEAM_PREVIEW_STALE', 'Executor configuration changed');
            for (const ref of (preview.payload.inputSnapshot as {
                inputRefs: ResearchSourceRef[];
            }).inputRefs.concat(plan.work.flatMap(w => w.inputRefs))) {
                const fingerprint = await sourceFingerprint(tx, owner, ref, plan.dataCutoffAt);
                if (!preview.guards.sourceFingerprints.some(f => f.sourceId === ref.id && f.revision === ref.revision && f.fingerprint === fingerprint))
                    teamError('TEAM_PREVIEW_STALE');
            }
            const commissionId = randomUUID(), rootBudgetTaskId = commissionId;
            await tx.insert(teamCommissions).values({ id: commissionId, ownerId: owner, teamId: id, accountId: String(preview.payload.accountId), bindingId: String(preview.payload.bindingId),
                bindingRevision: team.bindingRevision, teamVersionId: String(preview.payload.teamVersionId), scopeRevision: team.scopeRevision, previewId: preview.id,
                plan, inputSnapshot: preview.payload.inputSnapshot as Record<string, unknown>, members, rootBudgetTaskId, state: 'queued', budgetLimit: plan.budget, requestedBy: owner });
            await tx.insert(teamCommissionJobs).values({ ownerId: owner, commissionId, kind: 'prepare', commandKey: 'prepare:v1', payload: {} });
            return { commissionId, state: 'queued', rootBudgetTaskId, requestKey: request.requestKey };
        });
    }
    async list(owner: string, id: string, query: unknown) {
        await this.store.detail(owner, id);
        const request = parseTeam(z.object({ ...pageFields, state: z.enum(['queued', 'running', 'awaiting_review', 'completed', 'partial', 'blocked', 'failed', 'cancelling', 'cancelled', 'uncertain']).optional() }).strict(), query), cursor = decodeTeamCursor(request.cursor);
        const rows = await this.store.db.select().from(teamCommissions).where(and(eq(teamCommissions.ownerId, owner), eq(teamCommissions.teamId, id), request.state ? eq(teamCommissions.state, request.state) : undefined, cursor ? sql `(${teamCommissions.createdAt},${teamCommissions.id})<(${cursor.at}::timestamptz,${cursor.id}::uuid)` : undefined)).orderBy(desc(teamCommissions.createdAt), desc(teamCommissions.id)).limit(request.limit + 1);
        const items: TeamCommission[] = [];
        for (const row of rows.slice(0, request.limit))
            items.push(await this.view(this.store.db, row));
        return { items, nextCursor: rows.length > request.limit ? encodeTeamCursor(rows[request.limit - 1]) : null };
    }
    async detail(owner: string, id: string, commissionId: string) {
        const row = await this.row(this.store.db, owner, id, commissionId);
        const links = await this.store.db.select().from(teamResearchLinks).where(and(eq(teamResearchLinks.ownerId, owner), eq(teamResearchLinks.commissionId, commissionId)));
        const decisions = await this.store.db.select().from(teamDecisions).where(and(eq(teamDecisions.ownerId, owner), eq(teamDecisions.commissionId, commissionId)));
        const tasks = row.sessionId ? await this.store.db.select().from(councilResearchTasks).where(and(eq(councilResearchTasks.owner, owner), eq(councilResearchTasks.sessionId, row.sessionId))) : [];
        return { ...await this.view(this.store.db, row), links, decisions: decisions.map(d => ({ ...d, createdAt: d.createdAt.toISOString() })), tasks };
    }
    async control(owner: string, id: string, commissionId: string, kind: 'cancel' | 'recover' | 'budget-limit', input: unknown) {
        parseTeam(uuidSchema, commissionId);
        const base = { requestKey: requestKeySchema, expectedCommissionRevision: revisionSchema };
        const recovery = z.discriminatedUnion('action', [
            z.object({ ...base, action: z.literal('check_existing'), workKey: z.string().optional(), attemptId: uuidSchema.optional() }).strict(),
            z.object({ ...base, action: z.literal('reparse_existing'), workKey: z.string(), attemptId: uuidSchema }).strict(),
            z.object({ ...base, action: z.enum(['retry_work', 'retry_review']), workKey: z.string(), attemptId: uuidSchema, acknowledgePaidRetry: z.literal(true), reason: z.string().min(1).max(2000) }).strict(),
        ]);
        const schema = kind === 'recover' ? recovery : kind === 'cancel' ? z.object({ ...base, reason: z.string().min(1).max(2000) }).strict()
            : z.object({ ...base, ceiling: moneySchema.optional(), callLimit: z.number().int().positive().optional() }).strict().refine(r => r.ceiling !== undefined || r.callLimit !== undefined);
        const request = parseTeam(schema as z.ZodType<{
            requestKey: string;
            expectedCommissionRevision: number;
        }>, input);
        return this.store.mutate(owner, id, 'commission-' + kind, request, async (tx) => {
            const row = await this.row(tx, owner, id, commissionId);
            this.store.revision(row.commissionRevision, request.expectedCommissionRevision);
            const data = request as Record<string, unknown>, revision = row.commissionRevision + 1;
            if (kind === 'budget-limit') {
                const budget = { ...row.budgetLimit }, ceiling = data.ceiling as TeamBudget['ceiling'] | undefined, callLimit = data.callLimit as number | undefined;
                if (callLimit !== undefined) {
                    if (callLimit > budget.callLimit)
                        teamError('TEAM_BUDGET_BLOCKED', 'Budget may only be tightened');
                    budget.callLimit = callLimit;
                }
                if (ceiling) {
                    if (ceiling.currency !== budget.ceiling.currency || ceiling.amount === null || budget.ceiling.amount !== null && compareDecimal(ceiling.amount, budget.ceiling.amount) > 0)
                        teamError('TEAM_BUDGET_BLOCKED', 'Budget may only be tightened in the same currency');
                    budget.ceiling = ceiling;
                }
                const [saved] = await tx.update(teamCommissions).set({ budgetLimit: budget, budgetLimitRevision: row.budgetLimitRevision + 1, commissionRevision: revision, updatedAt: new Date() }).where(eq(teamCommissions.id, row.id)).returning();
                return { ...await this.view(tx, saved), budgetLimitChange: { before: row.budgetLimit, after: budget }, requestKey: request.requestKey };
            }
            if (['completed', 'cancelled'].includes(row.state) && !(kind === 'recover' && data.action === 'check_existing'))
                teamError('TEAM_REVISION_CONFLICT', 'Commission is terminal');
            if (kind === 'recover') {
                const recoveryInput = request as RecoveryInput;
                if (recoveryInput.action === 'check_existing' && Boolean(recoveryInput.workKey) !== Boolean(recoveryInput.attemptId))
                    teamError('TEAM_INVALID_INPUT', 'Work and attempt must be supplied together');
                if (recoveryInput.workKey && recoveryInput.attemptId) {
                    const tasks = row.sessionId ? await tx.select().from(councilResearchTasks).where(and(eq(councilResearchTasks.owner, owner), eq(councilResearchTasks.sessionId, row.sessionId), eq(councilResearchTasks.cycleId, row.cycleId!))) : [];
                    const attempt = tasks.find(task => task.workKey === recoveryInput.workKey)?.attempts.find(item => item.id === recoveryInput.attemptId);
                    if (!attempt)
                        teamError('TEAM_REFERENCE_NOT_FOUND');
                    if (recoveryInput.action !== 'check_existing' && ['running', 'uncertain'].includes(attempt.state))
                        teamError('TEAM_EXECUTION_UNCERTAIN');
                }
                if (recoveryInput.action.startsWith('retry')) {
                    if (row.plan.budget.paidRevisionLimit === 0)
                        teamError('TEAM_BUDGET_BLOCKED', 'No paid revisions were authorized');
                    await tx.update(teamCommissions).set({ state: 'queued' }).where(eq(teamCommissions.id, row.id));
                    await assertTeamExecutionInTransaction(tx, owner, commissionContext(row));
                    if (row.state === 'uncertain')
                        teamError('TEAM_EXECUTION_UNCERTAIN', 'Check the existing external execution first');
                    const tasks = row.sessionId ? await tx.select().from(councilResearchTasks).where(and(eq(councilResearchTasks.owner, owner), eq(councilResearchTasks.sessionId, row.sessionId))) : [];
                    const retries = tasks.reduce((sum, task) => sum + task.reworks, 0);
                    if (retries >= row.plan.budget.paidRevisionLimit)
                        teamError('TEAM_BUDGET_BLOCKED', 'No authorized paid revisions remain');
                }
            }
            const state = kind === 'cancel' ? 'cancelling' : kind === 'recover' && data.action !== 'check_existing' ? 'queued' : row.state;
            await tx.update(teamCommissions).set({ commissionRevision: revision, state, cancelRequestedAt: kind === 'cancel' ? new Date() : row.cancelRequestedAt, updatedAt: new Date() }).where(eq(teamCommissions.id, row.id));
            await tx.insert(teamCommissionJobs).values({ ownerId: owner, commissionId: row.id, kind, commandKey: kind + ':' + revision, payload: data });
            return { commissionId: row.id, state, commissionRevision: revision, requestKey: request.requestKey };
        }, { commissionId });
    }
}
function planCallCount(plan: TeamCommissionPlan): number { return plan.work.reduce((n, w) => n + 1 + (w.reviewMode === 'independent' ? 1 : 0), 0); }
