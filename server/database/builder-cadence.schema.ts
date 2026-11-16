/**
 * Builder cadence 相关表定义（Drizzle schema）。
 *
 * 职责边界：只声明 builder_scan_leases / builder_review_checks 两张表的列与
 * 约束；不含查询逻辑。对应增量迁移脚本 scripts/db/09_builder_cadence.sql。
 *
 * 上下游：import drizzle-orm/pg-core；被 agent-builder 相关模块引用。
 *
 * 关键约定：所有时间戳列均为 withTimezone: true（timestamptz，UTC 存储）。
 */
import { pgTable, text, uuid, integer, timestamp, primaryKey } from 'drizzle-orm/pg-core';

/**
 * builder 扫描租约（lease）表：每个属主（owner，主键）至多一条租约记录，
 * token 为本次租约持有者的 uuid 标识，expiresAt 为租约过期时间（timestamptz），
 * 由 agent-builder 模块据此实现扫描互斥/接管。
 */
export const builderScanLeases = pgTable('builder_scan_leases', {
  owner: text('owner').primaryKey(),
  token: uuid('token').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});

/**
 * builder 审核检查（review check）记录表：复合主键 (owner, profile_id,
 * ticker)，记录某个投资画像（profile）对某只标的在某 profile 版本、某输入
 * hash 下的审核决定与原因。input_hash 用于标识触发本次审核的输入内容，
 * reviewed_at 为审核时间（timestamptz）。
 */
export const builderReviewChecks = pgTable(
  'builder_review_checks',
  {
    owner: text('owner').notNull(),
    profileId: uuid('profile_id').notNull(),
    ticker: text('ticker').notNull(),
    profileVersion: integer('profile_version').notNull(),
    inputHash: text('input_hash').notNull(),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }).notNull(),
    decision: text('decision').notNull(),
    reason: text('reason').notNull(),
  },
  (table) => [primaryKey({ columns: [table.owner, table.profileId, table.ticker] })],
);
