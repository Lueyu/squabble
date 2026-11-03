import { sql } from 'drizzle-orm';
import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import { councilSessions } from './council.schema';
import type { ResearchDelivery, ResearchSkillPin, ResearchTaskAttempt, ResearchTaskKind, ResearchTaskState } from '../../shared/research-workflow.interface';

export const councilResearchTasks = pgTable('council_research_tasks', {
  id: uuid('id').primaryKey().defaultRandom(), owner: text('owner').notNull(),
  sessionId: uuid('session_id').notNull().references(() => councilSessions.id, { onDelete: 'cascade' }),
  cycleId: uuid('cycle_id').notNull(), revision: integer('revision').notNull(),
  key: varchar('key', { length: 20 }).$type<ResearchTaskKind>().notNull(), position: integer('position').notNull(),
  memberId: text('member_id').notNull(), dependencies: jsonb('dependencies').$type<ResearchTaskKind[]>().notNull(),
  state: varchar('state', { length: 20 }).$type<ResearchTaskState>().notNull().default('queued'), reason: text('reason'),
  attempts: jsonb('attempts').$type<ResearchTaskAttempt[]>().notNull().default(sql`'[]'::jsonb`),
  delivery: jsonb('delivery').$type<ResearchDelivery | null>(), skills: jsonb('skills').$type<ResearchSkillPin[]>().notNull(),
  reworks: integer('reworks').notNull().default(0), acceptedAttemptId: uuid('accepted_attempt_id'),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
}, t => [uniqueIndex('council_research_tasks_cycle_key_idx').on(t.sessionId, t.cycleId, t.key),
  index('council_research_tasks_owner_idx').on(t.owner, t.sessionId, t.cycleId)]);
