import { jsonb, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import type { ResearchDeletionResult } from '../../shared/research-deletion.interface';

/** Durable receipts survive hiding a report/session and fence retries across server restarts. */
export const researchDeletionRequests = pgTable('research_deletion_requests', {
  id: uuid('id').primaryKey().defaultRandom(),
  owner: text('owner').notNull(),
  requestKey: text('request_key').notNull(),
  inputHash: varchar('input_hash', { length: 64 }).notNull(),
  result: jsonb('result').$type<ResearchDeletionResult>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
}, table => [uniqueIndex('research_deletion_requests_owner_key_idx').on(table.owner, table.requestKey)]);
