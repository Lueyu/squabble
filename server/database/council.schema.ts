/**
 * 投资委员会（council）三张表定义（Drizzle schema）。
 *
 * 职责边界：只声明 council_sessions / council_messages / council_reports 的
 * 列、外键与索引；会话编排与状态机逻辑在 modules/council，本文件不管。
 * 对应增量迁移脚本 scripts/db/08_investment_council.sql 与
 * 12_council_dialogue.sql。
 *
 * 上下游：import drizzle-orm/pg-core、共享类型（@shared/api.interface、
 * @shared/council.interface）与 council 模块的类型（CouncilEvidence/
 * CouncilCheckpoint/CouncilMessageMetadata）；被 modules/council 读写。
 *
 * 关键约定：时间戳列均 withTimezone: true 且 mode: 'date'；sessions 与
 * reports 都带 revision（会话可多轮修订）；reports 以 (session_id, version)
 * 唯一索引保证同会话同版本仅一份报告。
 */
import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import type { BuilderConfig } from '@shared/api.interface';
import type { CouncilCandidate, CouncilReport } from '@shared/council.interface';
import type { CouncilEvidence } from '../modules/council/council.rules';
import type { CouncilCheckpoint, CouncilMessageMetadata } from '../modules/council/council.types';

/**
 * 委员会评审会话表：一次"对某标的的某 profile 做多角色评审"的完整状态。
 * 状态机：idle -> running -> completed / paused / failed（status 列约束在
 * TS 类型层）。profile_snapshot 冻结评审时用的画像快照；evidence_snapshot
 * 冻结输入证据；checkpoint 保存可续跑的断点；cacheKey 用于同属主同输入的
 * 结果复用；error 记失败原因；candidate 是最新候选决策。
 */
export const councilSessions = pgTable(
  'council_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    owner: text('owner').notNull(),
    profileId: uuid('profile_id'),
    profileVersion: integer('profile_version').notNull(),
    profileSnapshot: jsonb('profile_snapshot').$type<BuilderConfig>().notNull(),
    ticker: varchar('ticker', { length: 20 }).notNull(),
    language: varchar('language', { length: 5 }).$type<'zh-CN' | 'en'>().notNull().default('zh-CN'),
    status: varchar('status', { length: 16 })
      .$type<'idle' | 'running' | 'completed' | 'paused' | 'failed'>()
      .notNull()
      .default('idle'),
    revision: integer('revision').notNull().default(1),
    taskId: uuid('task_id').notNull().defaultRandom(),
    candidate: jsonb('candidate').$type<CouncilCandidate | null>(),
    evidenceSnapshot: jsonb('evidence_snapshot')
      .$type<CouncilEvidence[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    sourceRunId: uuid('source_run_id'),
    cacheKey: varchar('cache_key', { length: 64 }),
    error: text('error'),
    checkpoint: jsonb('checkpoint').$type<CouncilCheckpoint | null>(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    // 列表查询：按属主 + 创建时间倒序。
    index('council_sessions_owner_created_idx').on(table.owner, table.createdAt),
    // 缓存命中查询：按属主 + cacheKey + 创建时间。
    index('council_sessions_cache_idx').on(table.owner, table.cacheKey, table.createdAt),
  ],
);

/**
 * 委员会对话消息表：会话内每个角色（researcher/challenger/manager/user/
 * system）的每条发言。sessionId 外键关联 council_sessions.id 且
 * onDelete: 'cascade'（删除会话时消息一并删除）。tokensUsed 记录该消息消耗
 * 的 token 数（计费用）。
 */
export const councilMessages = pgTable(
  'council_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    owner: text('owner').notNull(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => councilSessions.id, { onDelete: 'cascade' }),
    role: varchar('role', { length: 16 })
      .$type<'researcher' | 'challenger' | 'manager' | 'user' | 'system'>()
      .notNull(),
    memberName: varchar('member_name', { length: 40 }).notNull(),
    content: text('content').notNull(),
    revision: integer('revision').notNull(),
    tokensUsed: integer('tokens_used').notNull().default(0),
    metadata: jsonb('metadata').$type<CouncilMessageMetadata | null>(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    // 按属主 + 会话 + 时间取全部消息（回放对话）。
    index('council_messages_session_idx').on(table.owner, table.sessionId, table.createdAt),
  ],
);

/**
 * 委员会结论报告表：一轮评审的最终产出。decision 三值：approve/wait/reject；
 * dissent 保存反对意见；nextReviewCondition 是"何时再评"的触发条件；
 * paperOrderId 关联模拟盘（paper trading）订单 id，可空表示未下单；
 * engine 标注生成引擎（basic/llm/local/a2a/mixed）。(session_id, version)
 * 上的唯一索引保证同一会话同一 version 只有唯一一份报告。
 */
export const councilReports = pgTable(
  'council_reports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    owner: text('owner').notNull(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => councilSessions.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    revision: integer('revision').notNull(),
    decision: varchar('decision', { length: 10 }).$type<'approve' | 'wait' | 'reject'>().notNull(),
    summary: text('summary').notNull(),
    dissent: jsonb('dissent').$type<string[]>().notNull(),
    nextReviewCondition: text('next_review_condition').notNull(),
    evidence: jsonb('evidence').$type<CouncilReport['evidence']>().notNull(),
    sourceRunId: uuid('source_run_id'),
    candidate: jsonb('candidate').$type<CouncilCandidate | null>(),
    paperOrderId: uuid('paper_order_id'),
    tokensUsed: integer('tokens_used').notNull().default(0),
    engine: varchar('engine', { length: 10 })
      .$type<'basic' | 'llm' | 'local' | 'a2a' | 'mixed'>()
      .notNull(),
    researchStance: varchar('research_stance', { length: 10 }).$type<
      'positive' | 'balanced' | 'cautious' | null
    >(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    // 同会话同版本唯一（防重复写报告）。
    uniqueIndex('council_reports_version_idx').on(table.sessionId, table.version),
    // 属主维度的历史查询。
    index('council_reports_owner_idx').on(table.owner, table.sessionId, table.createdAt),
  ],
);
