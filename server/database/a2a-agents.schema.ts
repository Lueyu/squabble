import { boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import type { A2aCapabilities, A2aConnectionFingerprint, A2aSkill, A2aTaskState } from '../../shared/a2a-agents.interface';

const time = (name: string) => timestamp(name, { withTimezone: true, precision: 3 }).notNull().defaultNow();
export const a2aAgentConnections = pgTable('a2a_agent_connections', {
  id: uuid('id').primaryKey().defaultRandom(), owner: text('owner').notNull(), name: text('name').notNull(),
  cardUrl: text('card_url').notNull(), secretEnc: text('secret_enc'), revision: integer('revision').notNull().default(1),
  status: text('status').notNull().default('enabled'), cardHash: text('card_hash').notNull(),
  cardName: text('card_name').notNull(), cardVersion: text('card_version').notNull(),
  protocolVersion: text('protocol_version').notNull().default('1.0'), interfaceUrl: text('interface_url').notNull(), tenant: text('tenant'),
  skills: jsonb('skills').$type<A2aSkill[]>().notNull().default([]), capabilities: jsonb('capabilities').$type<A2aCapabilities>().notNull(),
  localEndpoint: boolean('local_endpoint').notNull().default(false), createdAt: time('created_at'), updatedAt: time('updated_at'),
}, t => [uniqueIndex('a2a_connections_owner_id_idx').on(t.owner, t.id)]);
export const a2aAgentRequests = pgTable('a2a_agent_requests', {
  id: uuid('id').primaryKey().defaultRandom(), owner: text('owner').notNull(), requestKey: text('request_key').notNull(),
  inputHash: text('input_hash').notNull(), result: jsonb('result_json').$type<unknown>().notNull(), completedAt: time('completed_at'),
}, t => [uniqueIndex('a2a_requests_owner_key_idx').on(t.owner, t.requestKey)]);
export const a2aAgentInvocations = pgTable('a2a_agent_invocations', {
  id: uuid('id').primaryKey().defaultRandom(), owner: text('owner').notNull(), connectionId: uuid('connection_id').notNull(),
  messageId: text('message_id').notNull(), inputHash: text('input_hash').notNull(), fingerprint: jsonb('fingerprint_json').$type<A2aConnectionFingerprint>().notNull(),
  /** Snapshot credentials are encrypted and restricted to original task settlement after revocation. */
  settlementSecretEnc: text('settlement_secret_enc'), remoteTaskId: text('remote_task_id'), contextId: text('context_id'),
  state: text('state').$type<A2aTaskState>().notNull().default('dispatch_intent'),
  acceptance: text('acceptance').notNull().default('pending'), cancellation: text('cancellation').notNull().default('none'),
  rawResponseEnc: text('raw_response_enc'), outputBytes: integer('output_bytes').notNull().default(0), failureCode: text('failure_code'),
  deadlineAt: timestamp('deadline_at', { withTimezone: true }).notNull(), createdAt: time('created_at'), updatedAt: time('updated_at'),
}, t => [uniqueIndex('a2a_invocations_message_idx').on(t.owner, t.connectionId, t.messageId),
  index('a2a_invocations_owner_updated_idx').on(t.owner, t.updatedAt, t.id)]);
