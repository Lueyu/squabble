import { and, eq, gt, sql } from 'drizzle-orm';
import type { MemoryFenceTransaction } from '../research-memory/research-memory.fence';
import type { StrategyCandidate } from '../../../shared/strategy.interface';
import type { StrategyMandateInput } from '../../../shared/strategy-mandate.interface';
import { strategySignals } from '../../database/strategy.schema';
import { strategyReservations } from '../../database/strategy-mandates.schema';
import type { PortfolioRiskSnapshot } from './strategy-portfolio-risk';
import { resolveTradingTicker } from '../../../shared/trading-market.interface';

/** Budget is a cap on attributed exposure, never a request to rebalance the shared ledger. */
export function allocationBudgetBlock(input: {
  candidate: StrategyCandidate; allocationPct: number; minCashPct: number;
  portfolio: PortfolioRiskSnapshot; filled: StrategyCandidate[]; pending: StrategyCandidate[];
}): string | null {
  const { candidate, portfolio } = input;
  if (!candidate.userStrategyId || candidate.side !== 'buy' || candidate.protectiveStop) return null;
  if (!portfolio.equityUsd || portfolio.gaps.length || !Number.isFinite(input.allocationPct)
    || input.allocationPct <= 0 || input.allocationPct > 100) return 'PORTFOLIO_ALLOCATION_VALUATION_REQUIRED';
  const symbol = (ticker: string) => resolveTradingTicker(ticker)?.ticker ?? ticker.toUpperCase();
  const shares = new Map<string, number>();
  for (const fill of input.filled) {
    if (fill.accountId !== candidate.accountId || fill.userStrategyId !== candidate.userStrategyId) continue;
    const ticker = symbol(fill.ticker);
    // Selling seed holdings cannot create a negative strategy balance that subsidizes future buys.
    shares.set(ticker, Math.max(0, (shares.get(ticker) ?? 0) + (fill.side === 'buy' ? fill.quantity : -fill.quantity)));
  }
  let exposure = 0;
  for (const [ticker, quantity] of shares) {
    if (quantity <= 0) continue;
    const held = portfolio.holdings.find(item => symbol(item.ticker) === ticker)?.valueUsd ?? 0;
    if (!held) continue;
    const unit = portfolio.unitPricesUsd[ticker];
    if (!Number.isFinite(unit) || unit <= 0) return 'PORTFOLIO_ALLOCATION_VALUATION_REQUIRED';
    exposure += Math.min(quantity * unit, held);
  }
  for (const pending of [...input.pending, candidate]) {
    if (pending.accountId !== candidate.accountId || pending.userStrategyId !== candidate.userStrategyId
      || pending.side !== 'buy' || pending.protectiveStop) continue;
    const unit = portfolio.unitPricesUsd[symbol(pending.ticker)];
    if (!Number.isFinite(unit) || unit <= 0) return 'PORTFOLIO_ALLOCATION_VALUATION_REQUIRED';
    exposure += pending.quantity * unit;
  }
  const costDrag = portfolio.pending.reduce((sum, pending) => sum + Math.max(0, pending.cashUsd - pending.valueUsd), 0);
  const cap = (portfolio.equityUsd - costDrag) * Math.max(0, 1 - input.minCashPct / 100) * input.allocationPct / 100;
  return exposure > cap + 1e-8 ? 'PORTFOLIO_STRATEGY_BUDGET_EXCEEDED' : null;
}

/** Caller uses the owner/account fence for final execution; pending reservations share that same lock. */
export async function investorAllocationBlock(tx: Pick<MemoryFenceTransaction, 'select'>, owner: string,
  accountId: string, candidate: StrategyCandidate, config: StrategyMandateInput, portfolio: PortfolioRiskSnapshot,
  now = new Date()): Promise<string | null> {
  const rule = config.rules.find(item => item.id === candidate.ruleId);
  if (!rule?.userStrategyId || rule.allocationPct === undefined || candidate.side !== 'buy' || candidate.protectiveStop) return null;
  const [filled, reserved] = await Promise.all([
    tx.select({ candidate: strategySignals.candidate }).from(strategySignals)
      .where(and(eq(strategySignals.owner, owner), eq(strategySignals.state, 'filled'),
        sql`${strategySignals.candidate}->>'accountId' = ${accountId}`, sql`${strategySignals.candidate}->>'userStrategyId' = ${candidate.userStrategyId}`))
      .orderBy(strategySignals.updatedAt, strategySignals.createdAt, strategySignals.id),
    tx.select({ candidate: strategySignals.candidate }).from(strategyReservations)
      .innerJoin(strategySignals, eq(strategySignals.id, strategyReservations.signalId))
      .where(and(eq(strategyReservations.owner, owner), eq(strategyReservations.accountId, accountId),
        eq(strategyReservations.status, 'active'), gt(strategyReservations.expiresAt, now))),
  ]);
  return allocationBudgetBlock({ candidate, allocationPct: rule.allocationPct, minCashPct: config.limits.minCashPct ?? 0,
    portfolio, filled: filled.map(item => item.candidate),
    pending: reserved.map(item => item.candidate).filter(item => item.signalId !== candidate.signalId) });
}
