import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { TeamStore } from './team-store';
import { TeamsService } from './teams.service';
import { TeamVersionService } from './team-version.service';
import { TeamCommissionService } from './team-commission.service';
import { TeamSourceAccessService } from './team-source-access.service';
import { TeamDecisionService } from './team-decision.service';
import { TeamRuntimeAdapter } from './team-runtime-adapter';
import { modelConnections } from '../../database/model-connections.schema';
import { llmBudgetSettings } from '../../database/llm-budget.schema';
import { councilSessions } from '../../database/council.schema';
import { paperAccounts } from '../../database/schema';
import { investmentPolicies } from '../../database/investment-policy.schema';
import { DEFAULT_INVESTMENT_CONFIG } from '../paper-trading/investment-policy.rules';
import { newCheckpoint } from '../council/council.dialogue';
import { teamCouncilMembers } from '../council/council.team';
import { normalizeBuilderConfig } from '../paper-trading/agent-builder.rules';
import type { CouncilService } from '../council/council.service';
import type { TeamDetail, TeamSemanticConfig, ResearchSourceRef } from '../../../shared/team-workspace.interface';
export async function makeTeamFixture() {
    const url = process.env.TEAM_TEST_DATABASE_URL;
    if (!url)
        throw new Error('TEAM_TEST_DATABASE_URL is required');
    const ns = 'team_fixture_' + randomUUID().replaceAll('-', '');
    const admin = postgres(url, { max: 1, onnotice: () => undefined }), client = postgres(url, { max: 6, onnotice: () => undefined, connection: { search_path: ns } });
    await admin.unsafe('CREATE SCHEMA ' + ns);
    await client.unsafe(readFileSync('scripts/db/01_schema.sql', 'utf8'));
    const db = drizzle(client), owner = randomUUID(), stranger = randomUUID();
    await client `INSERT INTO users(id,username,password_hash) VALUES(${owner},${'team-' + owner.slice(0, 16)},'fixture'),(${stranger},${'other-' + stranger.slice(0, 16)},'fixture')`;
    const [connection] = await db.insert(modelConnections).values({ owner, name: 'Fixture metadata', baseUrl: 'https://fixture.invalid', fastModel: 'fixture', slowModel: 'fixture', apiKeyEnc: 'fixture-only-unused' }).returning();
    await db.insert(llmBudgetSettings).values({ owner, inputUsdPerMillion: '1', outputUsdPerMillion: '2' });
    const counters = { starts: 0, cancels: 0, recovers: 0, throwStart: false };
    const runtime = new TeamRuntimeAdapter({
        prepareTeamSessionInTransaction: async (tx, context) => {
            const checkpoint = newCheckpoint(teamCouncilMembers(context), { independent: true });
            checkpoint.teamContext = context;
            const config = normalizeBuilderConfig({ name: 'Fixture', template: 'guard', tickers: ['PORTFOLIO'], minimumRating: 'Buy', customPrompt: '', maxOrderPct: 5, dailyLossLimitPct: 3, maxOrdersPerDay: 1, notifyOnProposal: false, priceRules: [], language: 'zh-CN', council: { enabled: true, members: teamCouncilMembers(context), webResearch: false } });
            const [session] = await tx.insert(councilSessions).values({ owner: context.ownerId, profileVersion: 1, profileSnapshot: config, ticker: 'PORTFOLIO', scene: 'portfolio_daily', teamCommissionId: context.commissionId, teamContext: context, checkpoint, taskId: context.commissionId }).returning();
            return { sessionId: session.id, cycleId: checkpoint.cycleId, rootBudgetTaskId: context.commissionId };
        },
        runTeamSessionOnce: async () => { counters.starts++; if (counters.throwStart)
            throw new Error('Fixture response lost'); },
        cancelTeamSession: async () => { counters.cancels++; }, recoverTeamSession: async () => { counters.recovers++; },
    } as Pick<CouncilService, 'prepareTeamSessionInTransaction' | 'runTeamSessionOnce' | 'cancelTeamSession' | 'recoverTeamSession'> as CouncilService);
    const store = new TeamStore(db), service = new TeamsService(store), versions = new TeamVersionService(store, runtime), commissions = new TeamCommissionService(store, runtime), sources = new TeamSourceAccessService(store), decisions = new TeamDecisionService(store);
    const before = { workspace: process.env.TEAM_WORKSPACE_ENABLED, research: process.env.TEAM_RESEARCH_ENABLED };
    process.env.TEAM_WORKSPACE_ENABLED = 'true';
    process.env.TEAM_RESEARCH_ENABLED = 'true';
    async function team(name = 'Fixture team') {
        const created = await service.create(owner, { requestKey: randomUUID(), name }) as TeamDetail;
        const role = randomUUID(), config: TeamSemanticConfig = { schemaVersion: 1, departments: [], roles: [{ id: role, departmentId: null, participation: 'enabled', responsibility: 'Analyze fixture', expectedOutput: 'Structured evidence', executor: { executionMode: 'model', connectionId: connection.id, model: 'fixture', settings: {} }, allowedToolIds: [], sourceGrantIds: [] }], relations: [], defaults: { leadRoleId: role, parallelism: 1 } };
        const saved = await service.save(owner, created.id, 'draft', { requestKey: randomUUID(), expectedSemanticRevision: 1, config }) as TeamDetail;
        const preview = await versions.publishPreview(owner, created.id, { requestKey: randomUUID(), expectedSemanticRevision: saved.semanticRevision });
        const published = await versions.publish(owner, created.id, { requestKey: randomUUID(), previewId: preview.previewId, previewHash: preview.previewHash });
        return { team: published.team, version: published.version, role };
    }
    async function account(name = 'Fixture account') {
        const [row] = await db.insert(paperAccounts).values({ owner, name, isActive: true }).returning();
        await db.insert(investmentPolicies).values({ owner, accountId: row.id, baseConfig: DEFAULT_INVESTMENT_CONFIG, effectiveConfig: DEFAULT_INVESTMENT_CONFIG });
        return row;
    }
    async function commission(inputRefs: ResearchSourceRef[] = []) {
        const t = await team(), a = await account();
        const grantIds: string[] = [];
        if (inputRefs.length)
            for (const ref of inputRefs) {
                const detail = await service.detail(owner, t.team.id);
                const granted = await sources.grant(owner, t.team.id, { requestKey: randomUUID(), expectedScopeRevision: detail.scopeRevision, sourceRef: ref });
                grantIds.push(granted.grant.id);
            }
        if (grantIds.length) {
            const detail = await service.detail(owner, t.team.id);
            const config = { ...detail.draft.config, roles: detail.draft.config.roles.map(role => ({ ...role, sourceGrantIds: grantIds })) };
            const saved = await service.save(owner, t.team.id, 'draft', { requestKey: randomUUID(), expectedSemanticRevision: detail.semanticRevision, config });
            const pp = await versions.publishPreview(owner, t.team.id, { requestKey: randomUUID(), expectedSemanticRevision: saved.semanticRevision });
            const published = await versions.publish(owner, t.team.id, { requestKey: randomUUID(), previewId: pp.previewId, previewHash: pp.previewHash });
            t.team = published.team;
            t.version = published.version;
        }
        const bp = await versions.bindingPreview(owner, t.team.id, { requestKey: randomUUID(), action: 'assign', accountId: a.id, teamVersionId: t.version.id, expectedBindingRevision: 0, expectedAccountBindingId: null, executionChoice: 'keep_confirmed_rules', acknowledgePendingReapproval: true });
        const bound = await versions.binding(owner, t.team.id, { requestKey: randomUUID(), previewId: bp.previewId, previewHash: bp.previewHash });
        const preview = await commissions.preview(owner, t.team.id, { requestKey: randomUUID(), teamVersionId: t.version.id, bindingId: bound.binding!.id, expectedBindingRevision: bound.team.bindingRevision,
            leadRoleId: t.role, participantRoleIds: [t.role], supervisorRoleIds: [], objective: 'Fixture research', expectedOutput: 'Structured evidence', dataCutoffAt: null, deadlineAt: new Date(Date.now() + 3600000).toISOString(), parallelism: 1, inputRefs, conflictResolutions: [],
            work: [{ workKey: 'summary', roleId: t.role, taskKind: 'summary', objective: 'Summarize fixture', expectedOutput: 'Report', dependencyWorkKeys: [], reviewerRoleId: t.role, reviewMode: 'self_check', inputRefs, requestedByRoleIds: [] }], budget: { budgetMode: 'cost_and_calls', ceiling: { amount: '1', currency: 'USD' }, callLimit: 2, paidRevisionLimit: 0 } });
        const created = await commissions.create(owner, t.team.id, { requestKey: randomUUID(), previewId: preview.previewId, previewHash: preview.previewHash });
        return { ...t, account: a, binding: bound.binding!, created };
    }
    async function dispose() {
        if (before.workspace === undefined)
            delete process.env.TEAM_WORKSPACE_ENABLED;
        else
            process.env.TEAM_WORKSPACE_ENABLED = before.workspace;
        if (before.research === undefined)
            delete process.env.TEAM_RESEARCH_ENABLED;
        else
            process.env.TEAM_RESEARCH_ENABLED = before.research;
        await client.end();
        await admin.unsafe('DROP SCHEMA ' + ns + ' CASCADE');
        await admin.end();
    }
    return { db, client, owner, stranger, store, service, versions, commissions, sources, decisions, runtime, counters, connection, team, account, commission, dispose };
}
export const teamErrorIs = (code: string) => (error: unknown) => typeof error === 'object' && error !== null && 'getResponse' in error && String((error.getResponse as () => unknown)() instanceof Object ? ((error.getResponse as () => {
    code: string;
})()).code : (error.getResponse as () => unknown)()) === code;
