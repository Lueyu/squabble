import { boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import type { MonitorCondition, MonitorObservation } from '@shared/research-monitor.interface';
import type { Market } from '@shared/api.interface';
import { councilReports } from './council.schema';

/** Rule versions and breach observations survive later rules and claim revisions. */
export const researchMonitorRules = pgTable('research_monitor_rules', {
  id: uuid('id').primaryKey().defaultRandom(), owner: text('owner').notNull(), rootId: uuid('root_id').notNull(),
  thesisId: uuid('thesis_id').notNull(), thesisVersion: integer('thesis_version').notNull(), version: integer('version').notNull(),
  ticker: text('ticker').notNull(), market: text('market').$type<Market>().notNull(), origin: text('origin').$type<'agent-reviewed' | 'user'>().notNull(),
  reportId: uuid('report_id').notNull().references(() => councilReports.id, { onDelete: 'cascade' }), reportVersion: integer('report_version').notNull(),
  condition: jsonb('condition').$type<MonitorCondition>().notNull(), enabled: boolean('enabled').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [uniqueIndex('research_monitor_rule_version_idx').on(t.owner, t.rootId, t.version), index('research_monitor_thesis_idx').on(t.owner, t.thesisId, t.thesisVersion)]);
export const researchMonitorEvents = pgTable('research_monitor_events', {
  id: uuid('id').primaryKey().defaultRandom(), owner: text('owner').notNull(), ruleId: uuid('rule_id').notNull(),
  ruleVersion: integer('rule_version').notNull(), thesisId: uuid('thesis_id').notNull(), thesisVersion: integer('thesis_version').notNull(),
  observationKey: text('observation_key').notNull(), observation: jsonb('observation').$type<MonitorObservation>().notNull(),
  state: text('state').$type<MonitorObservation['state']>().notNull(), createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  sequence: integer('sequence').notNull().default(0),
}, t => [uniqueIndex('research_monitor_observation_idx').on(t.owner, t.ruleId, t.ruleVersion, t.thesisVersion, t.observationKey),
  index('research_monitor_breach_idx').on(t.owner, t.thesisId, t.thesisVersion, t.state),
  index('research_monitor_latest_idx').on(t.owner, t.ruleId, t.sequence.desc(), t.createdAt.desc(), t.id.desc())]);
export const researchThesisReplacements = pgTable('research_thesis_replacements', {
  id: uuid('id').primaryKey().defaultRandom(), owner: text('owner').notNull(), thesisId: uuid('thesis_id').notNull(),
  thesisVersion: integer('thesis_version').notNull(), previousId: uuid('previous_id').notNull(), previousVersion: integer('previous_version').notNull(),
  reason: text('reason').notNull(), cycleId: uuid('cycle_id').notNull(), taskId: uuid('task_id').notNull(), attemptId: uuid('attempt_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [uniqueIndex('research_thesis_replacement_idx').on(t.owner, t.thesisId, t.thesisVersion)]);
