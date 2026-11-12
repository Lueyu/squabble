import { sql } from 'drizzle-orm';
import { index, integer, jsonb, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import type { TeamRunConfiguration } from '../../shared/team-run.interface';
import type { TeamMemberSnapshot } from '../../shared/team-workspace.interface';
const time = (name: string) => timestamp(name, { withTimezone: true, precision: 3 }).notNull().defaultNow();
export const teamRunAgreements = pgTable('team_run_agreements', {
  id: uuid('id').primaryKey().defaultRandom(), ownerId: text('owner_id').notNull(), teamId: uuid('team_id').notNull(), accountId: uuid('account_id').notNull(),
  revision: integer('revision').notNull().default(1), state: text('state').notNull(), configuration: jsonb('configuration_json').$type<TeamRunConfiguration>().notNull(),
  scopeRevision: integer('scope_revision').notNull(), members: jsonb('member_snapshots').$type<TeamMemberSnapshot[]>().notNull(),
  confirmedBy: text('confirmed_by').notNull(), confirmedAt: time('confirmed_at'), updatedAt: time('updated_at'), suspensionReason: text('suspension_reason'),
}, t => [uniqueIndex('team_run_agreements_team_idx').on(t.ownerId, t.teamId), uniqueIndex('team_run_agreements_owner_id_idx').on(t.ownerId, t.id)]);
export const teamRunCycles = pgTable('team_run_cycles', {
  id: uuid('id').primaryKey().defaultRandom(), ownerId: text('owner_id').notNull(), teamId: uuid('team_id').notNull(), agreementId: uuid('agreement_id').notNull(),
  agreementRevision: integer('agreement_revision').notNull(), tradingDate: text('trading_date').notNull(), state: text('state').notNull(),
  commissionId: uuid('commission_id'), reportVersionId: uuid('report_version_id'), decisionId: uuid('decision_id'), strategyId: uuid('strategy_id'), policyRevision: integer('policy_revision'),
  reservedCostUsd: numeric('reserved_cost_usd', { precision: 24, scale: 8 }).notNull(), reservedCalls: integer('reserved_calls').notNull(), lastError: text('last_error'),
  leaseOwner: text('lease_owner'), leaseUntil: timestamp('lease_until', { withTimezone: true, precision: 3 }), createdAt: time('created_at'), updatedAt: time('updated_at'),
}, t => [uniqueIndex('team_run_cycles_date_idx').on(t.agreementId, t.tradingDate), uniqueIndex('team_run_cycles_commission_idx').on(t.commissionId),
  uniqueIndex('team_run_cycles_active_idx').on(t.agreementId).where(sql`state IN ('reserved','researching','processing','uncertain')`),
  index('team_run_cycles_owner_idx').on(t.ownerId, t.createdAt)]);
/** Immutable consent history; mutable agreement state always points at one exact saved revision. */
export const teamRunAgreementRevisions = pgTable('team_run_agreement_revisions', {
  id: uuid('id').primaryKey().defaultRandom(), ownerId: text('owner_id').notNull(), agreementId: uuid('agreement_id').notNull(),
  revision: integer('revision').notNull(), state: text('state').notNull(), accountId: uuid('account_id').notNull(),
  configuration: jsonb('configuration_json').$type<TeamRunConfiguration>().notNull(), members: jsonb('member_snapshots').$type<TeamMemberSnapshot[]>().notNull(),
  scopeRevision: integer('scope_revision').notNull(), confirmedBy: text('confirmed_by').notNull(), confirmedAt: time('confirmed_at'),
  suspensionReason: text('suspension_reason'), createdAt: time('created_at'),
}, t => [uniqueIndex('team_run_revision_idx').on(t.agreementId, t.revision)]);
