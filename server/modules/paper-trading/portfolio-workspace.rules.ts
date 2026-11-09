import { z } from 'zod';
import { createHash } from 'node:crypto';
import { investmentSecurityKey } from './investment-policy.rules';
import { PORTFOLIO_COMBINATION_MAX_SECURITIES } from '../../../shared/portfolio-workspace.interface';
import type { PortfolioCombinationIssue, PortfolioStrategyAssignment } from '../../../shared/portfolio-workspace.interface';

export const workspaceMutationSchema = z.object({
  expectedPolicyRevision: z.number().int().positive(),
  requestKey: z.string().regex(/^[a-zA-Z0-9_-]{8,128}$/u),
}).strict();
export const workspaceAllocationSchema = z.object({
  strategyId: z.string().uuid(), strategyRevision: z.number().int().positive(),
  allocationPct: z.number().finite().min(0).max(100).multipleOf(0.0001), enabled: z.boolean(),
}).strict();
export const workspaceCombinationSchema = workspaceMutationSchema.extend({
  allocations: z.array(workspaceAllocationSchema).max(30),
}).strict().refine(value => new Set(value.allocations.map(a => a.strategyId)).size === value.allocations.length,
  'Each strategy can be assigned only once')
  .refine(value => value.allocations.filter(a => a.enabled).reduce((sum, a) => sum + a.allocationPct, 0) <= 100 + 1e-8,
    'Enabled strategy budgets must total at most 100%')
  .refine(value => value.allocations.every(a => !a.enabled || a.allocationPct > 0),
    'Enabled strategies require a positive budget');
export function workspaceHash(value: unknown): string {
  const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical)
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => [key, canonical(child)])) : v;
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
/** Ignore volatile preview-generation timestamps; bind persisted content and compiled authority. */
export function combinationHash(accountId: string, policyRevision: number, allocations: PortfolioStrategyAssignment[]): string {
  return workspaceHash({ accountId, policyRevision, allocations: [...allocations].sort((a, b) => a.strategyId.localeCompare(b.strategyId))
    .map(a => ({ strategyId: a.strategyId, strategyRevision: a.strategyRevision, allocationPct: a.allocationPct, enabled: a.enabled,
      content: a.snapshot.content, sources: a.snapshot.sources, contentHash: a.snapshot.preview.contentHash,
      directives: a.snapshot.preview.directives, mandateRules: a.snapshot.preview.mandateRules })) });
}
export function combinationIssues(allocations: PortfolioStrategyAssignment[]): PortfolioCombinationIssue[] {
  const entries = allocations.filter(a => a.enabled).flatMap(a => a.snapshot.preview.directives.map(directive => ({ a, directive })));
  const issues: PortfolioCombinationIssue[] = [];
  const symbols = new Set(entries.map(entry => entry.directive.ticker));
  if (symbols.size > PORTFOLIO_COMBINATION_MAX_SECURITIES) issues.push({
    code: 'COMBINATION_SECURITY_CAPACITY_EXCEEDED',
    strategyIds: [...new Set(entries.map(entry => entry.a.strategyId))],
    entryIds: [...new Set(entries.map(entry => entry.directive.entryId))],
    message: {
      en: `Enabled strategies can contain at most ${PORTFOLIO_COMBINATION_MAX_SECURITIES} distinct execution symbols. Disable or remove entries before applying.`,
      'zh-CN': `启用的策略合计最多包含 ${PORTFOLIO_COMBINATION_MAX_SECURITIES} 个不同的执行标的，请先停用策略或移除条目。`,
    },
  });
  for (let i = 0; i < entries.length; i++) {
    const left = entries[i];
    for (const right of entries.slice(i + 1)) {
      if (left.a.strategyId === right.a.strategyId
        || investmentSecurityKey(left.directive.ticker) !== investmentSecurityKey(right.directive.ticker)
        || Date.parse(left.directive.endsAt) <= Date.parse(right.directive.startsAt)
        || Date.parse(right.directive.endsAt) <= Date.parse(left.directive.startsAt)) continue;
      const opposite = left.directive.side !== right.directive.side;
      const incompatible = left.directive.positionPct !== right.directive.positionPct
        || left.directive.quantity !== right.directive.quantity;
      if (opposite || incompatible) issues.push({
        code: opposite ? 'STRATEGY_DIRECTION_CONFLICT' : 'STRATEGY_TARGET_CONFLICT',
        strategyIds: [left.a.strategyId, right.a.strategyId],
        entryIds: [left.directive.entryId, right.directive.entryId],
        message: { en: `Overlapping strategies disagree about ${left.directive.ticker}. Review both source entries.`,
          'zh-CN': `重叠策略对 ${left.directive.ticker} 的方向或目标不一致，请核对两条来源。` },
      });
    }
  }
  return issues;
}
