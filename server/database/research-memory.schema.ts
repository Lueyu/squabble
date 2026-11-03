import { boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import type { Market } from '@shared/api.interface';
import type { CouncilReport } from '@shared/council.interface';
import type { ThesisContent, ThesisStatus, ResearchThesisVersion } from '@shared/research-memory.interface';
import type { EvidenceMetadata } from '@shared/research-evidence.interface';
import { councilReports } from './council.schema';

export const researchMemoryPreferences = pgTable('research_memory_preferences', {
  owner: text('owner').primaryKey(), autoArchive: boolean('auto_archive').notNull().default(true),
  recallEnabled: boolean('recall_enabled').notNull().default(true),
});
/** Source IDs deliberately survive deletion as tombstones; reads always validate the live source. */
export const researchMemories = pgTable('research_memories', {
  id: uuid('id').primaryKey().defaultRandom(), owner: text('owner').notNull(),
  ticker: varchar('ticker', { length: 20 }).notNull(), market: varchar('market', { length: 2 }).$type<Market>().notNull(),
  topic: varchar('topic', { length: 120 }).notNull(), language: varchar('language', { length: 5 }).$type<'zh-CN' | 'en'>().notNull(),
  sessionId: uuid('session_id').notNull(), reportId: uuid('report_id').notNull(),
  reportVersion: integer('report_version').notNull(), reportRevision: integer('report_revision').notNull(),
  reportCreatedAt: timestamp('report_created_at', { withTimezone: true, mode: 'date' }).notNull(),
  summary: text('summary').notNull(), decision: varchar('decision', { length: 10 }).$type<CouncilReport['decision']>().notNull(),
  excluded: boolean('excluded').notNull().default(false),
  deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'date' }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
}, table => [uniqueIndex('research_memories_report_version_idx').on(table.owner, table.reportId, table.reportVersion),
  index('research_memories_owner_symbol_idx').on(table.owner, table.market, table.ticker)]);

export const researchTheses = pgTable('research_theses', {
  id: uuid('id').primaryKey().defaultRandom(), owner: text('owner').notNull(),
  memoryId: uuid('memory_id').notNull().references(() => researchMemories.id),
  content: jsonb('content').$type<ThesisContent>().notNull(),
  status: varchar('status', { length: 12 }).$type<ThesisStatus>().notNull().default('candidate'),
  version: integer('version').notNull().default(1), excluded: boolean('excluded').notNull().default(false),
  expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }),
  deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'date' }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
}, table => [index('research_theses_owner_memory_idx').on(table.owner, table.memoryId)]);

export const researchThesisVersions = pgTable('research_thesis_versions', {
  changeReason: text('change_reason'),
  id: uuid('id').primaryKey().defaultRandom(), owner: text('owner').notNull(),
  thesisId: uuid('thesis_id').notNull().references(() => researchTheses.id, { onDelete: 'cascade' }),
  version: integer('version').notNull(), content: jsonb('content').$type<ThesisContent>().notNull(),
  status: varchar('status', { length: 12 }).$type<ThesisStatus>().notNull(),
  action: varchar('action', { length: 12 }).$type<ResearchThesisVersion['action']>().notNull(),
  excluded: boolean('excluded').notNull(), expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
}, table => [uniqueIndex('research_thesis_versions_idx').on(table.owner, table.thesisId, table.version)]);

/** Immutable source components, scoped to an owner/report version/revision and source alias. */
export const researchMemoryEvidence = pgTable('research_memory_evidence', {
  id: uuid('id').primaryKey().defaultRandom(), owner: text('owner').notNull(),
  memoryId: uuid('memory_id').notNull().references(() => researchMemories.id),
  reportId: uuid('report_id').notNull().references(() => councilReports.id, { onDelete: 'cascade' }),
  reportVersion: integer('report_version').notNull(), reportRevision: integer('report_revision').notNull(),
  evidenceId: text('evidence_id').notNull(), metadata: jsonb('metadata').$type<EvidenceMetadata>().notNull(),
  ingestedAt: timestamp('ingested_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
}, table => [uniqueIndex('research_memory_evidence_identity_idx').on(table.owner, table.reportId, table.reportVersion, table.reportRevision, table.evidenceId),
  index('research_memory_evidence_memory_idx').on(table.owner, table.memoryId)]);

export const researchThesisEvidence = pgTable('research_thesis_evidence', {
  id: uuid('id').primaryKey().defaultRandom(), owner: text('owner').notNull(),
  versionId: uuid('version_id').notNull().references(() => researchThesisVersions.id, { onDelete: 'cascade' }),
  evidenceRecordId: uuid('evidence_record_id').notNull().references(() => researchMemoryEvidence.id, { onDelete: 'cascade' }),
  role: varchar('role', { length: 8 }).$type<'support' | 'refute' | 'qualify'>().notNull(),
}, table => [uniqueIndex('research_thesis_evidence_identity_idx').on(table.owner, table.versionId, table.evidenceRecordId, table.role)]);
