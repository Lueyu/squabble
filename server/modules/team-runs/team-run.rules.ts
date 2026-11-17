import { z } from 'zod';
import type { TeamRunConfiguration } from '../../../shared/team-run.interface';
import type { TeamSemanticConfig, CommissionPreviewInput, BlueprintCommissionPreviewInput } from '../../../shared/team-workspace.interface';
import type { TradingMarketSchedule } from '../../../shared/trading-market.interface';
import { budgetSchema } from '../teams/team-graph';
import { compareDecimal, requestKeySchema, revisionSchema, sourceRefSchema, teamError, uuidSchema } from '../teams/team-contract';
const finiteCost = /^(0|[1-9]\d{0,7})(\.\d{1,8})?$/;
const cost = z.string().regex(finiteCost).refine(value => finiteCost.test(value) && compareDecimal(value, '0') > 0);
const period = z.object({ costUsd: cost.nullable(), calls: z.number().int().positive().max(100000).nullable() }).strict()
  .transform(value => ({ costUsd: value.costUsd ?? null, calls: value.calls ?? null }));
/** Appended by automatic runs to the blueprint summary so the final report always carries an executable strategy section. */
export const EXECUTION_STRATEGY_REQUIREMENT = 'An evidence-backed report with a validated execution-strategy section; use no_trade or needs_info when no executable decision is supported.';
export const teamRunInputSchema = z.object({ requestKey: requestKeySchema, teamVersionId: uuidSchema, bindingId: uuidSchema, expectedBindingRevision: revisionSchema,
  objective: z.string().trim().min(1).max(4000), market: z.enum(['US', 'HK', 'CN']),
  initialRun: z.enum(['immediate', 'scheduled']).optional(),
  cadence: z.object({ kind: z.literal('after_close'), delayMinutes: z.number().int().min(0).max(360) }).strict().default({ kind: 'after_close', delayMinutes: 60 }),
  budget: z.object({ perRun: budgetSchema.extend({ ceiling: z.object({ amount: cost.nullable(), currency: z.literal('USD') }).strict(), paidRevisionLimit: z.literal(0) })
    // Keep required nullable keys explicit under this project's strictNullChecks:false Zod inference.
    .transform(value => ({ ...value,
      budgetMode: value.ceiling.amount === null ? 'calls_only' as const : value.budgetMode,
      ceiling: { ...value.ceiling, amount: value.ceiling.amount ?? null },
    })), daily: period, monthly: period }).strict(),
  replacementPolicy: z.object({ kind: z.literal('replace_combination'), allocationPct: z.number().positive().max(100) }).strict(),
  inputRefs: z.array(sourceRefSchema).max(100),
}).strict().superRefine((value, context) => {
  const { perRun, daily, monthly } = value.budget;
  const amount = perRun.ceiling.amount;
  if (![amount, daily.costUsd, monthly.costUsd].every(limit => limit === null || finiteCost.test(limit))) return;
  const dailyCostInvalid = daily.costUsd !== null && (amount === null || compareDecimal(amount, daily.costUsd) > 0);
  const monthlyCostInvalid = monthly.costUsd !== null && (amount === null || compareDecimal(amount, monthly.costUsd) > 0
    || daily.costUsd !== null && compareDecimal(daily.costUsd, monthly.costUsd) > 0);
  const dailyCallsInvalid = daily.calls !== null && perRun.callLimit > daily.calls;
  const monthlyCallsInvalid = monthly.calls !== null && (perRun.callLimit > monthly.calls || daily.calls !== null && daily.calls > monthly.calls);
  if (dailyCostInvalid || monthlyCostInvalid || dailyCallsInvalid || monthlyCallsInvalid)
    context.addIssue({ code: 'custom', message: 'Per-run limits must fit daily and monthly limits' });
}).transform(value => ({ ...value, budget: {
  perRun: value.budget.perRun, daily: value.budget.daily, monthly: value.budget.monthly,
} }));
export function dueTeamRun(schedule: TradingMarketSchedule, delayMinutes: number, now: Date, initialRunPending = false): string | null {
  // Research may prepare a strategy on a verified non-trading day. The paper engine still gates every trade.
  if (initialRunPending) return schedule.calendarVerified ? schedule.tradingDate : null;
  return schedule.calendarVerified && schedule.isTradingDay && schedule.closesAt && now.getTime() >= Date.parse(schedule.closesAt) + delayMinutes * 60000 ? schedule.tradingDate : null;
}
/** Compile bounded work over the frozen team; Council remains the only research executor. */
export function compileRunCommission(config: TeamSemanticConfig, input: TeamRunConfiguration, requestKey: string, now: Date): CommissionPreviewInput | BlueprintCommissionPreviewInput {
  const ceiling = { ...input.budget.perRun.ceiling, amount: input.budget.perRun.budgetMode === 'calls_only' ? null : input.budget.perRun.ceiling.amount };
  const budgetMode = ceiling.amount === null ? 'calls_only' : input.budget.perRun.budgetMode;
  if (config.workBlueprint)
    return { planMode: 'blueprint', requestKey, teamVersionId: input.teamVersionId, bindingId: input.bindingId, expectedBindingRevision: input.expectedBindingRevision,
      objective: input.objective, dataCutoffAt: now.toISOString(), deadlineAt: new Date(now.getTime() + 6 * 3600000).toISOString(), inputRefs: input.inputRefs,
      budget: { ...input.budget.perRun, budgetMode, ceiling }, summaryRequirement: EXECUTION_STRATEGY_REQUIREMENT };
  const roles = config.roles.filter(role => role.participation === 'enabled');
  const lead = roles.find(role => role.id === config.defaults.leadRoleId);
  if (!lead || roles.length > 6 || !roles.length) teamError('TEAM_PLAN_INVALID', 'Autonomous runs require one to six enabled roles and a lead');
  const work = roles.filter(role => role.id !== lead.id).map(role => ({ workKey: role.id, roleId: role.id, taskKind: 'specialist' as const,
    objective: input.objective + '\n' + role.responsibility, expectedOutput: role.expectedOutput, dependencyWorkKeys: [], reviewerRoleId: lead.id,
    reviewMode: 'independent' as const, inputRefs: [], requestedByRoleIds: [lead.id] }));
  const reviewer = roles.find(role => role.id !== lead.id) ?? lead;
  const summary = { workKey: 'summary', roleId: lead.id, taskKind: 'summary' as const, objective: input.objective,
    expectedOutput: EXECUTION_STRATEGY_REQUIREMENT,
    dependencyWorkKeys: work.map(item => item.workKey), reviewerRoleId: reviewer.id, reviewMode: reviewer.id === lead.id ? 'self_check' as const : 'independent' as const,
    inputRefs: [], requestedByRoleIds: [lead.id] };
  return { requestKey, teamVersionId: input.teamVersionId, bindingId: input.bindingId, expectedBindingRevision: input.expectedBindingRevision,
    leadRoleId: lead.id, participantRoleIds: roles.map(role => role.id), objective: input.objective, expectedOutput: summary.expectedOutput,
    dataCutoffAt: now.toISOString(), deadlineAt: new Date(now.getTime() + 6 * 3600000).toISOString(), supervisorRoleIds: [], work: [...work, summary],
    parallelism: config.defaults.parallelism, conflictResolutions: [], budget: { ...input.budget.perRun, budgetMode, ceiling }, inputRefs: input.inputRefs };
}
