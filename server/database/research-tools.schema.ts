/**
 * 研究工具（research tools）用量登记表定义（Drizzle schema）。
 *
 * 职责边界：只声明 research_tool_usage 表结构与约束；任务的发起/结算逻辑
 * 在 modules/research-tools，本文件不管。对应增量迁移脚本
 * scripts/db/11_research_tools.sql。
 *
 * 上下游：import drizzle-orm、drizzle-orm/pg-core 与 users 表（./schema）；
 * 被 modules/research-tools 的 service 使用。
 *
 * 关键约定：status 受 CHECK 约束（research_tool_usage_status），合法值仅
 * 'reserved' / 'succeeded' / 'failed' / 'cancelled'；settledAt 可空表示尚未
 * 结算。
 */
import { sql } from 'drizzle-orm';
import { check, index, pgTable, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { users } from './schema';

/**
 * 研究工具用量表：每次联网研究任务登记一行 —— 先以 status='reserved' 占位
 * （防重复计费/防超量），任务结束后结算为 succeeded/failed/cancelled 并写入
 * settledAt。索引：按属主+创建日期（research_tool_usage_owner_date，用于
 * 用量统计窗口）、按属主+任务 id（research_tool_usage_owner_task，用于幂等
 * 查重）。
 */
export const researchToolUsage = pgTable(
  'research_tool_usage',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    owner: uuid('owner')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    taskId: varchar('task_id', { length: 160 }).notNull(),
    provider: varchar('provider', { length: 40 }).notNull().default('deepseek_search'),
    status: varchar('status', { length: 24 }).notNull().default('reserved'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    settledAt: timestamp('settled_at', { withTimezone: true }),
  },
  (table) => [
    index('research_tool_usage_owner_date').on(table.owner, table.createdAt),
    index('research_tool_usage_owner_task').on(table.owner, table.taskId),
    check(
      'research_tool_usage_status',
      sql`${table.status} IN ('reserved', 'succeeded', 'failed', 'cancelled')`,
    ),
  ],
);
