import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, numeric, pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { users } from './schema';

export const llmBudgetSettings = pgTable('llm_budget_settings', {
  owner: uuid('owner').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  enabled: boolean('enabled').notNull().default(true),
  dailyTokenLimit: integer('daily_token_limit').notNull().default(60000),
  monthlyTokenLimit: integer('monthly_token_limit').notNull().default(600000),
  perTaskTokenLimit: integer('per_task_token_limit').notNull().default(24000),
  maxInputTokens: integer('max_input_tokens').notNull().default(6000),
  maxOutputTokens: integer('max_output_tokens').notNull().default(1000),
  maxCallsPerTask: integer('max_calls_per_task').notNull().default(8),
  dailyCallLimit: integer('daily_call_limit').notNull().default(30),
  inputUsdPerMillion: numeric('input_usd_per_million'),
  outputUsdPerMillion: numeric('output_usd_per_million'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  check('llm_budget_positive_limits', sql`${table.maxInputTokens} > 0 AND ${table.maxOutputTokens} > 0
    AND ${table.maxCallsPerTask} > 0 AND ${table.maxCallsPerTask} <= ${table.dailyCallLimit}
    AND ${table.maxInputTokens} + ${table.maxOutputTokens} <= ${table.perTaskTokenLimit}
    AND ${table.perTaskTokenLimit} <= ${table.dailyTokenLimit}
    AND ${table.dailyTokenLimit} <= ${table.monthlyTokenLimit}
    AND ${table.monthlyTokenLimit} <= 1000000000 AND ${table.maxInputTokens} <= 1000000
    AND ${table.maxOutputTokens} <= 1000000 AND ${table.maxCallsPerTask} <= 10000
    AND ${table.dailyCallLimit} <= 100000`),
  check('llm_budget_nonnegative_rates', sql`
    (${table.inputUsdPerMillion} IS NULL OR ${table.inputUsdPerMillion} BETWEEN 0 AND 100000)
    AND (${table.outputUsdPerMillion} IS NULL OR ${table.outputUsdPerMillion} BETWEEN 0 AND 100000)`),
]);

export const llmBudgetUsage = pgTable('llm_budget_usage', {
  id: uuid('id').primaryKey().defaultRandom(),
  owner: uuid('owner').notNull().references(() => users.id, { onDelete: 'cascade' }),
  taskId: varchar('task_id', { length: 160 }).notNull(),
  dispatchKey: text('dispatch_key'),
  requestHash: text('request_hash'),
  purpose: varchar('purpose', { length: 160 }).notNull(),
  model: varchar('model', { length: 120 }).notNull(),
  inputTokens: integer('input_tokens').notNull(),
  outputTokens: integer('output_tokens').notNull(),
  maxOutputTokens: integer('max_output_tokens').notNull(),
  reservedTokens: integer('reserved_tokens').notNull(),
  chargedTokens: integer('charged_tokens').notNull(),
  status: varchar('status', { length: 24 }).notNull().default('reserved'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  settledAt: timestamp('settled_at', { withTimezone: true }),
}, (table) => [
  index('llm_budget_usage_owner_date').on(table.owner, table.createdAt),
  index('llm_budget_usage_owner_task').on(table.owner, table.taskId),
  check('llm_budget_usage_status', sql`${table.status} IN ('reserved', 'completed', 'estimated', 'failed_unknown')`),
  check('llm_budget_usage_nonnegative', sql`${table.inputTokens} >= 0 AND ${table.outputTokens} >= 0
    AND ${table.maxOutputTokens} > 0 AND ${table.reservedTokens} > 0 AND ${table.chargedTokens} >= 0`),
]);
