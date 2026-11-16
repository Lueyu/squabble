import type { Market } from '../../../shared/api.interface';
import type { TradingCadence } from '../../../shared/council.interface';

export const DEFAULT_CADENCE: TradingCadence = {
  reviewEveryTradingDays: 5,
  maxOrdersPerWeek: 2,
  cooldownTradingDays: 3,
  maxWeeklyTurnoverPct: 10,
};
const ZONES: Record<Market, string> = {
  US: 'America/New_York',
  HK: 'Asia/Hong_Kong',
  CN: 'Asia/Shanghai',
};

export function normalizeCadence(input?: TradingCadence): TradingCadence {
  const value = input ?? DEFAULT_CADENCE;
  for (const [key, min, max] of [
    ['reviewEveryTradingDays', 1, 60],
    ['maxOrdersPerWeek', 1, 20],
    ['cooldownTradingDays', 0, 60],
  ] as const) {
    if (!Number.isInteger(value[key]) || value[key] < min || value[key] > max)
      throw new Error(`Invalid ${key}`);
  }
  if (
    !Number.isFinite(value.maxWeeklyTurnoverPct) ||
    value.maxWeeklyTurnoverPct < 0.1 ||
    value.maxWeeklyTurnoverPct > 100
  ) {
    throw new Error('Weekly turnover must be between 0.1 and 100%');
  }
  return {
    reviewEveryTradingDays: value.reviewEveryTradingDays,
    maxOrdersPerWeek: value.maxOrdersPerWeek,
    cooldownTradingDays: value.cooldownTradingDays,
    maxWeeklyTurnoverPct: value.maxWeeklyTurnoverPct,
  };
}

export function marketDate(market: Market, now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: ZONES[market],
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

/** Matches the app's market clock: weekdays only, no exchange holiday calendar. */
export function elapsedTradingDays(from: string, to: string): number {
  const cursor = new Date(`${from}T12:00:00Z`);
  const end = new Date(`${to}T12:00:00Z`);
  if (!Number.isFinite(cursor.getTime()) || !Number.isFinite(end.getTime()) || cursor >= end)
    return 0;
  let count = 0;
  // Dates older than a year necessarily exceed every configurable cooldown.
  if (end.getTime() - cursor.getTime() > 366 * 86400000) return 260;
  while (cursor < end) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    if (cursor.getUTCDay() !== 0 && cursor.getUTCDay() !== 6) count += 1;
  }
  return count;
}

export function reviewDue(
  oldHash: string | null,
  newHash: string,
  lastDate: string | null,
  today: string,
  days: number,
): boolean {
  return !lastDate || oldHash !== newHash || elapsedTradingDays(lastDate, today) >= days;
}

export interface CadenceOrder {
  ticker: string;
  market: Market;
  createdAt: Date;
  status: string;
  notionalUsd: number;
}

/** Evaluate against the account's locked ledger; pending orders reserve capacity. */
export function cadenceRejection(
  config: TradingCadence,
  context: {
    ticker: string;
    market: Market;
    notionalUsd: number;
    equityUsd: number;
    orders: CadenceOrder[];
    now?: Date;
  },
): string | null {
  const now = context.now ?? new Date();
  const today = marketDate(context.market, now);
  const committed = context.orders.filter(
    (order) => order.status === 'filled' || order.status === 'pending_approval',
  );
  // A single account-wide rolling seven-day cap cannot be reset by switching markets.
  const week = committed.filter(
    (order) =>
      order.status === 'pending_approval' ||
      order.createdAt.getTime() > now.getTime() - 7 * 86400000,
  );
  if (week.length >= config.maxOrdersPerWeek) return 'weekly_order_cap';
  if (!Number.isFinite(context.equityUsd) || context.equityUsd <= 0) return 'equity_unavailable';
  const turnover = week.reduce((sum, order) => sum + Math.max(0, order.notionalUsd), 0);
  if (
    turnover + context.notionalUsd >
    (context.equityUsd * config.maxWeeklyTurnoverPct) / 100 + 0.000001
  )
    return 'weekly_turnover';
  const last = committed
    .filter((order) => order.ticker.toUpperCase() === context.ticker.toUpperCase())
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
  if (
    last &&
    elapsedTradingDays(marketDate(context.market, last.createdAt), today) <
      config.cooldownTradingDays
  )
    return 'ticker_cooldown';
  return null;
}
