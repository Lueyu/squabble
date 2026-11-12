import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import type { AgentMemoryScope, AgentVersionConfig } from '../../shared/agent-roster.interface';
import type { ResearchSourceRef } from '../../shared/team-workspace.interface';
import type { AnimalAvatarId } from '../../shared/animal-avatar';

const time = (name: string) => timestamp(name, { withTimezone: true, precision: 3 }).notNull().defaultNow();
export const agentRosterProfiles = pgTable('agent_roster_profiles', {
  avatar: text('avatar').$type<AnimalAvatarId>().notNull().default('technical'),
  id: uuid('id').primaryKey().defaultRandom(), ownerId: text('owner_id').notNull(), name: text('name').notNull(), specialty: text('specialty').notNull(),
  description: text('description').notNull().default(''), status: text('status').notNull().default('active'), revision: integer('revision').notNull().default(1),
  currentVersionId: uuid('current_version_id').notNull(), createdAt: time('created_at'), updatedAt: time('updated_at'),
}, t => [uniqueIndex('agent_roster_profiles_owner_id_idx').on(t.ownerId, t.id), index('agent_roster_profiles_owner_status_idx').on(t.ownerId, t.status, t.updatedAt)]);
export const agentRosterVersions = pgTable('agent_roster_versions', {
  id: uuid('id').primaryKey().defaultRandom(), ownerId: text('owner_id').notNull(), agentId: uuid('agent_id').notNull(), version: integer('version').notNull(),
  config: jsonb('config_json').$type<AgentVersionConfig>().notNull(), createdAt: time('created_at'),
}, t => [uniqueIndex('agent_roster_versions_owner_agent_id_idx').on(t.ownerId, t.agentId, t.id), uniqueIndex('agent_roster_versions_number_idx').on(t.agentId, t.version)]);
export const agentRosterRequests = pgTable('agent_roster_requests', {
  id: uuid('id').primaryKey().defaultRandom(), ownerId: text('owner_id').notNull(), requestKey: text('request_key').notNull(), operation: text('operation').notNull(),
  inputHash: text('input_hash').notNull(), result: jsonb('result_json').$type<unknown>().notNull(), completedAt: time('completed_at'),
}, t => [uniqueIndex('agent_roster_requests_owner_key_idx').on(t.ownerId, t.requestKey)]);
export const agentRosterMemories = pgTable('agent_roster_memories', {
  id: uuid('id').primaryKey().defaultRandom(), ownerId: text('owner_id').notNull(), agentId: uuid('agent_id').notNull(), scope: jsonb('scope_json').$type<AgentMemoryScope>().notNull(),
  content: text('content').notNull(), origin: text('origin').notNull(), sourceRefs: jsonb('source_refs_json').$type<ResearchSourceRef[]>().notNull(), createdAt: time('created_at'),
}, t => [uniqueIndex('agent_roster_memories_owner_id_idx').on(t.ownerId, t.id), index('agent_roster_memories_agent_idx').on(t.ownerId, t.agentId, t.createdAt)]);
export const agentRosterMemoryShares = pgTable('agent_roster_memory_shares', {
  id: uuid('id').primaryKey().defaultRandom(), ownerId: text('owner_id').notNull(), memoryId: uuid('memory_id').notNull(), targetAgentId: uuid('target_agent_id').notNull(),
  targetScope: jsonb('target_scope_json').$type<AgentMemoryScope>().notNull(), createdAt: time('created_at'),
}, t => [uniqueIndex('agent_roster_shares_identity_idx').on(t.ownerId, t.memoryId, t.targetAgentId, t.targetScope), index('agent_roster_shares_target_idx').on(t.ownerId, t.targetAgentId)]);
