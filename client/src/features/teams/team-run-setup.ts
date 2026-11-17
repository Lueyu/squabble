import type { TeamSemanticConfig } from '@shared/team-workspace.interface';
import type { TeamRunBudget } from '@shared/team-run.interface';

/** Council reserves one execution and one review call per compiled work, including summary. */
export function requiredRunCalls(config: TeamSemanticConfig): number {
  const workCount = config.workBlueprint
    ? config.workBlueprint.works.length + 1
    : config.roles.filter(role => role.participation === 'enabled').length;
  return Math.max(8, workCount * 2);
}

/** A nullable amount is an explicit absent cap; each research commission still has finite work. */
export function automaticRunBudget(daily: string | null, external: boolean, callLimit: number): TeamRunBudget {
  if (!Number.isSafeInteger(callLimit) || callLimit < 2 || callLimit > 500) throw new Error('Invalid finite call limit');
  const amount = daily === null ? null : Number(daily);
  if (amount !== null && (!daily?.trim() || !Number.isFinite(amount) || amount < 0.02 || amount >= 100000000)) throw new Error('Enter a finite daily USD limit of at least 0.02, or select no amount cap');
  const cost = amount === null ? null : amount.toFixed(2);
  return {
    perRun: { budgetMode: external || cost === null ? 'calls_only' : 'cost_and_calls', ceiling: { amount: cost, currency: 'USD' }, callLimit, paidRevisionLimit: 0 },
    daily: { costUsd: cost, calls: null },
    monthly: { costUsd: null, calls: null },
  };
}
