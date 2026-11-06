import { boolean, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

export const experiencePreferences = pgTable('experience_preferences', {
  owner:text('owner').primaryKey(),timezone:text('timezone').notNull().default('Asia/Shanghai'),
  defaultMembers:jsonb('default_members').$type<string[]>().notNull().default([]),
  memberSettings:jsonb('member_settings').$type<Record<string, import('../../shared/local-agents.interface').NativeAgentConfiguration>>().notNull().default({}),
  defaultAccountId:uuid('default_account_id'),migrationState:text('migration_state').notNull().default('new'),
  enabled:boolean('enabled').notNull().default(true),updatedAt:timestamp('updated_at',{withTimezone:true}).notNull().defaultNow(),
});
export const researchCurrentViews=pgTable('research_current_views',{
  id:uuid('id').primaryKey().defaultRandom(),owner:text('owner').notNull(),topicKey:text('topic_key').notNull(),dateKey:text('date_key').notNull(),
  currentDocumentId:uuid('current_document_id'),generationKey:text('generation_key'),generationSequence:integer('generation_sequence').notNull().default(0),
  state:text('state').notNull().default('empty'),taskId:uuid('task_id'),taskKind:text('task_kind'),automaticTaskId:uuid('automatic_task_id'),error:text('error'),changeSummary:text('change_summary'),
  dispatchSnapshot:jsonb('dispatch_snapshot').$type<import('../../shared/portfolio-report.interface').PortfolioReportSnapshot>(),
  dispatchRoute:jsonb('dispatch_route').$type<import('../../shared/model-route.interface').ModelRoute>(),
  updatedAt:timestamp('updated_at',{withTimezone:true}).notNull().defaultNow(),
},t=>[uniqueIndex('research_current_view_identity').on(t.owner,t.topicKey,t.dateKey)]);
export const researchFollowupJobs=pgTable('research_followup_jobs',{
  id:uuid('id').primaryKey().defaultRandom(),owner:text('owner').notNull(),thesisId:uuid('thesis_id').notNull(),observationKey:text('observation_key').notNull(),
  dueAt:timestamp('due_at',{withTimezone:true}).notNull(),state:text('state').notNull().default('queued'),
  leaseToken:uuid('lease_token'),leaseUntil:timestamp('lease_until',{withTimezone:true}),sessionId:uuid('session_id'),
  result:jsonb('result').$type<Record<string,unknown>>(),createdAt:timestamp('created_at',{withTimezone:true}).notNull().defaultNow(),
  updatedAt:timestamp('updated_at',{withTimezone:true}).notNull().defaultNow(),
},t=>[uniqueIndex('research_followup_identity').on(t.owner,t.thesisId,t.observationKey)]);
