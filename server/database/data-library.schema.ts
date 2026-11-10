import { boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import type { DataLibrarySection } from '../../shared/data-library.interface';
export const dataLibrarySources = pgTable('data_library_sources', {
  id: uuid('id').primaryKey().defaultRandom(), owner: text('owner').notNull(),
  kind: text('kind').notNull(), title: text('title').notNull(), description: text('description').notNull().default(''),
  format: text('format').notNull(), url: text('url'), fileName: text('file_name'), mimeType: text('mime_type'),
  fileData: text('file_data'), enabled: boolean('enabled').notNull().default(true),
  authKind: text('auth_kind').notNull().default('none'), secretEnc: text('secret_enc'),
  syncIntervalMinutes: integer('sync_interval_minutes'), nextSyncAt: timestamp('next_sync_at', { withTimezone: true }),
  latestVersionId: uuid('latest_version_id'), versionCount: integer('version_count').notNull().default(0),
  state: text('state').notNull().default('pending'), lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
  lastErrorCode: text('last_error_code'), leaseUntil: timestamp('lease_until', { withTimezone: true }),
  revision: integer('revision').notNull().default(1), deletedAt: timestamp('deleted_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [index('data_library_owner_idx').on(t.owner, t.createdAt), index('data_library_due_idx').on(t.nextSyncAt)]);
export const dataLibraryVersions = pgTable('data_library_versions', {
  id: uuid('id').primaryKey().defaultRandom(), owner: text('owner').notNull(),
  sourceId: uuid('source_id').notNull().references(() => dataLibrarySources.id),
  version: integer('version').notNull(), contentHash: text('content_hash').notNull(),
  rawContent: text('raw_content').notNull(), extractedText: text('extracted_text').notNull(),
  sections: jsonb('sections').$type<DataLibrarySection[]>().notNull(),
  byteLength: integer('byte_length').notNull(), extractionState: text('extraction_state').notNull(),
  observedAt: timestamp('observed_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [uniqueIndex('data_library_version_idx').on(t.sourceId, t.version), index('data_library_version_owner_idx').on(t.owner, t.sourceId)]);
export const dataLibraryJobs = pgTable('data_library_jobs', {
  id: uuid('id').primaryKey().defaultRandom(), owner: text('owner').notNull(),
  sourceId: uuid('source_id').notNull().references(() => dataLibrarySources.id),
  state: text('state').notNull(), outcome: text('outcome'), versionId: uuid('version_id'), errorCode: text('error_code'),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
}, t => [index('data_library_job_owner_idx').on(t.owner, t.startedAt)]);
export const financialDataConnections = pgTable('financial_data_connections', {
  id: uuid('id').primaryKey().defaultRandom(), owner: text('owner').notNull(), provider: text('provider').notNull(),
  secretEnc: text('secret_enc'), enabled: boolean('enabled').notNull().default(true),
  lastTestAt: timestamp('last_test_at', { withTimezone: true }), lastTestOk: boolean('last_test_ok'), lastTestCode: text('last_test_code'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [uniqueIndex('financial_data_connection_owner_provider_idx').on(t.owner, t.provider)]);
