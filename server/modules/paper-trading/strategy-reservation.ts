import { and, eq, gt, ne } from 'drizzle-orm';
import type { MemoryFenceTransaction } from '../research-memory/research-memory.fence';
import type { StrategyCandidate } from '../../../shared/strategy.interface';
import { strategyReservations } from '../../database/strategy-mandates.schema';
import { strategySignals } from '../../database/strategy.schema';
import { paperPositions } from '../../database/schema';
import { simulationCash } from '../../database/simulation-experiments.schema';
import { resolveTradingTicker } from '../../../shared/trading-market.interface';
import { executionEconomics } from './simulation-experiments.rules';

export async function settleStrategyReservation(tx: MemoryFenceTransaction, owner: string, signalId: string,
  status: 'consumed' | 'released', reason: string): Promise<void> {
  await tx.update(strategyReservations).set({ status, reason: reason.slice(0, 500), updatedAt: new Date() })
    .where(and(eq(strategyReservations.owner, owner), eq(strategyReservations.signalId, signalId), eq(strategyReservations.status, 'active')));
}
/** Caller already holds owner and account locks. Reservation does not debit the currency ledger twice. */
export async function reserveStrategyCandidate(tx: MemoryFenceTransaction, owner: string,
  account: { id: string; ledgerMode: string; cashBalance: string; executionModel?: { feeBps: number; slippageBps: number } },
  candidate: StrategyCandidate, ttlSeconds = 1200): Promise<boolean> {
  const now = new Date();
  if (candidate.protectiveStop) {
    const obsolete = await tx.select().from(strategyReservations).where(and(eq(strategyReservations.owner, owner),
      eq(strategyReservations.accountId, account.id), eq(strategyReservations.ticker, candidate.ticker), eq(strategyReservations.status, 'active')));
    for (const reservation of obsolete) {
      const [signal] = await tx.select().from(strategySignals).where(eq(strategySignals.id, reservation.signalId));
      if (!signal || signal.candidate.protectiveStop || signal.state === 'filled') continue;
      await settleStrategyReservation(tx, owner, signal.id, 'released', 'Protective exit supersedes pending risk');
      await tx.update(strategySignals).set({ state: 'cancelled', reason: 'Protective exit supersedes pending risk', updatedAt: now }).where(eq(strategySignals.id, signal.id));
    }
  }
  const active = await tx.select().from(strategyReservations).where(and(eq(strategyReservations.owner, owner),
    eq(strategyReservations.accountId, account.id), eq(strategyReservations.status, 'active'), gt(strategyReservations.expiresAt, now),
    ne(strategyReservations.signalId, candidate.signalId)));
  const currency = account.ledgerMode === 'native_currency' ? resolveTradingTicker(candidate.ticker)?.currency : 'USD';
  if (!currency) return false;
  const economics = executionEconomics(candidate.price, candidate.quantity, candidate.side, account.executionModel?.feeBps ?? 0, account.executionModel?.slippageBps ?? 0);
  const fx = candidate.notionalUsd ? candidate.notionalUsd / (candidate.quantity * candidate.price) : 1;
  const cash = candidate.side === 'buy' ? economics.cashAmount * (account.ledgerMode === 'native_currency' ? 1 : fx) : 0;
  if (!Number.isFinite(cash) || cash < 0) return false;
  if (candidate.side === 'buy') {
    let available = Number(account.cashBalance);
    if (account.ledgerMode === 'native_currency') {
      const [balance] = await tx.select().from(simulationCash).where(and(eq(simulationCash.owner, owner),
        eq(simulationCash.accountId, account.id), eq(simulationCash.currency, currency)));
      available = balance?.availabilityKnown ? Number(balance.available) : 0;
    }
    const reserved = active.filter(r => r.currency === currency).reduce((sum, r) => sum + Number(r.cash), 0);
    if (cash > available - reserved + 1e-8) return false;
  } else {
    const [position] = await tx.select().from(paperPositions).where(and(eq(paperPositions.owner, owner), eq(paperPositions.accountId, account.id),
      eq(paperPositions.ticker, candidate.ticker)));
    const reserved = active.filter(r => r.ticker === candidate.ticker && r.side === 'sell').reduce((sum, r) => sum + Number(r.shares), 0);
    if (candidate.quantity > Number(position?.shares ?? 0) - Number(position?.restrictedShares ?? 0) - reserved + 1e-8) return false;
  }
  await tx.insert(strategyReservations).values({ signalId: candidate.signalId, owner, accountId: account.id,
    ticker: candidate.ticker, side: candidate.side, currency, cash: String(cash), shares: String(candidate.side === 'sell' ? candidate.quantity : 0),
    expiresAt: new Date(Math.min(Date.parse(candidate.quoteAt) + ttlSeconds * 1000, now.getTime() + ttlSeconds * 1000)) });
  return true;
}
