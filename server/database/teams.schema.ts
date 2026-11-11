import { sql } from 'drizzle-orm';
import { index, integer, jsonb, pgTable, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import type { TeamSemanticConfig, TeamDisplay, TeamLayout, TeamGuardSet, TeamCommissionPlan, TeamMemberSnapshot, TeamBudget, TeamDecisionBasis } from '../../shared/team-workspace.interface';
const time = (name: string) => timestamp(name, { withTimezone: true, precision: 3 }).notNull().defaultNow();
export const teams = pgTable('teams', {
    id: uuid('id').primaryKey().defaultRandom(), ownerId: text('owner_id').notNull(),
    name: text('name').notNull(), description: text('description').notNull().default(''), avatar: text('avatar'),
    status: text('status').notNull().default('active'), display: jsonb('display_json').$type<TeamDisplay>().notNull(),
    displayRevision: integer('display_revision').notNull().default(1), layout: jsonb('layout_json').$type<TeamLayout>().notNull(),
    layoutRevision: integer('layout_revision').notNull().default(1), bindingRevision: integer('binding_revision').notNull().default(0),
    scopeRevision: integer('scope_revision').notNull().default(0), accountId: uuid('account_id'), currentVersionId: uuid('current_version_id'),
    createdAt: time('created_at'), updatedAt: time('updated_at'),
}, t => [uniqueIndex('teams_owner_id_idx').on(t.ownerId, t.id), index('teams_owner_status_idx').on(t.ownerId, t.status, t.updatedAt)]);
export const teamDrafts = pgTable('team_drafts', {
    teamId: uuid('team_id').primaryKey(), ownerId: text('owner_id').notNull(),
    semanticRevision: integer('semantic_revision').notNull().default(1), baseVersionId: uuid('base_version_id'),
    config: jsonb('config_json').$type<TeamSemanticConfig>().notNull(), createdAt: time('created_at'), updatedAt: time('updated_at'),
});
export const teamVersions = pgTable('team_versions', {
    id: uuid('id').primaryKey().defaultRandom(), teamId: uuid('team_id').notNull(), ownerId: text('owner_id').notNull(),
    version: integer('version').notNull(), semanticRevision: integer('semantic_revision').notNull(), semanticHash: text('semantic_hash').notNull(),
    config: jsonb('config_json').$type<TeamSemanticConfig>().notNull(), displaySnapshot: jsonb('display_snapshot').$type<TeamDisplay>().notNull(),
    createdBy: text('created_by').notNull(), createdAt: time('created_at'),
}, t => [uniqueIndex('team_versions_owner_id_idx').on(t.ownerId, t.id), uniqueIndex('team_versions_number_idx').on(t.teamId, t.version)]);
export const teamAccountBindings = pgTable('team_account_bindings', {
    id: uuid('id').primaryKey().defaultRandom(), ownerId: text('owner_id').notNull(), teamId: uuid('team_id').notNull(),
    accountId: uuid('account_id').notNull(), bindingRevision: integer('binding_revision').notNull(), teamVersionId: uuid('team_version_id').notNull(),
    state: text('state').notNull(), previousBindingId: uuid('previous_binding_id'), effectiveFrom: time('effective_from'),
    effectiveTo: timestamp('effective_to', { withTimezone: true, precision: 3 }), executionChoice: text('execution_choice').notNull(),
    policySnapshot: jsonb('policy_snapshot').$type<Record<string, unknown>>(), createdAt: time('created_at'), updatedAt: time('updated_at'),
}, t => [uniqueIndex('team_bindings_owner_id_idx').on(t.ownerId, t.id),
    uniqueIndex('team_bindings_active_team_idx').on(t.teamId).where(sql `state = 'active'`),
    uniqueIndex('team_bindings_active_account_idx').on(t.accountId).where(sql `state = 'active'`)]);
export const teamPreviews = pgTable('team_previews', {
    id: uuid('id').primaryKey().defaultRandom(), ownerId: text('owner_id').notNull(), teamId: uuid('team_id').notNull(),
    kind: text('kind').notNull(), payload: jsonb('payload_json').$type<Record<string, unknown>>().notNull(),
    guards: jsonb('guards_json').$type<TeamGuardSet>().notNull(), previewHash: text('preview_hash').notNull(), compilerVersion: text('compiler_version').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, precision: 3 }).notNull(), consumedByRequestKey: text('consumed_by_request_key'), createdAt: time('created_at'),
});
export const teamRequests = pgTable('team_requests', {
    id: uuid('id').primaryKey().defaultRandom(), ownerId: text('owner_id').notNull(), requestKey: text('request_key').notNull(),
    operation: text('operation').notNull(), teamId: uuid('team_id'), inputHash: text('input_hash').notNull(),
    result: jsonb('result_json').$type<unknown>().notNull(), httpStatus: integer('http_status').notNull(), completedAt: time('completed_at'),
}, t => [uniqueIndex('team_requests_owner_key_idx').on(t.ownerId, t.requestKey)]);
export const teamCommissions = pgTable('team_commissions', {
    id: uuid('id').primaryKey().defaultRandom(), ownerId: text('owner_id').notNull(), teamId: uuid('team_id').notNull(), accountId: uuid('account_id').notNull(),
    bindingId: uuid('binding_id').notNull(), bindingRevision: integer('binding_revision').notNull(), teamVersionId: uuid('team_version_id').notNull(),
    scopeRevision: integer('scope_revision').notNull(), commissionRevision: integer('commission_revision').notNull().default(1), previewId: uuid('preview_id').notNull(),
    plan: jsonb('plan_json').$type<TeamCommissionPlan>().notNull(), inputSnapshot: jsonb('input_snapshot').$type<Record<string, unknown>>().notNull(),
    members: jsonb('member_snapshots').$type<TeamMemberSnapshot[]>().notNull(), rootBudgetTaskId: text('root_budget_task_id').notNull(),
    sessionId: uuid('session_id'), cycleId: uuid('cycle_id'), state: text('state').notNull(),
    budgetLimit: jsonb('budget_limit_json').$type<TeamBudget>().notNull(), budgetLimitRevision: integer('budget_limit_revision').notNull().default(1),
    lastError: jsonb('last_error_json').$type<Record<string, unknown>>(), requestedBy: text('requested_by').notNull(),
    cancelRequestedAt: timestamp('cancel_requested_at', { withTimezone: true, precision: 3 }), completedAt: timestamp('completed_at', { withTimezone: true, precision: 3 }),
    createdAt: time('created_at'), updatedAt: time('updated_at'),
}, t => [uniqueIndex('team_commissions_owner_id_idx').on(t.ownerId, t.id), uniqueIndex('team_commissions_preview_idx').on(t.previewId),
    uniqueIndex('team_commissions_session_idx').on(t.sessionId).where(sql `session_id IS NOT NULL`), index('team_commissions_state_idx').on(t.teamId, t.state, t.createdAt)]);
export const teamCommissionJobs = pgTable('team_commission_jobs', {
    id: uuid('id').primaryKey().defaultRandom(), ownerId: text('owner_id').notNull(), commissionId: uuid('commission_id').notNull(), kind: text('kind').notNull(),
    commandKey: text('command_key').notNull(), payload: jsonb('payload_json').$type<Record<string, unknown>>().notNull(), state: text('state').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0), leaseOwner: text('lease_owner'), leaseUntil: timestamp('lease_until', { withTimezone: true, precision: 3 }),
    nextAttemptAt: time('next_attempt_at'), lastError: jsonb('last_error_json').$type<Record<string, unknown>>(), createdAt: time('created_at'), updatedAt: time('updated_at'),
}, t => [uniqueIndex('team_jobs_command_idx').on(t.commissionId, t.commandKey), index('team_jobs_pending_idx').on(t.state, t.nextAttemptAt)]);
export const teamResearchLinks = pgTable('team_research_links', {
    id: uuid('id').primaryKey().defaultRandom(), ownerId: text('owner_id').notNull(), teamId: uuid('team_id').notNull(), commissionId: uuid('commission_id').notNull(),
    kind: text('kind').notNull(), targetId: text('target_id').notNull(), targetRevision: text('target_revision'), relation: text('relation').notNull(),
    workKey: text('work_key'), attemptId: text('attempt_id'), metadata: jsonb('metadata_json').$type<Record<string, unknown>>().notNull().default({}), createdAt: time('created_at'),
}, t => [unique('team_links_identity_idx').on(t.commissionId, t.kind, t.targetId, t.targetRevision, t.relation).nullsNotDistinct()]);
export const teamDecisions = pgTable('team_decisions', {
    id: uuid('id').primaryKey().defaultRandom(), ownerId: text('owner_id').notNull(), teamId: uuid('team_id').notNull(), accountId: uuid('account_id').notNull(),
    commissionId: uuid('commission_id'), proposalId: uuid('proposal_id').notNull(), proposalRevision: integer('proposal_revision').notNull(), event: text('event').notNull(),
    actorType: text('actor_type').notNull(), actorId: text('actor_id').notNull(), basis: jsonb('basis_json').$type<TeamDecisionBasis>().notNull(),
    reason: text('reason').notNull(), policyContext: jsonb('policy_context_json').$type<Record<string, unknown>>(), requestKey: text('request_key').notNull(), createdAt: time('created_at'),
}, t => [uniqueIndex('team_decisions_owner_id_idx').on(t.ownerId, t.id), uniqueIndex('team_decisions_proposal_idx').on(t.proposalId, t.proposalRevision)]);
export const teamSourceGrants = pgTable('team_source_grants', {
    id: uuid('id').primaryKey().defaultRandom(), ownerId: text('owner_id').notNull(), teamId: uuid('team_id').notNull(), sourceKind: text('source_kind').notNull(),
    sourceId: text('source_id').notNull(), sourceRevision: text('source_revision').notNull(), state: text('state').notNull(), grantedBy: text('granted_by').notNull(),
    grantedAt: time('granted_at'), revokedAt: timestamp('revoked_at', { withTimezone: true, precision: 3 }), reason: text('reason'),
}, t => [uniqueIndex('team_grants_owner_id_idx').on(t.ownerId, t.id),
    uniqueIndex('team_grants_active_idx').on(t.teamId, t.sourceKind, t.sourceId, t.sourceRevision).where(sql `state = 'active'`)]);
