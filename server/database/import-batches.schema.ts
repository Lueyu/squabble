import {
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type {
  ImportBatch,
  ImportCommitReceipt,
} from '../../shared/screenshot-import.interface';
export const importBatches = pgTable('import_batches', {
  id: uuid('id').primaryKey(),
  owner: text('owner').notNull(),
  revision: integer('revision').notNull().default(0),
  state: jsonb('state').$type<ImportBatch>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});
export const importCommitReceipts = pgTable(
  'import_commit_receipts',
  {
    id: uuid('id').primaryKey(),
    owner: text('owner').notNull(),
    batchId: uuid('batch_id'),
    requestKey: text('request_key').notNull(),
    inputHash: text('input_hash').notNull(),
    receipt: jsonb('receipt').$type<ImportCommitReceipt>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('import_commit_receipt_identity').on(
      table.owner,
      table.requestKey,
    ),
  ],
);
