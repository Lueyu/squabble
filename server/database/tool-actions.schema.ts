import { integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

export const toolActions = pgTable('tool_actions', {
  id: uuid('id').primaryKey(), owner: text('owner').notNull(), runId: uuid('run_id').notNull(), stepId: uuid('step_id').notNull(),
  toolCallId: text('tool_call_id').notNull(), toolId: text('tool_id').notNull(), connectionId: uuid('connection_id').notNull(),
  connectionRevision: integer('connection_revision').notNull(), catalogVersionId: text('catalog_version_id').notNull(),
  revision: integer('revision').notNull().default(1), payloadHash: text('payload_hash').notNull(), argumentsHash: text('arguments_hash').notNull(),
  previewEnc: text('preview_enc').notNull(), state: text('state').notNull().default('pending'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(), approvedAt: timestamp('approved_at', { withTimezone: true }),
  invocationId: text('invocation_id'), receipt: jsonb('receipt').$type<{ state: 'completed' | 'failed' | 'unknown'; code?: string; remoteId?: string }>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [uniqueIndex('tool_action_call_identity').on(table.owner, table.runId, table.stepId, table.toolCallId)]);
