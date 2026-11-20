import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { TEAM_TEMPLATES } from '../../../shared/team-templates';
import type { LocalAgentsStatus } from '../../../shared/local-agents.interface';
import type { TeamExecutor } from '../../../shared/team-workspace.interface';
import { paperPositions } from '../../database/schema';
import { councilSessions } from '../../database/council.schema';
import { AgentRosterService } from '../agent-roster/agent-roster.service';
import { CouncilService } from '../council/council.service';
import { teamTaskPlan } from '../council/council.team';
import { CouncilWorkflowExecutor, type WorkflowExecutorDependencies } from '../council/council.workflow-executor';
import { CouncilWorkflowStore } from '../council/council.workflow-store';
import type { LocalAgentsService } from '../local-agents/local-agents.service';
import { TeamRuntimeAdapter } from './team-runtime-adapter';
import { TeamVersionService } from './team-version.service';
import { TeamCommissionService } from './team-commission.service';
import { TeamCommissionWorker } from './team-commission.worker';
import { makeTeamFixture } from './team-test.fixture';

for (const mode of ['model', 'local'] as const) {
    test(`a default template friend runs on its role's ${mode} route`, {
        skip: !process.env.TEAM_TEST_DATABASE_URL,
    }, async () => {
        const f = await makeTeamFixture();
        try {
            const roleText = 'Independently verify this team-only scenario.';
            const settings = { model: 'paired-model', reasoningEffort: 'high' };
            const paired: LocalAgentsStatus = {
                mode: 'companion', companion: { connected: true },
                items: [{
                    id: 'paired-codex', provider: 'codex', name: 'Fixture paired Codex', source: 'companion',
                    state: 'ready', connected: true, available: true, busy: false, loginCommand: '', installUrl: '',
                    researchTools: { mode: 'mcp', reason: 'supported' }, models: [{ id: settings.model, name: settings.model }],
                    reasoningEfforts: ['high'],
                }],
            };
            const delivery = {
                conclusion: 'Fixture conclusion', evidenceIds: [], asOf: '2026-11-18', currency: null, units: 'unknown',
                assumptions: [], gaps: ['No external evidence'], skillVersions: [],
                response: { thesis: 'Fixture conclusion', evidencePoints: [], risks: [], nextChecks: [] },
            };
            let requests = 0;
            const apiTasks: string[] = [];
            const local = {
                status: async (owner) => {
                    assert.equal(owner, f.owner);
                    return paired;
                },
                execute: async (owner, options) => {
                    assert.equal(mode, 'local');
                    assert.equal(owner, f.owner);
                    assert.equal(options.agentId, 'paired-codex');
                    assert.deepEqual(options.agentSettings, settings);
                    assert.match(JSON.parse(options.prompt.slice(options.prompt.lastIndexOf('\n') + 1)).member.instructions,
                        /Independently verify this team-only scenario/u);
                    assert.equal(await options.shouldContinue(), true);
                    assert.equal(options.researchScope?.teamId, saved.id);
                    await options.withHandoff?.(async () => {});
                    await options.onDispatch?.();
                    await options.onSubmitted?.('companion-command');
                    requests++;
                    return { text: JSON.stringify(delivery), usageTokens: null };
                },
            } satisfies Pick<LocalAgentsService, 'status' | 'execute'>;
            type Llm = WorkflowExecutorDependencies['llm'];
            const llm = {
                chatFastJSON: async (...args: Parameters<Llm['chatFastJSON']>) => {
                    const [prompt, owner, options] = args;
                    assert.equal(mode, 'model');
                    assert.equal(owner, f.owner);
                    assert.equal(options?.connectionId, f.connection.id);
                    assert.deepEqual(options?.route, { mode: 'api' });
                    assert.ok(Array.isArray(prompt));
                    const input = JSON.parse(prompt.at(-1)!.content);
                    apiTasks.push(input.task.key);
                    const frozenAccount = input.evidence.find((item: { id: string }) => item.id.startsWith('team-account:'));
                    assert.equal(JSON.parse(frozenAccount.content).holdings.length, 4);
                    if (input.task.key === 'financials') {
                        assert.match(input.member.instructions, /核对报表来源、版本和期间/u);
                        assert.doesNotMatch(input.member.instructions, /Independently verify this team-only scenario/u);
                    } else {
                        assert.equal(input.task.key, 'summary');
                        assert.match(input.member.instructions, /Independently verify this team-only scenario/u);
                        assert.equal(input.handoffs.length, 3);
                    }
                    await options?.onDispatch?.();
                    requests++;
                    return { data: delivery, tokens: 12 };
                },
            } satisfies Pick<Llm, 'chatFastJSON'>;

            const council = new CouncilService(f.db, undefined!, undefined!, undefined!, undefined!);
            const runtime = new TeamRuntimeAdapter(council, local as LocalAgentsService);
            const versions = new TeamVersionService(f.store, runtime);
            const commissions = new TeamCommissionService(f.store, runtime);
            const initial = await f.service.create(f.owner, {
                requestKey: randomUUID(), name: 'Fictional staffed template', templateId: TEAM_TEMPLATES[0].id,
            });
            const leadRoleId = initial.draft.config.defaults.leadRoleId!;
            const lead = initial.draft.config.roles.find(role => role.id === leadRoleId)!;
            assert.ok(lead.agentId && lead.agentVersionId);
            assert.equal(lead.participation, 'placeholder');
            const roster = new AgentRosterService(f.db, local);
            const friend = await roster.detail(f.owner, lead.agentId);
            assert.equal(friend.origin, 'builtin');
            assert.deepEqual(friend.effectiveExecutor, { executionMode: 'local', localAgentId: 'paired-codex' });
            const [personalMember] = await roster.resolveMembers(f.owner, [{ agentId: lead.agentId, agentVersionId: lead.agentVersionId }]);
            assert.equal(personalMember.agentId, 'paired-codex');
            assert.equal(personalMember.rosterAgentVersionId, lead.agentVersionId);
            assert.ok(personalMember.instructions.includes(friend.currentVersion.config.instructions));
            const executor: TeamExecutor = mode === 'local'
                ? { executionMode: 'local', localAgentId: 'paired-codex', settings }
                : { executionMode: 'model', connectionId: f.connection.id, model: f.connection.fastModel, tier: 'fast', settings: {} };
            const saved = await f.service.save(f.owner, initial.id, 'draft', {
                requestKey: randomUUID(), expectedSemanticRevision: initial.semanticRevision,
                config: { ...initial.draft.config, roles: initial.draft.config.roles.map(role => role.id === leadRoleId || mode === 'model'
                    ? { ...role, executor, participation: 'enabled', ...(role.id === leadRoleId ? { workingInstructions: roleText } : {}) }
                    : role) },
            });
            const preview = await versions.publishPreview(f.owner, saved.id, {
                requestKey: randomUUID(), expectedSemanticRevision: saved.semanticRevision,
            });
            const published = await versions.publish(f.owner, saved.id, {
                requestKey: randomUUID(), previewId: preview.previewId, previewHash: preview.previewHash,
            });
            const account = await f.account();
            if (mode === 'model') {
                await f.db.insert(paperPositions).values(['ALFA', 'BETA', 'GAMA', 'DELTA'].map(ticker => ({
                    owner: f.owner, accountId: account.id, ticker, company: `Fictional company ${ticker}`, shares: '10', avgCost: '100',
                })));
            }
            const bp = await versions.bindingPreview(f.owner, saved.id, {
                requestKey: randomUUID(), action: 'assign', accountId: account.id, teamVersionId: published.version.id,
                expectedBindingRevision: 0, expectedAccountBindingId: null, executionChoice: 'keep_confirmed_rules',
                acknowledgePendingReapproval: true,
            });
            const bound = await versions.binding(f.owner, saved.id, {
                requestKey: randomUUID(), previewId: bp.previewId, previewHash: bp.previewHash,
            });
            const commissionInput = {
                requestKey: randomUUID(), teamVersionId: published.version.id, bindingId: bound.binding!.id,
                expectedBindingRevision: bound.team.bindingRevision,
                objective: 'Isolated fixture research', dataCutoffAt: null, deadlineAt: new Date(Date.now() + 3600000).toISOString(),
                inputRefs: [],
            };
            const cp = await commissions.preview(f.owner, saved.id, mode === 'model' ? {
                ...commissionInput, planMode: 'blueprint',
                budget: { budgetMode: 'cost_and_calls', ceiling: { amount: '1', currency: 'USD' }, callLimit: 8, paidRevisionLimit: 0 },
            } : {
                ...commissionInput, leadRoleId, participantRoleIds: [leadRoleId], supervisorRoleIds: [],
                expectedOutput: 'Fixture evidence', parallelism: 1, conflictResolutions: [],
                work: [{ workKey: 'summary', roleId: leadRoleId, taskKind: 'summary', objective: 'Summarize the fixture',
                    expectedOutput: 'Fixture report', dependencyWorkKeys: [], reviewerRoleId: leadRoleId, reviewMode: 'self_check',
                    inputRefs: [], requestedByRoleIds: [] }],
                budget: { budgetMode: 'calls_only', ceiling: { amount: null, currency: 'USD' }, callLimit: 2, paidRevisionLimit: 0 },
            });
            assert.equal(requests, 0);
            const created = await commissions.create(f.owner, saved.id, {
                requestKey: randomUUID(), previewId: cp.previewId, previewHash: cp.previewHash,
            });
            await new TeamCommissionWorker(f.store, runtime, commissions).runOnce();
            const [session] = await f.db.update(councilSessions).set({ status: 'running' })
                .where(eq(councilSessions.teamCommissionId, created.commissionId)).returning();
            assert.ok(session?.checkpoint?.teamContext);
            const members = session.profileSnapshot.council!.members;
            assert.equal(members.length, mode === 'model' ? 4 : 1);
            const leadMember = members.find(member => member.rosterAgentVersionId === lead.agentVersionId)!;
            assert.ok(leadMember.instructions.includes(friend.currentVersion.config.teamInstructions!));
            assert.ok(leadMember.instructions.includes(roleText));
            const store = new CouncilWorkflowStore(f.db);
            await store.initialize(session, teamTaskPlan(session.checkpoint.teamContext), () => []);
            const tasks = await store.list(f.owner, session.id, session.checkpoint.cycleId);
            const workflow = new CouncilWorkflowExecutor({
                db: f.db, store, llm: llm as Llm, localAgents: local as LocalAgentsService, activity: async () => {},
            });
            const work = tasks.filter(task => task.key !== 'summary');
            for (const key of mode === 'model' ? ['financials', 'summary'] : ['summary']) {
                const task = tasks.find(item => item.key === key)!;
                const member = members.find(item => item.id === task.memberId)!;
                const attempt = await store.claim(session, task, 'work');
                assert.ok(attempt);
                const context = key === 'summary'
                    ? tasks.map(item => work.includes(item) ? { ...item, state: 'accepted' as const, delivery: {
                        ...delivery, conclusion: 'Accepted fixture findings from ' + item.key,
                        assumptions: ['Comparable periods remain subject to disclosure review.'],
                        response: { ...delivery.response, evidencePoints: ['Verified sample evidence supports the baseline; retain the open questions.'] },
                    } } : item)
                    : tasks;
                const result = await workflow.execute(session, task, attempt, member, context).catch(async (error: unknown) => {
                    const latest = (await store.list(f.owner, session.id, session.checkpoint!.cycleId)).find(item => item.id === task.id);
                    const inventory = latest?.attempts.at(-1)?.memory;
                    throw new Error(`Fixture ${key} dispatch failed with ${inventory?.requestTokens}/${inventory?.requestBudgetTokens} input budget`, { cause: error });
                });
                assert.equal(result.delivery?.conclusion, delivery.conclusion);
                const finished = (await store.list(f.owner, session.id, session.checkpoint!.cycleId)).find(item => item.id === task.id)!;
                const inventory = finished.attempts.at(-1)!.memory!;
                if (mode === 'model') {
                    assert.equal(inventory.requestBudgetTokens, 6000);
                    assert.ok(inventory.requestTokens! <= 6000);
                }
            }
            assert.deepEqual(apiTasks, mode === 'model' ? ['financials', 'summary'] : []);
            assert.equal(requests, mode === 'model' ? 2 : 1);

        } finally {
            await f.dispose();
        }
    });
}
