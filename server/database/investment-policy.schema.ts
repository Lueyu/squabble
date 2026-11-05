import { pgTable, text, uuid, integer, timestamp, jsonb, uniqueIndex } from 'drizzle-orm/pg-core';
import type { InvestmentConfig, InvestmentConstraint, InvestmentConstraintRecord } from '../../shared/investment-policy.interface';
import type { SimulationSeed } from '../../shared/simulation-experiment.interface';

export const investmentPolicies = pgTable('investment_policies', {
  id: uuid('id').primaryKey().defaultRandom(), owner: text('owner').notNull(), accountId: uuid('account_id').notNull(),
  revision: integer('revision').notNull().default(1), status: text('status').notNull().default('paused'),
  baseConfig: jsonb('base_config').$type<InvestmentConfig>().notNull(), effectiveConfig: jsonb('effective_config').$type<InvestmentConfig>().notNull(),
  constraintRecords: jsonb('constraint_records').$type<InvestmentConstraintRecord[]>().notNull().default([]),
  confirmedAt: timestamp('confirmed_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [uniqueIndex('investment_policy_owner_account').on(t.owner, t.accountId)]);
export const investmentPreviews = pgTable('investment_previews', {
  id: uuid('id').primaryKey().defaultRandom(), owner: text('owner').notNull(), requestKey: text('request_key').notNull(), requestHash: text('request_hash').notNull(),
  origin: text('origin').notNull(), seed: jsonb('seed').$type<SimulationSeed>().notNull(), sourcePreviewId: uuid('source_preview_id'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(), createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [uniqueIndex('investment_preview_request').on(t.owner, t.requestKey)]);
export const investmentRequests = pgTable('investment_requests', {
  id: uuid('id').primaryKey().defaultRandom(), owner: text('owner').notNull(), requestKey: text('request_key').notNull(),
  requestHash: text('request_hash').notNull(), operation: text('operation').notNull(), result: jsonb('result').$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [uniqueIndex('investment_request_idempotency').on(t.owner, t.requestKey)]);
export const investmentCycles = pgTable('investment_cycles', {
  id: uuid('id').primaryKey().defaultRandom(), owner: text('owner').notNull(), accountId: uuid('account_id').notNull(),
  policyId: uuid('policy_id').notNull(), policyRevision: integer('policy_revision').notNull(),
  market: text('market').notNull(), marketDate: text('market_date').notNull(), trigger: text('trigger').notNull(), eventKey: text('event_key').notNull(),
  priority: integer('priority').notNull().default(2), state: text('state').notNull().default('queued'),
  leaseToken: uuid('lease_token'), leaseUntil: timestamp('lease_until', { withTimezone: true }),
  input: jsonb('input').$type<Record<string, unknown>>().notNull().default({}), candidates: jsonb('candidates').$type<unknown[]>().notNull().default([]),
  result: jsonb('result').$type<Record<string, unknown>>().notNull().default({}), mandateId: uuid('mandate_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(), updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [uniqueIndex('investment_cycle_trigger').on(t.owner, t.policyId, t.policyRevision, t.market, t.marketDate, t.eventKey)]);
export const investmentConstraintProposals = pgTable('investment_constraint_proposals', {
  id: uuid('id').primaryKey().defaultRandom(), owner: text('owner').notNull(), accountId: uuid('account_id').notNull(),
  expectedPolicyRevision: integer('expected_policy_revision').notNull(), constraint: jsonb('constraint').$type<InvestmentConstraint | null>(),
  text: text('text').notNull(), impact: text('impact').notNull(), needsInput: jsonb('needs_input').$type<string[]>().notNull().default([]),
  state: text('state').notNull().default('proposed'), expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  requestKey: text('request_key').notNull(), requestHash: text('request_hash').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [uniqueIndex('investment_constraint_request').on(t.owner, t.requestKey)]);
export const automaticResearchTasks = pgTable('automatic_research_tasks', {
  id: uuid('id').primaryKey().defaultRandom(), owner: text('owner').notNull(), accountId: uuid('account_id'),
  key: text('key').notNull(), purpose: text('purpose').notNull(), dateKey: text('date_key').notNull(),
  calls: integer('calls').notNull().default(0), state: text('state').notNull().default('claimed'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [uniqueIndex('automatic_research_task_key').on(t.owner, t.key)]);
