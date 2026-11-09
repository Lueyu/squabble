import type { AiInvestmentView } from '@shared/investment-policy.interface';
import type { StrategyDraftInput } from '@shared/user-investment-strategy.interface';

export const draftLimits: NonNullable<StrategyDraftInput['limits']> = {
  maxPositionPct: 10,
  maxDailyIncreasePct: 5,
  maxDailyTurnoverPct: 20,
  minCashPct: 10,
  maxGrossExposurePct: 90,
  maxOrderPct: 5,
};
export function simulationLimits(
  limits: AiInvestmentView['limits'],
): NonNullable<StrategyDraftInput['limits']> {
  return {
    maxPositionPct: limits.maxPositionPct,
    maxDailyIncreasePct: limits.maxDailyIncreasePct,
    maxDailyTurnoverPct: limits.maxDailyTurnoverPct,
    minCashPct: limits.minCashPct,
    maxGrossExposurePct: limits.maxGrossExposurePct,
    maxOrderPct: limits.maxOrderPct,
  };
}

export function strategyRiskLabels(zh: boolean): Record<string, string> {
  return {
    maxPositionPct: zh ? '单股仓位上限' : 'Single-position cap',
    maxOrderPct: zh ? '单笔资金上限' : 'Single-order cap',
    maxDailyIncreasePct: zh ? '每日新增仓位上限' : 'Daily increase cap',
    maxDailyTurnoverPct: zh ? '每日交易金额上限' : 'Daily turnover cap',
    minCashPct: zh ? '最低现金比例' : 'Minimum cash',
    maxGrossExposurePct: zh ? '总仓位上限' : 'Gross exposure cap',
  };
}
