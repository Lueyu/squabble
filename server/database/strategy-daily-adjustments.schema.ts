import { pgTable, text, uuid, integer, timestamp, jsonb, uniqueIndex } from 'drizzle-orm/pg-core';
import type { StrategyRule } from '../../shared/strategy.interface';

/** A paid daily adjustment is claimed once; pending/failed claims are never replayed. */
export const strategyDailyAdjustments = pgTable('strategy_daily_adjustments', {
  id: uuid('id').primaryKey().defaultRandom(), owner: text('owner').notNull(),
  mandateId: uuid('mandate_id').notNull(), mandateVersion: integer('mandate_version').notNull(), mandateRevision: integer('mandate_revision').notNull(),
  profileId: uuid('profile_id').notNull(), profileVersion: integer('profile_version').notNull(), accountId: uuid('account_id').notNull(),
  market: text('market').notNull(), marketDate: text('market_date').notNull(), inputHash: text('input_hash').notNull(),
  state: text('state').$type<'pending' | 'succeeded' | 'failed'>().notNull().default('pending'),
  input: jsonb('input').$type<Record<string, unknown> | null>(), output: jsonb('output').$type<unknown>(),
  rules: jsonb('rules').$type<StrategyRule[] | null>(), error: text('error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [uniqueIndex('strategy_daily_adjustments_scope_idx').on(t.owner, t.mandateId, t.market, t.marketDate)]);
