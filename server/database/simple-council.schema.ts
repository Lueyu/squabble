import { foreignKey, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
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
