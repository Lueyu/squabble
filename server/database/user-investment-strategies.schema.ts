import { pgTable, text, uuid, integer, timestamp, jsonb, uniqueIndex, index } from 'drizzle-orm/pg-core';
import type { StrategyDraftInput, StrategySourceSnapshot, StrategyExecutionPreview, UserInvestmentStrategy, StrategyPreparationFailure } from '../../shared/user-investment-strategy.interface';

/** Authoring and immutable confirmation records; execution remains in the existing policy/mandate pipeline. */
export const userInvestmentStrategies = pgTable('user_investment_strategies', {
  id: uuid('id').primaryKey().defaultRandom(), owner: text('owner').notNull(), revision: integer('revision').notNull().default(1), parentId: uuid('parent_id'),
  status: text('status').$type<'draft' | 'confirmed'>().notNull().default('draft'), content: jsonb('content').$type<StrategyDraftInput>().notNull(),
  sources: jsonb('sources').$type<StrategySourceSnapshot[]>().notNull().default([]), preview: jsonb('preview').$type<StrategyExecutionPreview | null>(),
  confirmedAt: timestamp('confirmed_at', { withTimezone: true }), createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [index('user_investment_strategies_owner_updated').on(table.owner, table.updatedAt)]);
export const userInvestmentStrategyRevisions = pgTable('user_investment_strategy_revisions', {
  id: uuid('id').primaryKey().defaultRandom(), owner: text('owner').notNull(), strategyId: uuid('strategy_id').notNull().references(() => userInvestmentStrategies.id),
  revision: integer('revision').notNull(), snapshot: jsonb('snapshot').$type<UserInvestmentStrategy>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [uniqueIndex('user_investment_strategy_revision_unique').on(table.owner, table.strategyId, table.revision)]);
export const userInvestmentStrategyCurrent = pgTable('user_investment_strategy_current', {
  owner: text('owner').primaryKey(), strategyId: uuid('strategy_id').notNull().references(() => userInvestmentStrategies.id),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
/** One durable claim per user action. Ambiguous model requests are never replayed. */
export const userInvestmentStrategyPreparations = pgTable('user_investment_strategy_preparations', {
  owner: text('owner').notNull(), requestKey: text('request_key').notNull(), strategyId: uuid('strategy_id').notNull().references(() => userInvestmentStrategies.id),
  inputHash: text('input_hash').notNull(), status: text('status').$type<'pending' | 'succeeded' | 'failed'>().notNull(),
  result: jsonb('result').$type<UserInvestmentStrategy | StrategyPreparationFailure | null>(), createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [uniqueIndex('user_investment_strategy_preparation_key').on(table.owner, table.requestKey)]);
