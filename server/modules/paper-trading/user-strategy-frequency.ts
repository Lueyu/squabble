import { and, eq, inArray, sql } from 'drizzle-orm';
import { strategyPlans, strategySignals } from '../../database/strategy.schema';
import { strategyReservations } from '../../database/strategy-mandates.schema';
import type { MemoryFenceTransaction } from '../research-memory/research-memory.fence';
import type { CompiledStrategyDirective } from '../../../shared/user-investment-strategy.interface';
import type { StrategyCandidate } from '../../../shared/strategy.interface';
import { isSameInvestorEntry } from './user-strategy-runtime';
import { tradingMarketSchedule } from './trading-market.calendar';

/** Called under the same owner/account lock for both candidate claim and final order placement.
 * Daily identity comes from a verified exchange calendar and the immutable daily plan, never UTC date or a client counter.
 * Legacy entries with no explicit frequency retain their lifetime once-only consumption.
 */
export async function investorEntryFrequencyBlock(tx: MemoryFenceTransaction, owner: string, accountId: string,
  strategyId: string, directive: CompiledStrategyDirective, candidate: StrategyCandidate, now: Date): Promise<string | null> {
  const daily = directive.executionFrequency?.kind === 'per_trading_day';
  let tradingDate: string | null = null;
  if (daily) {
    const schedule = tradingMarketSchedule(candidate.market, now);
    const [plan] = await tx.select().from(strategyPlans).where(and(eq(strategyPlans.owner, owner), eq(strategyPlans.id, candidate.planId)));
    if (!schedule.calendarVerified || !schedule.isTradingDay || !schedule.isOpen || !plan
      || plan.market !== candidate.market || plan.marketDate !== schedule.tradingDate || plan.accountId !== accountId
      || plan.version !== candidate.planVersion || plan.status !== 'active' || plan.expiresAt <= now) {
      return 'USER_STRATEGY_TRADING_DAY_UNVERIFIED';
    }
    tradingDate = schedule.tradingDate;
  }
  const signals = await tx.select({ signal: strategySignals, planDate: strategyPlans.marketDate,
    reservationStatus: strategyReservations.status, reservationExpiresAt: strategyReservations.expiresAt })
    .from(strategySignals)
    .leftJoin(strategyPlans, and(eq(strategyPlans.owner, owner), eq(strategyPlans.id, strategySignals.planId)))
    .leftJoin(strategyReservations, and(eq(strategyReservations.owner, owner), eq(strategyReservations.signalId, strategySignals.id)))
    .where(and(eq(strategySignals.owner, owner), inArray(strategySignals.state, ['filled', 'reviewing', 'approved']),
      sql`${strategySignals.candidate}->>'accountId' = ${accountId}`,
      sql`${strategySignals.candidate}->>'userStrategyId' = ${strategyId}`));
  for (const item of signals) {
    if (item.signal.id === candidate.signalId || !isSameInvestorEntry(item.signal.candidate, accountId, strategyId, directive.entryId)) continue;
    // Missing historical plan identity cannot prove that a fill belongs to a different day.
    if (daily && item.planDate && item.planDate !== tradingDate) continue;
    if (item.signal.state === 'filled') return daily ? 'USER_STRATEGY_DAILY_EXECUTION_LIMIT' : 'USER_STRATEGY_ENTRY_ALREADY_EXECUTED';
    if (item.reservationStatus === 'active' && item.reservationExpiresAt && item.reservationExpiresAt > now) {
      return 'USER_STRATEGY_ENTRY_PENDING';
    }
  }
  return null;
}
