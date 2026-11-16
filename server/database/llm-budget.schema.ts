/**
 * LLM 预算（llm budget）两张表定义（Drizzle schema）。
 *
 * 职责边界：只声明 llm_budget_settings / llm_budget_usage 的列与约束；
 * 预算判定、预留/结算逻辑在 modules/llm-budget，本文件不管。
 * 对应增量迁移脚本 scripts/db/07_llm_budget.sql。
 *
 * 上下游：import drizzle-orm/pg-core 与 users 表（./schema）；被
 * modules/llm-budget 的 service 使用。
 *
 * 关键约定：额度单位是 token（整数），调用次数单位是"次/天"或"次/任务"；
 * 单价单位是 USD / 每百万 token（numeric，可空表示不按价计费）。
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  numeric,
  pgTable,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { users } from './schema';

/**
 * LLM 预算设置表：每个属主（owner，主键）一行，owner 外键关联 users.id 且
 * onDelete: 'cascade'。默认额度（token 数）：日 60000、月 600000、单任务
 * 24000；单次调用输入上限 6000、输出上限 1000；每任务最多调用 8 次、每天
 * 最多 30 次。input/output_usd_per_million 为可空单价（USD/百万 token）。
 * 两条 CHECK：①额度大小关系链（input+output <= perTask <= daily <=
 * monthly <= 10^9 等上限）；②费率非负（0..100000，可空豁免）。
 */
export const llmBudgetSettings = pgTable(
  'llm_budget_settings',
  {
    owner: uuid('owner')
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
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
  },
  (table) => [
    check(
      'llm_budget_positive_limits',
      sql`${table.maxInputTokens} > 0 AND ${table.maxOutputTokens} > 0
    AND ${table.maxCallsPerTask} > 0 AND ${table.maxCallsPerTask} <= ${table.dailyCallLimit}
    AND ${table.maxInputTokens} + ${table.maxOutputTokens} <= ${table.perTaskTokenLimit}
    AND ${table.perTaskTokenLimit} <= ${table.dailyTokenLimit}
    AND ${table.dailyTokenLimit} <= ${table.monthlyTokenLimit}
    AND ${table.monthlyTokenLimit} <= 1000000000 AND ${table.maxInputTokens} <= 1000000
    AND ${table.maxOutputTokens} <= 1000000 AND ${table.maxCallsPerTask} <= 10000
    AND ${table.dailyCallLimit} <= 100000`,
    ),
    check(
      'llm_budget_nonnegative_rates',
      sql`
    (${table.inputUsdPerMillion} IS NULL OR ${table.inputUsdPerMillion} BETWEEN 0 AND 100000)
    AND (${table.outputUsdPerMillion} IS NULL OR ${table.outputUsdPerMillion} BETWEEN 0 AND 100000)`,
    ),
  ],
);

/**
 * LLM 用量流水表：每次调用一行，采用"预留-结算"两段式：先以
 * status='reserved' 写入并登记 reservedTokens（预占额度），任务结束后结算为
 * completed（实报）/ estimated（估算）/ failed_unknown（失败但用量未知），
 * 并把实扣 token 写入 chargedTokens、时间写入 settledAt（可空=未结算）。
 * CHECK：各 token 计数非负（maxOutput/reserved 必须 > 0）。索引：属主+日期
 * （日/月窗口统计）、属主+任务（任务维度聚合）。
 */
export const llmBudgetUsage = pgTable(
  'llm_budget_usage',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    owner: uuid('owner')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    taskId: varchar('task_id', { length: 160 }).notNull(),
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
  },
  (table) => [
    index('llm_budget_usage_owner_date').on(table.owner, table.createdAt),
    index('llm_budget_usage_owner_task').on(table.owner, table.taskId),
    check(
      'llm_budget_usage_status',
      sql`${table.status} IN ('reserved', 'completed', 'estimated', 'failed_unknown')`,
    ),
    check(
      'llm_budget_usage_nonnegative',
      sql`${table.inputTokens} >= 0 AND ${table.outputTokens} >= 0
    AND ${table.maxOutputTokens} > 0 AND ${table.reservedTokens} > 0 AND ${table.chargedTokens} >= 0`,
    ),
  ],
);
