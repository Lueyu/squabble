import { pgTable, text, uuid, integer, timestamp, jsonb, uniqueIndex, numeric } from 'drizzle-orm/pg-core';
import type { StrategyRule, StrategyCandidate, StrategyMarketRuntime } from '../../shared/strategy.interface';

export const strategyTasks = pgTable('strategy_tasks', {
  id: uuid('id').primaryKey().defaultRandom(), owner: text('owner').notNull(),
  profileId: uuid('profile_id').notNull(), profileVersion: integer('profile_version').notNull(),
  market: text('market').notNull(), marketDate: text('market_date').notNull(),
  attempt: integer('attempt').notNull().default(0), state: text('state').notNull().default('claimed'),
  sessionIds: jsonb('session_ids').$type<string[]>().notNull().default([]), reason: text('reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex('strategy_task_unique').on(table.owner, table.profileId, table.profileVersion, table.market, table.marketDate, table.attempt)]);
export const strategyPlans = pgTable('strategy_plans', {
  memoryInventory: jsonb('memory_inventory').$type<import('@shared/research-monitor.interface').StrategyMemoryInventory>(),
  id: uuid('id').primaryKey().defaultRandom(), owner: text('owner').notNull(),
  profileId: uuid('profile_id').notNull(), profileVersion: integer('profile_version').notNull(),
  taskId: uuid('task_id').notNull().unique(), version: integer('version').notNull(),
  market: text('market').notNull(), marketDate: text('market_date').notNull(), status: text('status').notNull().default('active'),
  rules: jsonb('rules').$type<StrategyRule[]>().notNull(), sessionIds: jsonb('session_ids').$type<string[]>().notNull(),
  reportIds: jsonb('report_ids').$type<string[]>().notNull(), summary: text('summary').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
export const strategySignals = pgTable('strategy_signals', {
  id: uuid('id').primaryKey(), owner: text('owner').notNull(), profileId: uuid('profile_id').notNull(),
  planId: uuid('plan_id').notNull(), ruleId: text('rule_id').notNull(), kind: text('kind').notNull(),
  state: text('state').notNull(), candidate: jsonb('candidate').$type<StrategyCandidate>().notNull(),
  reason: text('reason').notNull(), orderId: uuid('order_id').unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex('strategy_signal_unique').on(table.planId, table.ruleId, table.kind)]);
export const strategyRuntime = pgTable('strategy_runtime', {
  id: uuid('id').primaryKey().defaultRandom(), owner: text('owner').notNull(), profileId: uuid('profile_id').notNull(),
  profileVersion: integer('profile_version').notNull(), market: text('market').notNull(),
  data: jsonb('data').$type<StrategyMarketRuntime>().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex('strategy_runtime_unique').on(table.owner, table.profileId, table.market)]);
export const strategyOutbox = pgTable('strategy_outbox', {
  id: uuid('id').primaryKey().defaultRandom(), owner: text('owner').notNull(), profileId: uuid('profile_id').notNull(),
  eventKey: text('event_key').notNull().unique(), payload: jsonb('payload').$type<{ event: string; title: string; body: string }>().notNull(),
  state: text('state').notNull().default('pending'), attempts: integer('attempts').notNull().default(0),
  deliveredChannelIds: jsonb('delivered_channel_ids').$type<string[]>().notNull().default([]),
  availableAt: timestamp('available_at', { withTimezone: true }).notNull().defaultNow(),
  deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
/** Position protection outlives a daily plan and is removed only when the position is closed/reset. */
export const strategyProtections = pgTable('strategy_protections', {
  id: uuid('id').primaryKey().defaultRandom(), owner: text('owner').notNull(), accountId: uuid('account_id').notNull(),
  ticker: text('ticker').notNull(), market: text('market').notNull(), stopLossPrice: numeric('stop_loss_price').notNull(),
  planId: uuid('plan_id').notNull(), ruleId: text('rule_id').notNull(), version: integer('version').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex('strategy_protection_unique').on(table.owner, table.accountId, table.ticker)]);
