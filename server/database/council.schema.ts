import { sql } from 'drizzle-orm';
import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import type { BuilderConfig } from '@shared/api.interface';
import type { CouncilCandidate, CouncilReport, CouncilScene, CouncilPeriod, CouncilThreadMessage, CouncilContinuationSummary } from '@shared/council.interface';
import type { ReportReference, ResolvedReportReference } from '@shared/research-document.interface';
import type { CouncilEvidence } from '../modules/council/council.rules';
import type { CouncilCheckpoint, CouncilMessageMetadata } from '../modules/council/council.types';

export const councilSessions = pgTable('council_sessions', {
  // Drizzle uses the first column to recognize absent left joins. Keep identity first.
  id: uuid('id').primaryKey().defaultRandom(),
  teamCommissionId: uuid('team_commission_id'),
  teamContext: jsonb('team_context').$type<import('../../shared/team-workspace.interface').TeamExecutionContext | null>(),
  owner: text('owner').notNull(),
  profileId: uuid('profile_id'),
  profileVersion: integer('profile_version').notNull(),
  profileSnapshot: jsonb('profile_snapshot').$type<BuilderConfig>().notNull(),
  ticker: varchar('ticker', { length: 20 }).notNull(),
  scene: varchar('scene', { length: 24 }).$type<CouncilScene>().notNull().default('stock'),
  title: text('title').notNull().default(''),
  subject: text('subject').notNull().default(''),
  period: jsonb('period').$type<CouncilPeriod | null>(),
  parentSessionId: uuid('parent_session_id'),
  parentMessageId: uuid('parent_message_id'),
  parentReportId: uuid('parent_report_id'),
  references: jsonb('report_references').$type<ReportReference[]>().notNull().default(sql`'[]'::jsonb`),
  resolvedReferences: jsonb('resolved_references').$type<ResolvedReportReference[]>().notNull().default(sql`'[]'::jsonb`),
  inheritedContext: jsonb('inherited_context').$type<CouncilThreadMessage[]>().notNull().default(sql`'[]'::jsonb`),
  continuationSummary: jsonb('continuation_summary').$type<CouncilContinuationSummary | null>(),
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
  deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'date' }),
}, (table) => [index('council_sessions_owner_created_idx').on(table.owner, table.createdAt),
  index('council_sessions_cache_idx').on(table.owner, table.cacheKey, table.createdAt)]);

export const councilMessages = pgTable('council_messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  owner: text('owner').notNull(),
  sessionId: uuid('session_id').notNull().references(() => councilSessions.id, { onDelete: 'cascade' }),
  role: varchar('role', { length: 16 }).$type<'researcher' | 'challenger' | 'manager' | 'user' | 'system'>().notNull(),
  memberName: varchar('member_name', { length: 100 }).notNull(),
  content: text('content').notNull(),
  revision: integer('revision').notNull(),
  tokensUsed: integer('tokens_used').notNull().default(0),
  metadata: jsonb('metadata').$type<CouncilMessageMetadata | null>(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
}, (table) => [index('council_messages_session_idx').on(table.owner, table.sessionId, table.createdAt)]);

export const councilReports = pgTable('council_reports', {
  researchVersionId: uuid('research_version_id'),
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

/** A committed claim is never replayed after an ambiguous paid model response. */
export const councilRevisionRequests = pgTable('council_revision_requests', {
  id: uuid('id').primaryKey().defaultRandom(), owner: text('owner').notNull(),
  sessionId: uuid('session_id').notNull().references(() => councilSessions.id, { onDelete: 'cascade' }),
  requestKey: uuid('request_key').notNull(), inputHash: varchar('input_hash', { length: 64 }).notNull(),
  status: varchar('status', { length: 16 }).$type<'pending' | 'succeeded' | 'failed'>().notNull().default('pending'),
  result: jsonb('result').$type<import('@shared/research-document.interface').ResearchRevisionDraft | null>(), error: text('error'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
}, table => [uniqueIndex('council_revision_requests_owner_key_idx').on(table.owner, table.requestKey)]);
