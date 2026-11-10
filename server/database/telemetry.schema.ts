import { index, integer, numeric, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';
import type { TelemetryKind, TelemetryStatus } from '../../shared/telemetry.interface';

/** Metadata only: prompts, outputs and credentials have no storage column here. */
export const telemetrySpans = pgTable('telemetry_spans', {
  owner: text('owner').notNull(), id: text('id').notNull(), runId: text('run_id').notNull(), sourceId: text('source_id').notNull(),
  sessionId: text('session_id'), revision: integer('revision'), scene: text('scene').notNull(), title: text('title').notNull(),
  parentId: text('parent_id'), kind: text('kind').$type<TelemetryKind>().notNull(), name: text('name').notNull(),
  status: text('status').$type<TelemetryStatus>().notNull(), agentId: text('agent_id'), agentName: text('agent_name'),
  provider: text('provider'), model: text('model'), executionMode: text('execution_mode'),
  startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }).notNull(),
  completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }), durationMs: integer('duration_ms'),
  inputTokens: integer('input_tokens'), outputTokens: integer('output_tokens'), totalTokens: integer('total_tokens'),
  estimatedCostUsd: numeric('estimated_cost_usd'), errorCode: text('error_code'), attempt: integer('attempt').notNull().default(1), traceId: text('trace_id'),
}, table => [primaryKey({ columns: [table.owner, table.id] }), index('telemetry_spans_owner_date_idx').on(table.owner, table.startedAt),
  index('telemetry_spans_owner_run_idx').on(table.owner, table.runId)]);

export const telemetryFeedback = pgTable('telemetry_feedback', {
  owner: text('owner').notNull(), runId: text('run_id').notNull(), rating: text('rating').$type<'positive' | 'negative'>().notNull(),
  comment: text('comment').notNull().default(''), updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
}, table => [primaryKey({ columns: [table.owner, table.runId] })]);
