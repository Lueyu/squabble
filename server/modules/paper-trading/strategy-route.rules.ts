import type { StrategyRouteDecision, StrategyRoutePolicy } from '../../../shared/strategy-mandate.interface';

export const DEFAULT_ROUTE_POLICY: StrategyRoutePolicy = {
  councilPositionCapRatio: 0.8, councilIncrementPct: 3, rollingWindowMinutes: 60, candidateTtlSeconds: 1200,
};
export interface StrategyRouteContext {
  hardBlock: string | null; side: 'buy' | 'sell'; protectiveStop: boolean;
  deterministic: boolean; semanticCondition: string; conflict: boolean; liquidityRisk: boolean;
  equityUsd: number; currentExposureUsd: number; pendingBuyUsd: number;
  pendingTotalBuyUsd?: number;
  rollingBuyUsd: number; candidateNotionalUsd: number; hardPositionCapPct: number;
  policy: StrategyRoutePolicy;
}
/** Cost routing never changes the candidate or authorizes a hard-limit exception. */
export function routeStrategyCandidate(c: StrategyRouteContext): StrategyRouteDecision {
  const increase = c.side === 'buy' ? c.candidateNotionalUsd : 0;
  const exposure = c.side === 'buy' ? c.currentExposureUsd + c.pendingBuyUsd + increase : Math.max(0, c.currentExposureUsd - c.candidateNotionalUsd);
  const validEquity = Number.isFinite(c.equityUsd) && c.equityUsd > 0;
  const exposurePct = exposure / c.equityUsd * 100;
  const increasePct = (c.rollingBuyUsd + (c.pendingTotalBuyUsd ?? c.pendingBuyUsd) + increase) / c.equityUsd * 100;
  const result = { postTradeExposurePct: validEquity && Number.isFinite(exposurePct) ? exposurePct : null,
    accumulatedIncreasePct: validEquity && Number.isFinite(increasePct) ? increasePct : null };
  const decision = (route: StrategyRouteDecision['route'], reason: string): StrategyRouteDecision => ({ ...result, route, reason });
  if (c.hardBlock) return decision('blocked', c.hardBlock);
  if (!Number.isFinite(c.candidateNotionalUsd) || c.candidateNotionalUsd <= 0 || !Number.isFinite(c.currentExposureUsd) || c.currentExposureUsd < 0
    || c.side === 'buy' && (![c.equityUsd, c.hardPositionCapPct].every(v => Number.isFinite(v) && v > 0)
      || ![c.pendingBuyUsd, c.pendingTotalBuyUsd ?? 0, c.rollingBuyUsd].every(v => Number.isFinite(v) && v >= 0))) {
    return decision('blocked', 'Invalid valuation or exposure');
  }
  if (c.protectiveStop) return c.side === 'sell' ? decision('direct', 'Authorized protective exit') : decision('blocked', 'Protection cannot increase exposure');
  if (c.side === 'buy' && exposurePct > c.hardPositionCapPct + 1e-8) return decision('blocked', 'Position cap exceeded');
  if (c.conflict || c.liquidityRisk) return decision('council', 'Conflicting evidence or liquidity risk');
  if (c.side === 'buy' && (exposurePct >= c.hardPositionCapPct * c.policy.councilPositionCapRatio - 1e-8
    || increasePct >= c.policy.councilIncrementPct - 1e-8)) {
    return decision('council', 'Large resulting position or accumulated increase');
  }
  if (!c.deterministic || c.semanticCondition.trim()) return decision('ai', 'A qualitative condition needs evidence review');
  return decision('direct', 'Measurable rule within authorized low-risk limits');
}
