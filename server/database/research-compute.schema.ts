import { boolean, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

export const researchComputeJobs = pgTable('research_compute_jobs', {
  id: uuid('id').primaryKey(), owner: text('owner').notNull(), runId: text('run_id').notNull(),
  requestKey: text('request_key').notNull(), requestHash: text('request_hash').notNull(),
  inputEnc: text('input_enc').notNull(), kind: text('kind').notNull(), state: text('state').notNull().default('queued'),
  sandboxId: text('sandbox_id'), terminationConfirmed: boolean('termination_confirmed').notNull().default(false),
  cancelRequested: boolean('cancel_requested').notNull().default(false), maxRuntimeMs: integer('max_runtime_ms').notNull(),
  result: jsonb('result').$type<Record<string, unknown>>(), errorCode: text('error_code'),
  sourceVersionIds: jsonb('source_version_ids').$type<string[]>().notNull().default([]),
  datasetVersionIds: jsonb('dataset_version_ids').$type<string[]>().notNull().default([]),
  retentionUntil: timestamp('retention_until', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [uniqueIndex('research_compute_request_identity').on(table.owner, table.requestKey)]);
