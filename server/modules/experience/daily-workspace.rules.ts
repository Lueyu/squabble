import { BadRequestException } from '@nestjs/common';
import type { DailyAccountFacts } from '../../../shared/daily-workspace.interface';

export function dailyDate(input?: string, now = new Date()): string {
  if (input !== undefined && typeof input !== 'string') throw new BadRequestException('INVALID_DAILY_DATE');
  if (!input) return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const date = new Date(`${input}T12:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(input) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== input) {
    throw new BadRequestException('INVALID_DAILY_DATE');
  }
  return input;
}
const numeric = (value: string | number | null): number | null => value !== null && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null;
export function dailyAccountFacts(
  account: { id: string; name: string; status: string }, date: string,
  snapshots: Array<{ snapshotDate: string; equity: string; cash: string; dailyPl: string; valuedAt: Date | null }>,
  trades: Array<{ id: string; orderId: string; ticker: string; side: string; quantity: string; price: string; fee: string | null; currency: string | null; createdAt: Date }>,
  orders: Array<{ id: string; ticker: string; side: string; status: string; reason: string | null; createdAt: Date }>,
): DailyAccountFacts {
  const snapshot = snapshots.find(row => row.snapshotDate === date);
  const previousDate = new Date(Date.parse(`${date}T12:00:00Z`) - 86400000).toISOString().slice(0, 10);
  const previous = snapshots.find(row => row.snapshotDate === previousDate);
  const gaps: string[] = [];
  if (!snapshot?.valuedAt) gaps.push('VALUATION_TIME_UNKNOWN');
  if (!previous?.valuedAt) gaps.push('DAILY_BASELINE_MISSING');
  const reconciled = snapshot && previous && Math.abs(Number(snapshot.equity) - Number(previous.equity) - Number(snapshot.dailyPl)) < 0.02;
  if (snapshot && previous && !reconciled) gaps.push('DAILY_RECONCILIATION_REQUIRED');
  const afterValuation = snapshot?.valuedAt && trades.some(row => row.createdAt > snapshot.valuedAt!);
  if (afterValuation) gaps.push('FILL_AFTER_VALUATION');
  if (trades.some(row => numeric(row.fee) === null || !row.currency)) gaps.push('TRADE_FIELDS_UNKNOWN');
  // dailyPl is an archived ledger result. Missing/stale timestamps never imply a current day's result.
  return { ...account, date, openingEquityUsd: previous ? numeric(previous.equity) : null, equityUsd: snapshot ? numeric(snapshot.equity) : null,
    cashUsd: snapshot ? numeric(snapshot.cash) : null,
    dailyPnlUsd: snapshot?.valuedAt && previous?.valuedAt && reconciled && !afterValuation ? numeric(snapshot.dailyPl) : null,
    valuationAsOf: snapshot?.valuedAt?.toISOString() ?? null, gaps,
    trades: trades.map(row => ({ id: row.id, orderId: row.orderId, ticker: row.ticker, side: row.side,
      quantity: numeric(row.quantity), price: numeric(row.price), fee: numeric(row.fee), currency: row.currency, feeCurrency: 'USD',
      executedAt: row.createdAt.toISOString() })),
    notExecuted: orders.filter(row => row.status !== 'filled')
      .map(row => ({ id: row.id, ticker: row.ticker, side: row.side, status: row.status, reason: row.reason, recordedAt: row.createdAt.toISOString() })),
  };
}
