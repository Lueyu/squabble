import { pgTable, text, uuid, integer, timestamp, jsonb, uniqueIndex, numeric } from 'drizzle-orm/pg-core';
import type { StrategyMandateInput, StrategyRouteDecision } from '../../shared/strategy-mandate.interface';

export const strategyMandates = pgTable('strategy_mandates', {
  parentPolicyId: uuid('parent_policy_id'), parentPolicyRevision: integer('parent_policy_revision'), cycleId: uuid('cycle_id'),
  id: uuid('id').primaryKey().defaultRandom(), owner: text('owner').notNull(),
  accountId: uuid('account_id').notNull(), profileId: uuid('profile_id').notNull(),
  profileVersion: integer('profile_version').notNull(), version: integer('version').notNull().default(1),
  revision: integer('revision').notNull().default(1), parentId: uuid('parent_id'),
  status: text('status').notNull().default('draft'), config: jsonb('config').$type<StrategyMandateInput>().notNull(),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
export const strategyRouteReviews = pgTable('strategy_route_reviews', {
  signalId: uuid('signal_id').primaryKey(), owner: text('owner').notNull(), accountId: uuid('account_id').notNull(),
  mandateId: uuid('mandate_id'), decision: jsonb('decision').$type<StrategyRouteDecision>().notNull(),
  councilSessionId: uuid('council_session_id'), councilReportId: uuid('council_report_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [uniqueIndex('strategy_route_signal_unique').on(t.signalId)]);
export const strategyMonitorState = pgTable('strategy_monitor_state', {
  accountId: uuid('account_id').primaryKey(), owner: text('owner').notNull(),
  lastHeartbeat: timestamp('last_heartbeat', { withTimezone: true }).notNull(),
  gaps: jsonb('gaps').$type<Array<{ from: string; to: string }>>().notNull().default([]),
});
export const strategyReviewJobs = pgTable('strategy_review_jobs', {
  id: uuid('id').primaryKey().defaultRandom(), owner: text('owner').notNull(), accountId: uuid('account_id').notNull(),
  key: text('key').notNull().unique(), from: text('from_date').notNull(), to: text('to_date').notNull(), state: text('state').notNull(),
  reportVersionId: uuid('report_version_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
export const strategyReservations = pgTable('strategy_reservations', {
  signalId: uuid('signal_id').primaryKey(), owner: text('owner').notNull(), accountId: uuid('account_id').notNull(),
  ticker: text('ticker').notNull(), side: text('side').notNull(), currency: text('currency').notNull(),
  cash: numeric('cash').notNull(), shares: numeric('shares').notNull(),
  status: text('status').notNull().default('active'), reason: text('reason').notNull().default('Candidate review'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
export const strategyResearchAlerts = pgTable('strategy_research_alerts', {
  id: uuid('id').primaryKey().defaultRandom(), owner: text('owner').notNull(),
  mandateId: uuid('mandate_id').notNull(), accountId: uuid('account_id').notNull(), ruleId: text('rule_id').notNull(),
  reason: text('reason').notNull(), sessionId: uuid('session_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [uniqueIndex('strategy_research_alert_rule').on(table.mandateId, table.ruleId)]);
