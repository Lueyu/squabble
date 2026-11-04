import { sql } from 'drizzle-orm';
import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import type { BuilderConfig } from '@shared/api.interface';
import type { CouncilCandidate, CouncilReport } from '@shared/council.interface';
import type { CouncilEvidence } from '../modules/council/council.rules';
import type { CouncilCheckpoint, CouncilMessageMetadata } from '../modules/council/council.types';

export const councilSessions = pgTable('council_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  owner: text('owner').notNull(),
  profileId: uuid('profile_id'),
  profileVersion: integer('profile_version').notNull(),
  profileSnapshot: jsonb('profile_snapshot').$type<BuilderConfig>().notNull(),
  ticker: varchar('ticker', { length: 20 }).notNull(),
  language: varchar('language', { length: 5 }).$type<'zh-CN' | 'en'>().notNull().default('zh-CN'),
  status: varchar('status', { length: 16 }).$type<'idle' | 'running' | 'completed' | 'paused' | 'failed'>().notNull().default('idle'),
  revision: integer('revision').notNull().default(1),
  taskId: uuid('task_id').notNull().defaultRandom(),
  candidate: jsonb('candidate').$type<CouncilCandidate | null>(),
  evidenceSnapshot: jsonb('evidence_snapshot').$type<CouncilEvidence[]>().notNull().default(sql`'[]'::jsonb`),
  sourceRunId: uuid('source_run_id'),
  cacheKey: varchar('cache_key', { length: 64 }),
  error: text('error'),
  checkpoint: jsonb('checkpoint').$type<CouncilCheckpoint | null>(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
}, (table) => [index('council_sessions_owner_created_idx').on(table.owner, table.createdAt),
  index('council_sessions_cache_idx').on(table.owner, table.cacheKey, table.createdAt)]);

export const councilMessages = pgTable('council_messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  owner: text('owner').notNull(),
  sessionId: uuid('session_id').notNull().references(() => councilSessions.id, { onDelete: 'cascade' }),
  role: varchar('role', { length: 16 }).$type<'researcher' | 'challenger' | 'manager' | 'user' | 'system'>().notNull(),
  memberName: varchar('member_name', { length: 40 }).notNull(),
  content: text('content').notNull(),
  revision: integer('revision').notNull(),
  tokensUsed: integer('tokens_used').notNull().default(0),
  metadata: jsonb('metadata').$type<CouncilMessageMetadata | null>(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
}, (table) => [index('council_messages_session_idx').on(table.owner, table.sessionId, table.createdAt)]);

export const councilReports = pgTable('council_reports', {
  publicationOutcome: varchar('publication_outcome', { length: 10 }).$type<'succeeded' | 'failed'>(),
  thesisCandidates: jsonb('thesis_candidates').$type<CouncilReport['thesisCandidates']>(),
  coverage: jsonb('coverage').$type<CouncilReport['coverage']>(),
  id: uuid('id').primaryKey().defaultRandom(),
  owner: text('owner').notNull(),
  sessionId: uuid('session_id').notNull().references(() => councilSessions.id, { onDelete: 'cascade' }),
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
  engine: varchar('engine', { length: 10 }).$type<'basic' | 'llm' | 'local' | 'a2a' | 'mixed'>().notNull(),
  researchStance: varchar('research_stance', { length: 10 }).$type<'positive' | 'balanced' | 'cautious' | null>(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
}, (table) => [uniqueIndex('council_reports_version_idx').on(table.sessionId, table.version),
  index('council_reports_owner_idx').on(table.owner, table.sessionId, table.createdAt)]);
