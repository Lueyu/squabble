import { sql } from 'drizzle-orm';
import { jsonb, numeric, pgTable, text, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import { customTimestamptz } from './schema';

/** A provenance-bearing checkpoint, never a fabricated trade or cash flow. */
export const positionBaselines = pgTable('position_baselines', {
  id: uuid('id').primaryKey().defaultRandom(),
  owner: text('owner').notNull(),
  ticker: varchar('ticker', { length: 20 }).notNull(),
  market: varchar('market', { length: 10 }).notNull(),
  currency: varchar('currency', { length: 10 }).notNull(),
  shares: numeric('shares').notNull(),
  avgCost: numeric('avg_cost'),
  company: text('company'),
  source: text('source').notNull(),
  sourceId: text('source_id'),
  observedAt: customTimestamptz('observed_at', { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  coveredTransactionIds: jsonb('covered_transaction_ids').$type<string[]>().notNull().default([]),
  coveredClosedIds: jsonb('covered_closed_ids').$type<string[]>().notNull().default([]),
}, table => [uniqueIndex('idx_position_baselines_owner_ticker').on(table.owner, table.ticker)]);

/** Original duplicate rows remain available for deliberate reconciliation. */
export const cashAccountConflicts = pgTable('cash_account_conflicts', {
  id: uuid('id').primaryKey(),
  owner: text('owner').notNull(),
  currency: varchar('currency', { length: 10 }).notNull(),
  original: jsonb('original').notNull(),
  archivedAt: customTimestamptz('archived_at', { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
});
export const cashBalanceConfirmations = pgTable('cash_balance_confirmations', {
  id: uuid('id').primaryKey().defaultRandom(), owner: text('owner').notNull(), requestKey: text('request_key').notNull(),
  inputHash: text('input_hash').notNull(), changes: jsonb('changes').notNull(),
  createdAt: customTimestamptz('created_at', { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
}, table => [uniqueIndex('idx_cash_confirmations_owner_request').on(table.owner, table.requestKey)]);
