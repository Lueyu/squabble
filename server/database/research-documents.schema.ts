import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import type { ResearchDocumentKind, ResearchDocumentSection, ResearchInputSnapshot, ReportSource, ReportReference } from '../../shared/research-document.interface';

export const researchDocuments = pgTable('research_documents', {
  id: uuid('id').primaryKey().defaultRandom(), owner: text('owner').notNull(), title: text('title').notNull(),
  kind: varchar('kind', { length: 16 }).$type<ResearchDocumentKind>().notNull(), ticker: varchar('ticker', { length: 30 }),
  topicKey: text('topic_key').notNull().default('portfolio'),
  sourceKey: text('source_key'), parentReportId: uuid('parent_report_id'), latestVersionId: uuid('latest_version_id'), adoptedVersionId: uuid('adopted_version_id'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
}, table => [uniqueIndex('research_documents_source_idx').on(table.owner, table.sourceKey), index('research_documents_owner_idx').on(table.owner, table.createdAt), index('research_documents_topic_idx').on(table.owner, table.topicKey)]);

export const researchDocumentVersions = pgTable('research_document_versions', {
  id: uuid('id').primaryKey().defaultRandom(), owner: text('owner').notNull(), reportId: uuid('report_id').notNull().references(() => researchDocuments.id),
  version: integer('version').notNull(), idempotencyKey: text('idempotency_key').notNull(), contentHash: varchar('content_hash', { length: 64 }).notNull(),
  title: text('title').notNull(), kind: varchar('kind', { length: 16 }).$type<ResearchDocumentKind>().notNull(), ticker: varchar('ticker', { length: 30 }),
  content: text('content').notNull(), sections: jsonb('sections').$type<ResearchDocumentSection[]>().notNull(),
  source: jsonb('source').$type<ReportSource | null>(), snapshot: jsonb('snapshot').$type<ResearchInputSnapshot | null>(),
  dataAsOf: timestamp('data_as_of', { withTimezone: true, mode: 'date' }), availableAt: timestamp('available_at', { withTimezone: true, mode: 'date' }),
  parentVersionId: uuid('parent_version_id'), changeReason: text('change_reason'), revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }), revocationReason: text('revocation_reason'),
  deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'date' }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
}, table => [uniqueIndex('research_versions_number_idx').on(table.reportId, table.version), uniqueIndex('research_versions_key_idx').on(table.owner, table.idempotencyKey),
  index('research_versions_owner_idx').on(table.owner, table.reportId)]);

export const researchRevisionDrafts = pgTable('research_revision_drafts', {
  id: uuid('id').primaryKey().defaultRandom(), owner: text('owner').notNull(), reportId: uuid('report_id').notNull().references(() => researchDocuments.id),
  parentVersionId: uuid('parent_version_id').notNull().references(() => researchDocumentVersions.id), revision: integer('revision').notNull().default(1),
  title: text('title').notNull(), content: text('content').notNull(), sections: jsonb('sections').$type<ResearchDocumentSection[]>().notNull(), changeReason: text('change_reason').notNull(),
  sourceReferences: jsonb('source_references').$type<ReportReference[]>().notNull().default([]),
  publishedVersionId: uuid('published_version_id'), createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
}, table => [index('research_revision_drafts_owner_idx').on(table.owner, table.reportId)]);

export const researchDocumentStrategyUses = pgTable('research_document_strategy_uses', {
  id: uuid('id').primaryKey().defaultRandom(), owner: text('owner').notNull(), versionId: uuid('version_id').notNull().references(() => researchDocumentVersions.id),
  strategyId: uuid('strategy_id').notNull(), createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
}, table => [uniqueIndex('research_document_strategy_use_idx').on(table.owner, table.versionId, table.strategyId), index('research_document_strategy_owner_idx').on(table.owner, table.versionId)]);

/** Request receipts share the source write transaction, including legacy agent endpoints. */
export const researchDocumentSubmissions = pgTable('research_document_submissions', {
  id: uuid('id').primaryKey().defaultRandom(), owner: text('owner').notNull(), key: text('key').notNull(), payloadHash: varchar('payload_hash', { length: 64 }).notNull(),
  result: jsonb('result').$type<Record<string, unknown>>().notNull(), createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
}, table => [uniqueIndex('research_document_submissions_key_idx').on(table.owner, table.key)]);

export const researchDocumentAdoptions = pgTable('research_document_adoptions', {
  id: uuid('id').primaryKey().defaultRandom(), owner: text('owner').notNull(), reportId: uuid('report_id').notNull().references(() => researchDocuments.id),
  versionId: uuid('version_id').notNull().references(() => researchDocumentVersions.id), previousVersionId: uuid('previous_version_id').references(() => researchDocumentVersions.id),
  actorId: text('actor_id').notNull(), createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
}, table => [index('research_document_adoptions_owner_idx').on(table.owner, table.reportId, table.createdAt)]);
