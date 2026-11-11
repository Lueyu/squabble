import { integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import type { AgentDataClass, AgentToolDescriptor } from '../../shared/agent-tooling.interface';

export const toolConnections = pgTable('tool_connections', {
  id: uuid('id').primaryKey(), owner: text('owner').notNull(), provider: text('provider').notNull(),
  transport: text('transport').notNull(), endpoint: text('endpoint'), secretEnc: text('secret_enc'),
  providerConfig: jsonb('provider_config').$type<{ connectedAccountId?: string; authConfigId?: string; toolVersions?: Record<string, string> }>(),
  revision: integer('revision').notNull().default(1), status: text('status').notNull().default('configured'),
  allowedToolIds: jsonb('allowed_tool_ids').$type<string[]>().notNull().default([]),
  allowedDataClasses: jsonb('allowed_data_classes').$type<AgentDataClass[]>().notNull().default(['public']),
  toolEffects: jsonb('tool_effects').$type<Record<string, 'read' | 'compute' | 'external_write'>>().notNull().default({}),
  catalogVersionId: uuid('catalog_version_id'), verifiedAt: timestamp('verified_at', { withTimezone: true }),
  oauthConfig: jsonb('oauth_config').$type<{ clientId: string; authorizationUrl: string; tokenUrl: string; scopes: string[] }>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
export const toolCatalogVersions = pgTable('tool_catalog_versions', {
  id: uuid('id').primaryKey(), owner: text('owner').notNull(), connectionId: uuid('connection_id').notNull(),
  connectionRevision: integer('connection_revision').notNull(), schemaHash: text('schema_hash').notNull(),
  descriptors: jsonb('descriptors').$type<AgentToolDescriptor[]>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
export const toolOAuthStates = pgTable('tool_oauth_states', {
  id: uuid('id').primaryKey(), owner: text('owner').notNull(), connectionId: uuid('connection_id').notNull(),
  connectionRevision: integer('connection_revision').notNull(), stateHash: text('state_hash').notNull(),
  verifierEnc: text('verifier_enc').notNull(), expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
}, table => [uniqueIndex('tool_oauth_state_identity').on(table.stateHash)]);
export const toolRemoteJobs = pgTable('tool_remote_jobs', {
  id: uuid('id').primaryKey(), owner: text('owner').notNull(), connectionId: uuid('connection_id').notNull(),
  connectionRevision: integer('connection_revision').notNull(), invocationId: text('invocation_id').notNull(),
  remoteJobId: text('remote_job_id').notNull(), state: text('state').notNull(), limits: jsonb('limits').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [uniqueIndex('tool_remote_invocation_identity').on(table.owner, table.invocationId)]);
