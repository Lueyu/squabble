import { integer, pgTable, text, timestamp, uuid, uniqueIndex } from 'drizzle-orm/pg-core';

export const deepAgentDriverCheckpoints = pgTable('deep_agent_driver_checkpoints', {
  owner: text('owner').notNull(), runId: uuid('run_id').notNull(), contextHash: text('context_hash').notNull(),
  stepIndex: integer('step_index').notNull(), transcriptEnc: text('transcript_enc').notNull(),
  transcriptHash: text('transcript_hash').notNull(), updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [uniqueIndex('deep_agent_driver_identity').on(table.owner, table.runId)]);
