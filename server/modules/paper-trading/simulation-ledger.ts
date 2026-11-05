import { and, eq, isNull, lte, sql } from 'drizzle-orm';
import { BadRequestException } from '@nestjs/common';
import type { PostgresJsDatabase } from '../../common/platform';
import { simulationCash, simulationSettlements } from '../../database/simulation-experiments.schema';
import { tradingMarketSchedule } from './trading-market.calendar';
import type { Market } from '../../../shared/api.interface';

type Tx = Parameters<Parameters<PostgresJsDatabase['transaction']>[0]>[0];
/** Release cash only at a previously verified settlement date, under the account lock. */
export async function settleSimulationCash(tx: Tx, accountId: string, now = new Date()) {
  const due = await tx.select().from(simulationSettlements).where(and(eq(simulationSettlements.accountId, accountId),
    isNull(simulationSettlements.settledAt), lte(simulationSettlements.availableAt, now))).for('update');
  for (const item of due) {
    await tx.update(simulationCash).set({ available: sql`${simulationCash.available} + ${item.amount}`,
      unsettled: sql`${simulationCash.unsettled} - ${item.amount}` })
      .where(and(eq(simulationCash.accountId, accountId), eq(simulationCash.currency, item.currency)));
    await tx.update(simulationSettlements).set({ settledAt: now }).where(eq(simulationSettlements.id, item.id));
  }
}
/** Conservative release at the settlement day's close; not a broker's intraday availability promise. */
export function cashSettlementAt(market: Market, now = new Date()): Date {
  if (market === 'CN') return now;
  let remaining = market === 'HK' ? 2 : 1;
  const originalDate = tradingMarketSchedule(market, now).tradingDate;
  for (let day = 1; day <= 20; day += 1) {
    const next = tradingMarketSchedule(market, new Date(now.getTime() + day * 86400000));
    if (!next.calendarVerified) throw new BadRequestException('Settlement calendar unavailable');
    // These 2026 bank holidays have equity trading but no US money settlement.
    const moneyHoliday = market === 'US' && ['2026-10-12', '2026-11-11'].includes(next.tradingDate);
    if (next.tradingDate !== originalDate && next.isTradingDay && !moneyHoliday && --remaining === 0 && next.closesAt) return new Date(next.closesAt);
  }
  throw new BadRequestException('Settlement calendar unavailable');
}
export async function recordSimulationCashFill(tx: Tx, owner: string, accountId: string, currency: string,
  market: Market, side: 'buy' | 'sell', amount: number) {
  if (side === 'buy') {
    const [cash] = await tx.select().from(simulationCash).where(and(eq(simulationCash.accountId, accountId), eq(simulationCash.currency, currency))).for('update');
    if (!cash || Number(cash.available) + 1e-8 < amount) throw new BadRequestException('Insufficient available currency cash');
    await tx.update(simulationCash).set({ available: String(Number(cash.available) - amount) }).where(eq(simulationCash.id, cash.id));
    return;
  }
  const availableAt = cashSettlementAt(market);
  const immediate = availableAt.getTime() <= Date.now();
  await tx.insert(simulationCash).values({ owner, accountId, currency, available: immediate ? String(amount) : '0',
    unsettled: immediate ? '0' : String(amount), availabilityKnown: true }).onConflictDoUpdate({
    target: [simulationCash.accountId, simulationCash.currency], set: immediate
      ? { available: sql`${simulationCash.available} + ${amount}` }
      : { unsettled: sql`${simulationCash.unsettled} + ${amount}` },
  });
  if (!immediate) await tx.insert(simulationSettlements).values({ accountId, currency, amount: String(amount), availableAt });
}
