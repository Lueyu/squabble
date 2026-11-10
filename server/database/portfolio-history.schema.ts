import { date, jsonb, numeric, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

/** Public market observations only. No owner holdings or account identifiers enter these shared caches. */
export const portfolioHistoryPrices = pgTable('portfolio_history_prices', {
  symbol: text('symbol').notNull(), market: text('market').notNull(), currency: text('currency').notNull(),
  priceDate: date('price_date').notNull(), close: numeric('close').notNull(), source: text('source').notNull(),
  fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [uniqueIndex('portfolio_history_price_key').on(table.symbol, table.priceDate)]);

export const portfolioHistoryFx = pgTable('portfolio_history_fx', {
  currency: text('currency').notNull(), rateDate: date('rate_date').notNull(), usdRate: numeric('usd_rate').notNull(),
  source: text('source').notNull(), fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [uniqueIndex('portfolio_history_fx_key').on(table.currency, table.rateDate)]);

export const portfolioHistoryFetches = pgTable('portfolio_history_fetches', {
  resource: text('resource').primaryKey(), leaseToken: text('lease_token'),
  leaseUntil: timestamp('lease_until', { withTimezone: true }), nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull(),
  completedAt: timestamp('completed_at', { withTimezone: true }), error: text('error'),
  coverage: jsonb('coverage').$type<{ from: string; to: string; observations: number } | null>(),
});
