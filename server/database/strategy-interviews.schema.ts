import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import type { StrategyInterviewPreview, StrategyInterviewState, StrategyInterviewView } from '../../shared/strategy-interview.interface';

/** Authoring only. An interview is never a source of live execution authority. */
export const strategyInterviews = pgTable('strategy_interviews', {
  id: uuid('id').primaryKey().defaultRandom(), owner: text('owner').notNull(), accountId: uuid('account_id').notNull(),
  baseStrategyId: uuid('base_strategy_id'), revision: integer('revision').notNull().default(1),
  state: jsonb('state').$type<StrategyInterviewState>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [index('strategy_interviews_owner_account_updated').on(table.owner, table.accountId, table.updatedAt)]);

export const strategyInterviewRequests = pgTable('strategy_interview_requests', {
  owner: text('owner').notNull(), requestKey: text('request_key').notNull(), inputHash: text('input_hash').notNull(),
  interviewId: uuid('interview_id').notNull().references(() => strategyInterviews.id),
  result: jsonb('result').$type<StrategyInterviewView | StrategyInterviewPreview>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [uniqueIndex('strategy_interview_request_owner_key').on(table.owner, table.requestKey)]);
