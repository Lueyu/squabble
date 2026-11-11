import { integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import type { AgentDataClass } from '../../shared/agent-tooling.interface';
import type { ResearchDatasetVersion } from '../../shared/research-dataset.interface';
import type { ResearchArtifact } from '../../shared/research-artifact.interface';
import { dataLibrarySources, dataLibraryJobs } from './data-library.schema';

export const researchDatasetVersions = pgTable('research_dataset_versions', {
  id: uuid('id').primaryKey().defaultRandom(), owner: text('owner').notNull(),
  sourceId: uuid('source_id').notNull().references(() => dataLibrarySources.id),
  sourceVersionId: uuid('source_version_id').notNull(),
  contentHash: text('content_hash').notNull(), metadata: jsonb('metadata').$type<ResearchDatasetVersion>().notNull(),
  rows: jsonb('rows').$type<Record<string, unknown>[]>().notNull(), status: text('status').notNull().default('active'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
export const researchSourcePolicies = pgTable('research_source_policies', {
  sourceVersionId: uuid('source_version_id').primaryKey(),
  owner: text('owner').notNull(), dataClasses: jsonb('data_classes').$type<AgentDataClass[]>().notNull(),
  permittedUses: jsonb('permitted_uses').$type<string[]>().notNull(),
  retentionUntil: timestamp('retention_until', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
});
export const researchArtifacts = pgTable('research_artifacts', {
  id: uuid('id').primaryKey(), owner: text('owner').notNull(), runId: text('run_id').notNull(),
  metadata: jsonb('metadata').$type<ResearchArtifact>().notNull(), storageRef: text('storage_ref').notNull(),
  sizeBytes: integer('size_bytes').notNull(), sha256: text('sha256').notNull(),
  status: text('status').notNull().default('active'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
export const researchDocumentExtractions = pgTable('research_document_extractions', {
  id: uuid('id').primaryKey().defaultRandom(), owner: text('owner').notNull(),
  sourceId: uuid('source_id').notNull().references(() => dataLibrarySources.id),
  sourceVersionId: uuid('source_version_id').notNull(),
  jobId: uuid('job_id').notNull().references(() => dataLibraryJobs.id), originalHash: text('original_hash').notNull(),
  extractor: text('extractor').notNull(), extractorVersion: text('extractor_version').notNull(),
  configVersion: text('config_version').notNull(), artifactId: uuid('artifact_id').notNull().references(() => researchArtifacts.id),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
export const researchDocumentTasks = pgTable('research_document_tasks', {
  jobId: uuid('job_id').primaryKey().references(() => dataLibraryJobs.id), owner: text('owner').notNull(),
  sourceId: uuid('source_id').notNull().references(() => dataLibrarySources.id),
  sourceVersionId: uuid('source_version_id').notNull(), sourceRevision: integer('source_revision').notNull(),
  sourceHash: text('source_hash').notNull(), leaseToken: uuid('lease_token').notNull(), originalHash: text('original_hash').notNull(),
  extractor: text('extractor').notNull(), extractorVersion: text('extractor_version').notNull(),
  configVersion: text('config_version').notNull(), receipt: jsonb('receipt').$type<{ taskId: string; fileId?: string }>(),
  state: text('state').notNull(), pollToken: uuid('poll_token'), pollUntil: timestamp('poll_until', { withTimezone: true }),
  failureCount: integer('failure_count').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
