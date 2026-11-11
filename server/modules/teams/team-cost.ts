import { and, eq, sql } from 'drizzle-orm';
import { teamCommissions } from '../../database/teams.schema';
import { councilResearchTasks } from '../../database/research-workflow.schema';
import type { TeamDatabase } from '../../database/team-context';
import type { TeamCostSummary } from '../../../shared/team-workspace.interface';
export async function readTeamCommissionCost(tx: TeamDatabase, row: typeof teamCommissions.$inferSelect): Promise<TeamCostSummary> {
    const rates = row.inputSnapshot.costRates as {
        inputUsdPerMillion: string;
        outputUsdPerMillion: string;
    } | null;
    const totals = await tx.execute(sql `SELECT
      sum(CASE WHEN u.status='completed' THEN (u.input_tokens*${rates?.inputUsdPerMillion ?? null}::numeric+u.output_tokens*${rates?.outputUsdPerMillion ?? null}::numeric)/1000000 ELSE 0 END)::text AS confirmed,
      sum(CASE WHEN u.status IN ('reserved','failed_unknown','estimated') THEN (u.input_tokens*${rates?.inputUsdPerMillion ?? null}::numeric+
        CASE WHEN u.status IN ('reserved','failed_unknown') THEN u.max_output_tokens ELSE u.output_tokens END*${rates?.outputUsdPerMillion ?? null}::numeric)/1000000 ELSE 0 END)::text AS reserved,
      bool_or(${!rates}::boolean OR u.status IN ('failed_unknown','estimated')) AS unknown
      FROM llm_budget_usage u WHERE u.owner::text=${row.ownerId} AND u.task_id=${row.rootBudgetTaskId}`);
    const tasks = row.sessionId ? await tx.select().from(councilResearchTasks).where(and(eq(councilResearchTasks.owner, row.ownerId), eq(councilResearchTasks.sessionId, row.sessionId))) : [];
    const unknownAttempts = tasks.flatMap(t => t.attempts.filter(a => a.externalUsageUnknown || a.state === 'uncertain').map(a => a.id));
    const external = totals[0]?.unknown === true || unknownAttempts.length > 0;
    const currency = row.budgetLimit.ceiling.currency;
    return { confirmed: { amount: totals[0]?.confirmed === null ? null : String(totals[0]?.confirmed ?? '0'), currency },
        reserved: { amount: totals[0]?.reserved === null ? null : String(totals[0]?.reserved ?? '0'), currency }, estimatedMaximum: row.budgetLimit.ceiling,
        externalUsageUnknown: external, unknownAttemptIds: unknownAttempts };
}
function sumDecimal(values: (string | null)[]): string | null {
    const known = values.filter((value): value is string => value !== null);
    if (!known.length)
        return null;
    const scale = Math.max(...known.map(value => (value.split('.')[1] ?? '').length));
    const sum = known.reduce((total, value) => { const [integer, fraction = ''] = value.split('.'); return total + BigInt(integer + fraction.padEnd(scale, '0')); }, 0n).toString().padStart(scale + 1, '0');
    if (!scale)
        return sum;
    const fraction = sum.slice(-scale).replace(/0+$/u, '');
    return sum.slice(0, -scale) + (fraction ? '.' + fraction : '');
}
export function combineTeamCosts(costs: TeamCostSummary[]): TeamCostSummary {
    const currency = 'USD';
    if (!costs.length)
        return { confirmed: { amount: '0', currency }, reserved: { amount: '0', currency }, estimatedMaximum: { amount: '0', currency }, externalUsageUnknown: false, unknownAttemptIds: [] };
    return { confirmed: { amount: sumDecimal(costs.map(cost => cost.confirmed.amount)), currency }, reserved: { amount: sumDecimal(costs.map(cost => cost.reserved.amount)), currency },
        estimatedMaximum: { amount: costs.some(cost => cost.estimatedMaximum.amount === null) ? null : sumDecimal(costs.map(cost => cost.estimatedMaximum.amount)), currency },
        externalUsageUnknown: costs.some(cost => cost.externalUsageUnknown), unknownAttemptIds: [...new Set(costs.flatMap(cost => cost.unknownAttemptIds))] };
}
