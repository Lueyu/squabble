import { BadRequestException, ConflictException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { positionBaselines } from '../../database/asset-ledger.schema';
import { closed, holdings, transactions } from '../../database/schema';
import type { PostgresJsDatabase } from '../../common/platform';
import { securityIdentity } from './screenshot-merge';

/** Keep one spelling for the same security across checkpoints, quick entry and broker imports. */
export async function resolvePositionTicker(tx: PostgresJsDatabase, owner: string, ticker: string): Promise<string> {
  const identity = securityIdentity(ticker);
  if (!identity) throw new BadRequestException('INVALID_TICKER');
  const [baselines, positions, ledger] = await Promise.all([
    tx.select({ ticker: positionBaselines.ticker, market: positionBaselines.market }).from(positionBaselines).where(eq(positionBaselines.owner, owner)),
    tx.select({ ticker: holdings.ticker, market: holdings.market }).from(holdings).where(eq(holdings.owner, owner)),
    tx.select({ ticker: transactions.ticker, txType: transactions.txType }).from(transactions).where(eq(transactions.owner, owner)),
  ]);
  const aliases = new Set([
    ...baselines.filter(row => securityIdentity(row.ticker, row.market)?.key === identity.key).map(row => row.ticker),
    ...positions.filter(row => securityIdentity(row.ticker, row.market ?? undefined)?.key === identity.key).map(row => row.ticker),
    ...ledger.filter(row => ['Buy', 'Sell', 'Opening'].includes(row.txType) && securityIdentity(row.ticker)?.key === identity.key).map(row => row.ticker),
  ]);
  if (aliases.size > 1) throw new ConflictException('POSITION_IDENTITY_REQUIRES_RECONCILIATION');
  return [...aliases][0] ?? identity.ticker;
}

/** Snapshot replacement is allowed only before subsequent ledger activity. */
export async function recordPositionCheckpoint(tx: PostgresJsDatabase, owner: string, value: {
  ticker: string; market: string; currency: string; shares: string; buyPrice: string | null; company: string | null;
}, existing: { shares: string; buyPrice: string | null; currency: string | null } | undefined, source: string, sourceId: string) {
  value = { ...value, ticker: await resolvePositionTicker(tx, owner, value.ticker) };
  const [baseline] = await tx.select().from(positionBaselines).where(and(eq(positionBaselines.owner, owner), eq(positionBaselines.ticker, value.ticker)));
  const ledger = await tx.select().from(transactions).where(and(eq(transactions.owner, owner), eq(transactions.ticker, value.ticker)));
  const later = baseline ? ledger.filter(row => !baseline.coveredTransactionIds.includes(row.id)) : ledger;
  const same = existing && Number(existing.shares) === Number(value.shares) && existing.currency === value.currency &&
    (existing.buyPrice === null ? value.buyPrice === null : value.buyPrice !== null && Math.abs(Number(existing.buyPrice) - Number(value.buyPrice)) < 1e-7);
  if (later.length && !same) throw new ConflictException('SNAPSHOT_REQUIRES_RECONCILIATION');
  if (baseline && later.length) return value.ticker;
  const closedRows = await tx.select({ id: closed.id }).from(closed).where(and(eq(closed.owner, owner), eq(closed.ticker, value.ticker)));
  const checkpoint = { owner, ticker: value.ticker, market: value.market, currency: value.currency, shares: value.shares, avgCost: value.buyPrice, company: value.company, source, sourceId, observedAt: new Date(), coveredTransactionIds: ledger.map(row => row.id), coveredClosedIds: closedRows.map(row => row.id) };
  if (baseline) await tx.update(positionBaselines).set(checkpoint).where(eq(positionBaselines.id, baseline.id));
  else await tx.insert(positionBaselines).values(checkpoint);
  return value.ticker;
}
