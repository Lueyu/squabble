import { boolean, integer, jsonb, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import type { AgentDataClass } from '../../shared/agent-tooling.interface';
export const toolCapabilityReadiness = pgTable('tool_capability_readiness', {
  packId: text('pack_id').primaryKey(), manifestHash: text('manifest_hash').notNull(),
  ready: boolean('ready').notNull().default(false),
  facts: jsonb('facts').$type<Record<string, string | number | boolean | null>>().notNull().default({}),
  reasonCode: text('reason_code'), checkedAt: timestamp('checked_at', { withTimezone: true }).notNull().defaultNow(),
});
export const toolCapabilityGrants = pgTable('tool_capability_grants', {
  owner: text('owner').notNull(), packId: text('pack_id').notNull(),
  revision: integer('revision').notNull().default(1), enabled: boolean('enabled').notNull().default(false),
  manifestHash: text('manifest_hash').notNull(), dataClasses: jsonb('data_classes').$type<AgentDataClass[]>().notNull().default(['public']),
  publicNetwork: boolean('public_network').notNull().default(false), connectionId: uuid('connection_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [primaryKey({ columns: [table.owner, table.packId] })]);
