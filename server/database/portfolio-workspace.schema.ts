import { boolean, integer, jsonb, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import type { ConfirmedInvestmentStrategy } from '../../shared/user-investment-strategy.interface';
import type { PortfolioAllocationInput, PortfolioStrategyAssignment } from '../../shared/portfolio-workspace.interface';

export const portfolioStrategyAssignments = pgTable('portfolio_strategy_assignments', {
  id: uuid('id').primaryKey().defaultRandom(),
  owner: text('owner').notNull(),
  accountId: uuid('account_id').notNull(),
  strategyId: uuid('strategy_id').notNull(),
  strategyRevision: integer('strategy_revision').notNull(),
  allocationPct: numeric('allocation_pct', { precision: 7, scale: 4 }).notNull(),
  enabled: boolean('enabled').notNull(),
  snapshot: jsonb('snapshot').$type<ConfirmedInvestmentStrategy>().notNull(),
  policyRevision: integer('policy_revision').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [uniqueIndex('portfolio_assignment_account_strategy').on(t.owner, t.accountId, t.strategyId)]);

export const portfolioCombinationRevisions = pgTable('portfolio_combination_revisions', {
  id: uuid('id').primaryKey().defaultRandom(),
  owner: text('owner').notNull(),
  accountId: uuid('account_id').notNull(),
  policyRevision: integer('policy_revision').notNull(),
  allocations: jsonb('allocations').$type<PortfolioStrategyAssignment[]>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [uniqueIndex('portfolio_combination_revision').on(t.owner, t.accountId, t.policyRevision)]);

export const portfolioCombinationDrafts = pgTable('portfolio_combination_drafts', {
  owner: text('owner').notNull(),
  accountId: uuid('account_id').notNull(),
  expectedPolicyRevision: integer('expected_policy_revision').notNull(),
  allocations: jsonb('allocations').$type<PortfolioAllocationInput[]>().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [uniqueIndex('portfolio_combination_draft_account').on(t.owner, t.accountId)]);

export const portfolioCombinationPreviews = pgTable('portfolio_combination_previews', {
  id: uuid('id').primaryKey().defaultRandom(),
  owner: text('owner').notNull(),
  accountId: uuid('account_id').notNull(),
  policyRevision: integer('policy_revision').notNull(),
  previewHash: text('preview_hash').notNull(),
  allocations: jsonb('allocations').$type<PortfolioStrategyAssignment[]>().notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
