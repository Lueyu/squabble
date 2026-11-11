import { boolean, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

export const agentRuntimeRuns = pgTable('agent_runtime_runs', {
  id: uuid('id').primaryKey(), owner: text('owner').notNull(), identityHash: text('identity_hash').notNull(),
  identity: jsonb('identity').$type<Record<string, unknown>>().notNull(), driver: text('driver').notNull(),
  frozenInputHash: text('frozen_input_hash').notNull(), frozenInputEnc: text('frozen_input_enc').notNull(),
  initialRequestEnc: text('initial_request_enc'), initialRequestHash: text('initial_request_hash'),
  policy: jsonb('policy').$type<Record<string, unknown>>().notNull(), state: text('state').notNull().default('queued'),
  cursor: integer('cursor').notNull().default(0), leaseToken: text('lease_token'),
  cancelRequested: boolean('cancel_requested').notNull().default(false),
  leaseUntil: timestamp('lease_until', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [uniqueIndex('agent_runtime_identity').on(table.owner, table.identityHash)]);

export const agentRuntimeSteps = pgTable('agent_runtime_steps', {
  id: uuid('id').primaryKey(), owner: text('owner').notNull(), runId: uuid('run_id').notNull(),
  stepIndex: integer('step_index').notNull(), dispatchKey: text('dispatch_key').notNull(),
  requestHash: text('request_hash').notNull(), requestEnc: text('request_enc').notNull(), model: text('model').notNull(),
  responseHash: text('response_hash'), responseEnc: text('response_enc'), state: text('state').notNull().default('dispatched'),
  budgetId: uuid('budget_id'), providerRequestId: text('provider_request_id'), usage: jsonb('usage'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [uniqueIndex('agent_runtime_step_identity').on(table.owner, table.runId, table.stepIndex)]);

export const agentRuntimeEvents = pgTable('agent_runtime_events', {
  owner: text('owner').notNull(), runId: uuid('run_id').notNull(), stepId: uuid('step_id'),
  kind: text('kind').notNull(), code: text('code'), createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  parseAttemptId: uuid('parse_attempt_id'), responseHash: text('response_hash'), parserVersion: text('parser_version'),
});

export const agentToolInvocations = pgTable('agent_tool_invocations', {
  id: uuid('id').primaryKey(), owner: text('owner').notNull(), runId: uuid('run_id').notNull(), stepId: uuid('step_id').notNull(),
  toolCallId: text('tool_call_id').notNull(), toolId: text('tool_id').notNull(), catalogVersionId: text('catalog_version_id').notNull(),
  argumentsHash: text('arguments_hash').notNull(), argumentsEnc: text('arguments_enc').notNull(), resultEnc: text('result_enc'),
  state: text('state').notNull().default('queued'), remoteReceipt: jsonb('remote_receipt'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [uniqueIndex('agent_tool_call_identity').on(table.owner, table.runId, table.stepId, table.toolCallId)]);
