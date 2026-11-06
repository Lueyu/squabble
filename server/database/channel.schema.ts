import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import type { BackgroundFinding, ChannelBrief, ChannelBubble, ChannelEpisode, ChannelEvent, ChannelFact, ChannelTemplate, ChannelVibe, DecisionReflection, DeferredQuestion, FindingSeal, RelationshipMemoryEvent, SupplementRequest } from '../../shared/channel.interface';

const time = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
export const channelPreferences = pgTable('channel_preferences', {
  owner: text('owner').primaryKey(), vibe: text('vibe').$type<ChannelVibe>().notNull().default('deskmate'),
  pinnedBubbleId: text('pinned_bubble_id'), revision: integer('revision').notNull().default(1),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
export const channelReports = pgTable('channel_reports', {
  id: text('id').notNull(), owner: text('owner').notNull(), revision: integer('revision').notNull(),
  title: text('title').notNull(), content: text('content').notNull(), sectionIds: jsonb('section_ids').$type<string[]>().notNull(),
  source: jsonb('source').$type<Record<string, unknown>>().notNull().default({}), createdAt: time(),
}, t => [uniqueIndex('channel_report_identity').on(t.owner, t.id, t.revision)]);
export const channelFacts = pgTable('channel_facts', {
  id: text('id').notNull(), owner: text('owner').notNull(), revision: integer('revision').notNull(),
  data: jsonb('data').$type<ChannelFact>().notNull(), card: jsonb('card').$type<import('../../shared/channel.interface').ChannelEvidenceCard>().notNull(), createdAt: time(),
}, t => [uniqueIndex('channel_fact_identity').on(t.owner, t.id, t.revision)]);
export const channelEpisodes = pgTable('channel_episodes', {
  id: text('id').notNull(), owner: text('owner').notNull(), title: text('title').notNull(),
  data: jsonb('data').$type<ChannelEpisode>().notNull(), updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(), createdAt: time(),
}, t => [uniqueIndex('channel_episode_identity').on(t.owner, t.id), index('channel_episode_owner_updated').on(t.owner, t.updatedAt)]);
export const channelEvents = pgTable('channel_events', {
  id: text('id').notNull(), owner: text('owner').notNull(), episodeId: text('episode_id').notNull(),
  data: jsonb('data').$type<ChannelEvent>().notNull(), createdAt: time(),
}, t => [uniqueIndex('channel_event_identity').on(t.owner, t.id), index('channel_event_episode').on(t.owner, t.episodeId)]);
export const channelBubbles = pgTable('channel_bubbles', {
  id: text('id').notNull(), owner: text('owner').notNull(), episodeId: text('episode_id').notNull(), semanticDeltaId: text('semantic_delta_id').notNull(),
  data: jsonb('data').$type<ChannelBubble>().notNull(), resolvedAt: timestamp('resolved_at', { withTimezone: true }), createdAt: time(),
}, t => [uniqueIndex('channel_bubble_id').on(t.owner, t.id), uniqueIndex('channel_bubble_publication').on(t.owner, t.episodeId, t.semanticDeltaId), index('channel_bubble_owner_created').on(t.owner, t.createdAt)]);
export const channelOutbox = pgTable('channel_outbox', {
  id: text('id').primaryKey(), owner: text('owner').notNull(), bubbleId: text('bubble_id').notNull(),
  destination: text('destination').notNull(), state: text('state').notNull().default('pending'), createdAt: time(),
}, t => [uniqueIndex('channel_outbox_delivery').on(t.bubbleId, t.destination), index('channel_outbox_owner').on(t.owner, t.createdAt)]);
export const channelFindings = pgTable('channel_findings', {
  id: text('id').notNull(), owner: text('owner').notNull(), data: jsonb('data').$type<BackgroundFinding>().notNull(),
  seal: jsonb('seal').$type<FindingSeal | null>(), createdAt: time(),
}, t => [uniqueIndex('channel_finding_identity').on(t.owner, t.id)]);
export const channelBriefs = pgTable('channel_briefs', {
  id: text('id').notNull(), owner: text('owner').notNull(), data: jsonb('data').$type<ChannelBrief>().notNull(), createdAt: time(),
}, t => [uniqueIndex('channel_brief_identity').on(t.owner, t.id)]);
export const channelTemplateRegistry = pgTable('template_registry', {
  id: text('id').notNull(), revision: integer('revision').notNull(), data: jsonb('data').$type<ChannelTemplate>().notNull(), createdAt: time(),
}, t => [uniqueIndex('template_registry_identity').on(t.id, t.revision)]);
export const channelSupplementRequests = pgTable('channel_supplement_requests', {
  id: text('id').notNull(), owner: text('owner').notNull(), requestKey: text('request_key').notNull(), inputHash: text('input_hash').notNull(),
  message: text('message').notNull(), data: jsonb('data').$type<SupplementRequest>().notNull(),
  leaseUntil: timestamp('lease_until', { withTimezone: true }),
  result: jsonb('result').$type<Record<string, unknown> | null>(), createdAt: time(),
}, t => [uniqueIndex('channel_supplement_id').on(t.owner, t.id), uniqueIndex('channel_supplement_request').on(t.owner, t.requestKey)]);
export const channelDeferredQuestions = pgTable('channel_deferred_questions', {
  id: text('id').notNull(), owner: text('owner').notNull(), requestId: text('request_id').notNull(),
  data: jsonb('data').$type<DeferredQuestion>().notNull(), createdAt: time(),
}, t => [uniqueIndex('channel_deferred_identity').on(t.owner, t.id)]);
export const channelUserActions = pgTable('channel_user_actions', {
  id: text('id').primaryKey(), owner: text('owner').notNull(), requestKey: text('request_key').notNull(), inputHash: text('input_hash').notNull(),
  data: jsonb('data').$type<Record<string, unknown>>().notNull(), result: jsonb('result').$type<Record<string, unknown>>().notNull(), createdAt: time(),
}, t => [uniqueIndex('channel_action_request').on(t.owner, t.requestKey)]);
export const channelMemories = pgTable('channel_memories', {
  id: text('id').notNull(), owner: text('owner').notNull(), data: jsonb('data').$type<RelationshipMemoryEvent>().notNull(), createdAt: time(),
}, t => [uniqueIndex('channel_memory_identity').on(t.owner, t.id)]);
export const channelDecisionReflections = pgTable('channel_decision_reflections', {
  id: text('id').notNull(), owner: text('owner').notNull(), decisionId: text('decision_id').notNull(),
  data: jsonb('data').$type<DecisionReflection>().notNull(), createdAt: time(),
}, t => [uniqueIndex('channel_reflection_identity').on(t.owner, t.id), index('channel_reflection_decision').on(t.owner, t.decisionId)]);
