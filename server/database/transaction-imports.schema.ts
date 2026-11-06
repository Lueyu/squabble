import { sql } from 'drizzle-orm';
import { integer, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { customTimestamptz } from './schema';
import type { TransactionImportInput, TransactionImportRow, TransactionImportReceipt } from '../../shared/transaction-import.interface';
export const transactionImportBatches = pgTable('transaction_import_batches', {
  id: uuid('id').primaryKey().defaultRandom(), owner: text('owner').notNull(),
  input: jsonb('input').$type<Omit<TransactionImportInput, 'rows'>>().notNull(),
  rows: jsonb('rows').$type<TransactionImportRow[]>().notNull(),
  revision: integer('revision').notNull().default(0),
  receipts: jsonb('receipts').$type<Array<TransactionImportReceipt & { inputHash: string }>>().notNull().default([]),
  createdAt: customTimestamptz('created_at', { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
});
