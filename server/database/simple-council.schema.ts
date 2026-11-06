import { boolean, foreignKey, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { councilSessions } from './council.schema';
import type { ActualExecutor } from '../../shared/simple-conversation.interface';
import type { DiscussionContribution } from '../modules/council/council.dialogue';
import type { CouncilEvidence } from '../modules/council/council.rules';

/** Private until the cycle's release barrier. Immutable output and a separate release timestamp. */
export const councilIndependentSubmissions = pgTable('council_independent_submissions', {
  id: uuid('id').primaryKey().defaultRandom(), owner: text('owner').notNull(), sessionId: uuid('session_id').notNull(),
  cycleId: uuid('cycle_id').notNull(), memberId: text('member_id').notNull(),
  executorIdentity: jsonb('executor_identity').$type<ActualExecutor>().notNull(),
  attempt: integer('attempt').notNull().default(1),
  contribution: jsonb('contribution').$type<DiscussionContribution>().notNull(),
  evidence: jsonb('evidence').$type<CouncilEvidence[]>().notNull(),
  tokensUsed: integer('tokens_used').notNull(), taskId: text('task_id'), externalUsageUnknown: text('external_usage_unknown'),
  submittedAt: timestamp('submitted_at', { withTimezone: true }).notNull().defaultNow(),
  releasedAt: timestamp('released_at', { withTimezone: true }),
}, table => [uniqueIndex('council_independent_submission_unique').on(table.owner, table.sessionId, table.cycleId, table.memberId, table.attempt),
  foreignKey({ columns: [table.owner, table.sessionId], foreignColumns: [councilSessions.owner, councilSessions.id] }).onDelete('cascade')]);

export const simpleCouncilRequests = pgTable('simple_council_requests', {
  owner: text('owner').notNull(), requestKey: text('request_key').notNull(), inputHash: text('input_hash').notNull(),
  sessionId: uuid('session_id').notNull(), createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [uniqueIndex('simple_council_requests_owner_key').on(table.owner, table.requestKey),
  foreignKey({ columns: [table.owner, table.sessionId], foreignColumns: [councilSessions.owner, councilSessions.id] }).onDelete('cascade')]);

export const councilMemberAttempts = pgTable('council_member_attempts', {
  id: uuid('id').primaryKey().defaultRandom(), owner: text('owner').notNull(), sessionId: uuid('session_id').notNull(),
  cycleId: uuid('cycle_id').notNull(), memberId: text('member_id').notNull(), attempt: integer('attempt').notNull(),
  revision: integer('revision').notNull(), turn: integer('turn').notNull(), resourceKey: text('resource_key').notNull(),
  inputHash: text('input_hash').notNull(), inputSnapshot: jsonb('input_snapshot').$type<Record<string, unknown>>().notNull(),
  messageId: uuid('message_id').notNull().defaultRandom(), taskId: text('task_id'), dispatchStarted: boolean('dispatch_started').notNull().default(false),
  status: text('status').$type<import('../../shared/research-execution.interface').ResearchMemberState['status']>().notNull().default('queued'),
  resultAcceptance: text('result_acceptance').$type<import('../../shared/research-execution.interface').ResultAcceptance>().notNull().default('pending'),
  rawText: text('raw_text'), tokensUsed: integer('tokens_used').notNull().default(0),
  failure: jsonb('failure').$type<import('../../shared/research-execution.interface').SafeFailure>(),
  failureHistory: jsonb('failure_history').$type<import('../../shared/research-execution.interface').SafeFailure[]>().notNull().default([]),
  startedAt: timestamp('started_at', { withTimezone: true }), completedAt: timestamp('completed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(), updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [uniqueIndex('council_member_attempt_identity').on(table.owner, table.sessionId, table.cycleId, table.memberId, table.attempt),
  foreignKey({ columns: [table.owner, table.sessionId], foreignColumns: [councilSessions.owner, councilSessions.id] }).onDelete('cascade')]);

export const councilRecoveryRequests = pgTable('council_recovery_requests', {
  owner: text('owner').notNull(), requestKey: text('request_key').notNull(), inputHash: text('input_hash').notNull(),
  sessionId: uuid('session_id').notNull(), memberId: text('member_id').notNull(), attemptId: uuid('attempt_id'),
  action: text('action').notNull(), createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [uniqueIndex('council_recovery_owner_request').on(table.owner, table.requestKey),
  foreignKey({ columns: [table.owner, table.sessionId], foreignColumns: [councilSessions.owner, councilSessions.id] }).onDelete('cascade')]);
