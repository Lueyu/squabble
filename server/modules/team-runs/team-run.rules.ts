import { z } from 'zod';
import type { TeamRunConfiguration } from '../../../shared/team-run.interface';
import type { TeamSemanticConfig, CommissionPreviewInput } from '../../../shared/team-workspace.interface';
import type { TradingMarketSchedule } from '../../../shared/trading-market.interface';
import { budgetSchema } from '../teams/team-graph';
import { compareDecimal, requestKeySchema, revisionSchema, sourceRefSchema, teamError, uuidSchema } from '../teams/team-contract';
const finiteCost = /^(0|[1-9]\d{0,7})(\.\d{1,8})?$/;
const cost = z.string().regex(finiteCost).refine(value => finiteCost.test(value) && compareDecimal(value, '0') > 0);
const period = z.object({ costUsd: cost, calls: z.number().int().positive().max(100000) }).strict();
export const teamRunInputSchema = z.object({ requestKey: requestKeySchema, teamVersionId: uuidSchema, bindingId: uuidSchema, expectedBindingRevision: revisionSchema,
  objective: z.string().trim().min(1).max(4000), market: z.enum(['US', 'HK', 'CN']),
  cadence: z.object({ kind: z.literal('after_close'), delayMinutes: z.number().int().min(0).max(360) }).strict().default({ kind: 'after_close', delayMinutes: 60 }),
  budget: z.object({ perRun: budgetSchema.extend({ ceiling: z.object({ amount: cost, currency: z.literal('USD') }).strict(), paidRevisionLimit: z.literal(0) }), daily: period, monthly: period }).strict(),
  replacementPolicy: z.object({ kind: z.literal('replace_combination'), allocationPct: z.number().positive().max(100) }).strict(),
  inputRefs: z.array(sourceRefSchema).max(100),
}).strict().superRefine((value, context) => {
  const { perRun, daily, monthly } = value.budget;
  if (![perRun.ceiling.amount, daily.costUsd, monthly.costUsd].every(amount => finiteCost.test(amount))) return;
  if (compareDecimal(perRun.ceiling.amount, daily.costUsd) > 0 || compareDecimal(daily.costUsd, monthly.costUsd) > 0 || perRun.callLimit > daily.calls || daily.calls > monthly.calls)
    context.addIssue({ code: 'custom', message: 'Per-run limits must fit daily and monthly limits' });
});
export function dueTeamRun(schedule: TradingMarketSchedule, delayMinutes: number, now: Date): string | null {
  return schedule.calendarVerified && schedule.isTradingDay && schedule.closesAt && now.getTime() >= Date.parse(schedule.closesAt) + delayMinutes * 60000 ? schedule.tradingDate : null;
}
/** Compile bounded work over the frozen team; Council remains the only research executor. */
export function compileRunCommission(config: TeamSemanticConfig, input: TeamRunConfiguration, requestKey: string, now: Date): CommissionPreviewInput {
  const roles = config.roles.filter(role => role.participation === 'enabled');
  const lead = roles.find(role => role.id === config.defaults.leadRoleId);
  if (!lead || roles.length > 6 || !roles.length) teamError('TEAM_PLAN_INVALID', 'Autonomous runs require one to six enabled roles and a lead');
  const work = roles.filter(role => role.id !== lead.id).map(role => ({ workKey: role.id, roleId: role.id, taskKind: 'specialist' as const,
    objective: input.objective + '\n' + role.responsibility, expectedOutput: role.expectedOutput, dependencyWorkKeys: [], reviewerRoleId: lead.id,
    reviewMode: 'independent' as const, inputRefs: [], requestedByRoleIds: [lead.id] }));
  const reviewer = roles.find(role => role.id !== lead.id) ?? lead;
  const summary = { workKey: 'summary', roleId: lead.id, taskKind: 'summary' as const, objective: input.objective,
    expectedOutput: 'An evidence-backed report with a validated execution-strategy section; use no_trade or needs_info when no executable decision is supported.',
    dependencyWorkKeys: work.map(item => item.workKey), reviewerRoleId: reviewer.id, reviewMode: reviewer.id === lead.id ? 'self_check' as const : 'independent' as const,
    inputRefs: [], requestedByRoleIds: [lead.id] };
  return { requestKey, teamVersionId: input.teamVersionId, bindingId: input.bindingId, expectedBindingRevision: input.expectedBindingRevision,
    leadRoleId: lead.id, participantRoleIds: roles.map(role => role.id), objective: input.objective, expectedOutput: summary.expectedOutput,
    dataCutoffAt: now.toISOString(), deadlineAt: new Date(now.getTime() + 6 * 3600000).toISOString(), supervisorRoleIds: [], work: [...work, summary],
    parallelism: config.defaults.parallelism, conflictResolutions: [], budget: { ...input.budget.perRun,
      ceiling: { ...input.budget.perRun.ceiling, amount: input.budget.perRun.budgetMode === 'calls_only' ? null : input.budget.perRun.ceiling.amount } }, inputRefs: input.inputRefs };
}
