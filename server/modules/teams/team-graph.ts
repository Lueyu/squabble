import { z } from 'zod';
import type { TeamCommissionPlan, TeamSemanticConfig, TeamWorkItem, TeamDisplay } from '../../../shared/team-workspace.interface';
import { canonicalHash, moneySchema, sourceRefSchema, teamError, uuidSchema } from './team-contract';
const text = z.string().max(1000), ids = z.array(uuidSchema).max(30);
const executor = z.discriminatedUnion('executionMode', [
    z.object({ executionMode: z.literal('model'), connectionId: uuidSchema, model: z.string().min(1).max(120), tier: z.string().max(30).optional(), settings: z.record(z.string(), z.unknown()) }).strict(),
    z.object({ executionMode: z.literal('local'), localAgentId: z.string().min(1).max(128), settings: z.record(z.string(), z.unknown()) }).strict(),
]);
export const semanticSchema = z.object({ schemaVersion: z.literal(1),
    departments: z.array(z.object({ id: uuidSchema, parentDepartmentId: uuidSchema.nullable(), purpose: text }).strict()),
    roles: z.array(z.object({ id: uuidSchema, departmentId: uuidSchema.nullable(), participation: z.enum(['placeholder', 'enabled']), responsibility: text, expectedOutput: text,
        executor: executor.nullable(), allowedToolIds: z.array(z.string().min(1).max(128)).max(100), sourceGrantIds: ids }).strict()).max(30),
    relations: z.array(z.object({ id: uuidSchema, fromRoleId: uuidSchema, toRoleId: uuidSchema, kind: z.enum(['reports_to', 'delegates_to', 'reviews']), responsibilityScope: text }).strict()),
    defaults: z.object({ leadRoleId: uuidSchema.nullable(), parallelism: z.union([z.literal(1), z.literal(2)]) }).strict(),
}).strict() as z.ZodType<TeamSemanticConfig>;
export const displaySchema = z.object({ name: z.string().trim().min(1).max(80), avatar: z.string().max(500).nullable(),
    departmentLabels: z.record(uuidSchema, z.string().trim().min(1).max(100)), roleLabels: z.record(uuidSchema, z.string().trim().min(1).max(100)) }).strict() as z.ZodType<TeamDisplay>;
export const layoutSchema = z.object({ schemaVersion: z.literal(1), positions: z.record(uuidSchema, z.object({ x: z.number().finite(), y: z.number().finite(), width: z.number().positive().optional(), height: z.number().positive().optional() }).strict()),
    collapsedDepartmentIds: z.array(uuidSchema), viewport: z.object({ x: z.number().finite(), y: z.number().finite(), zoom: z.number().min(0.1).max(4) }).strict() }).strict();
export const workSchema = z.object({ workKey: z.string().min(1).max(128), roleId: uuidSchema, taskKind: z.enum(['financials', 'business', 'valuation', 'challenge', 'summary', 'specialist']),
    objective: z.string().min(1).max(4000), expectedOutput: z.string().min(1).max(4000), dependencyWorkKeys: z.array(z.string().min(1).max(128)).max(60),
    reviewerRoleId: uuidSchema, reviewMode: z.enum(['independent', 'self_check']), inputRefs: z.array(sourceRefSchema).max(100), requestedByRoleIds: ids }).strict();
export const budgetSchema = z.object({ budgetMode: z.enum(['cost_and_calls', 'calls_only']), ceiling: moneySchema, callLimit: z.number().int().positive().max(500), paidRevisionLimit: z.number().int().nonnegative().max(50).default(0) }).strict();
export const commissionFields = { leadRoleId: uuidSchema, participantRoleIds: ids, objective: z.string().min(1).max(4000), expectedOutput: z.string().min(1).max(4000),
    dataCutoffAt: z.iso.datetime().nullable(), deadlineAt: z.iso.datetime(), supervisorRoleIds: ids, work: z.array(workSchema).min(1).max(60),
    parallelism: z.union([z.literal(1), z.literal(2)]), conflictResolutions: z.array(z.object({ instructionIds: z.array(z.string().min(1)).min(1), choice: z.string().min(1), reason: z.string().min(1) }).strict()).max(100), budget: budgetSchema };
export function normalizeSemanticConfig(config: TeamSemanticConfig): TeamSemanticConfig {
    return { ...config, departments: [...config.departments].sort((a, b) => a.id.localeCompare(b.id)),
        roles: [...config.roles].sort((a, b) => a.id.localeCompare(b.id)).map(role => ({ ...role, allowedToolIds: [...role.allowedToolIds].sort(), sourceGrantIds: [...role.sourceGrantIds].sort() })),
        relations: [...config.relations].sort((a, b) => a.id.localeCompare(b.id)) };
}
export function semanticHash(config: TeamSemanticConfig): string { return canonicalHash(normalizeSemanticConfig(config)); }
function acyclic(nodes: string[], edges: [
    string,
    string
][], code: 'TEAM_GRAPH_INVALID' | 'TEAM_PLAN_INVALID'): void {
    const visiting = new Set<string>(), done = new Set<string>();
    function visit(id: string): void {
        if (visiting.has(id))
            teamError(code, 'Cycle detected');
        if (done.has(id))
            return;
        visiting.add(id);
        for (const [, to] of edges.filter(([from]) => from === id))
            visit(to);
        visiting.delete(id);
        done.add(id);
    }
    nodes.forEach(visit);
}
export function validateTeamGraph(config: TeamSemanticConfig): void {
    const departments = new Set(config.departments.map(d => d.id)), roles = new Set(config.roles.map(r => r.id));
    const all = [...departments, ...roles, ...config.relations.map(r => r.id)];
    if (new Set(all).size !== config.departments.length + config.roles.length + config.relations.length)
        teamError('TEAM_GRAPH_INVALID', 'Node IDs must be unique');
    for (const d of config.departments)
        if (d.parentDepartmentId && !departments.has(d.parentDepartmentId))
            teamError('TEAM_GRAPH_INVALID', 'Unknown parent department');
    acyclic([...departments], config.departments.filter(d => d.parentDepartmentId).map(d => [d.id, d.parentDepartmentId!]), 'TEAM_GRAPH_INVALID');
    for (const role of config.roles) {
        if (role.departmentId && !departments.has(role.departmentId))
            teamError('TEAM_GRAPH_INVALID', 'Unknown department', { roleId: role.id });
        if (role.participation === 'enabled' && (!role.executor || !role.responsibility.trim() || !role.expectedOutput.trim()))
            teamError('TEAM_GRAPH_INVALID', 'Enabled roles require executor, responsibility and output', { roleId: role.id });
    }
    if (config.defaults.leadRoleId && !roles.has(config.defaults.leadRoleId))
        teamError('TEAM_GRAPH_INVALID', 'Unknown lead role');
    const seen = new Set<string>();
    for (const r of config.relations) {
        const key = [r.fromRoleId, r.toRoleId, r.kind, r.responsibilityScope.trim()].join(':');
        if (!roles.has(r.fromRoleId) || !roles.has(r.toRoleId) || r.fromRoleId === r.toRoleId || seen.has(key))
            teamError('TEAM_GRAPH_INVALID', 'Invalid or duplicate relation', { relationId: r.id });
        if (r.kind === 'reports_to' && !r.responsibilityScope.trim())
            teamError('TEAM_GRAPH_INVALID', 'Reporting scope is required', { relationId: r.id });
        seen.add(key);
    }
    acyclic([...roles], config.relations.filter(r => r.kind === 'reports_to').map(r => [r.fromRoleId, r.toRoleId]), 'TEAM_GRAPH_INVALID');
}
export function compileTeamPlan(config: TeamSemanticConfig, plan: TeamCommissionPlan, inputSnapshot: Record<string, unknown>): TeamCommissionPlan {
    validateTeamGraph(config);
    const selected = new Set(plan.participantRoleIds), roles = new Map(config.roles.map(r => [r.id, r]));
    if (selected.size !== plan.participantRoleIds.length || selected.size < 1 || selected.size > 6 || !selected.has(plan.leadRoleId))
        teamError('TEAM_PLAN_INVALID', 'Select one to six distinct roles including the lead');
    for (const id of selected)
        if (roles.get(id)?.participation !== 'enabled')
            teamError('TEAM_PLAN_INVALID', 'Only enabled roles may execute', { roleId: id });
    for (const id of plan.supervisorRoleIds)
        if (!roles.has(id))
            teamError('TEAM_PLAN_INVALID', 'Unknown supervisor role', { roleId: id });
    if (plan.work.filter(w => w.taskKind === 'summary' && w.roleId === plan.leadRoleId).length !== 1 || plan.work.filter(w => w.taskKind === 'summary').length !== 1)
        teamError('TEAM_PLAN_INVALID', 'Exactly one lead summary is required');
    const keys = new Set(plan.work.map(w => w.workKey));
    if (keys.size !== plan.work.length)
        teamError('TEAM_PLAN_INVALID', 'Duplicate work key');
    for (const w of plan.work) {
        if (!selected.has(w.roleId) || !selected.has(w.reviewerRoleId) || w.requestedByRoleIds.some(id => !roles.has(id)))
            teamError('TEAM_PLAN_INVALID', 'Work role is outside this commission');
        if (w.dependencyWorkKeys.some(k => !keys.has(k) || k === w.workKey))
            teamError('TEAM_PLAN_INVALID', 'Unknown or self dependency');
        if ((w.roleId === w.reviewerRoleId) !== (w.reviewMode === 'self_check'))
            teamError('TEAM_PLAN_INVALID', 'Review mode must disclose self check');
    }
    acyclic([...keys], plan.work.flatMap(w => w.dependencyWorkKeys.map(k => [w.workKey, k] as [
        string,
        string
    ])), 'TEAM_PLAN_INVALID');
    const computed = new Map<string, string>(), items: TeamWorkItem[] = [];
    function compile(w: TeamWorkItem): string {
        const prior = computed.get(w.workKey);
        if (prior)
            return prior;
        const deps = [...new Set(w.dependencyWorkKeys.map(k => compile(plan.work.find(x => x.workKey === k)!)))].sort();
        const inputRefs = [...new Map(w.inputRefs.map(ref => [[ref.kind, ref.id, ref.revision].join(':'), ref])).values()].sort((a, b) => (a.kind + a.id + a.revision).localeCompare(b.kind + b.id + b.revision));
        const workKey = canonicalHash({ roleId: w.roleId, taskKind: w.taskKind, objective: w.objective, expectedOutput: w.expectedOutput,
            inputRefs, inputSnapshot, dataCutoffAt: plan.dataCutoffAt, dependencies: deps });
        computed.set(w.workKey, workKey);
        const duplicate = items.find(x => x.workKey === workKey);
        if (duplicate)
            duplicate.requestedByRoleIds = [...new Set([...duplicate.requestedByRoleIds, ...w.requestedByRoleIds])];
        else
            items.push({ ...w, inputRefs, workKey, dependencyWorkKeys: deps });
        return workKey;
    }
    plan.work.forEach(compile);
    if (plan.budget.budgetMode === 'cost_and_calls' && plan.budget.ceiling.amount === null)
        teamError('TEAM_BUDGET_BLOCKED', 'A concrete cost ceiling is required');
    if (plan.budget.callLimit < items.length * 2)
        teamError('TEAM_BUDGET_BLOCKED', 'Every required work item needs an execution and an explicit review call');
    return { ...plan, work: items };
}
