import { boolean, jsonb, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
export const portfolioValuePoints = pgTable('portfolio_value_points',{
  id:uuid('id').primaryKey().defaultRandom(),owner:text('owner').notNull(),dateKey:text('date_key').notNull(),slot:text('slot').notNull(),
  capturedAt:timestamp('captured_at',{withTimezone:true}).notNull(),totalValueUsd:numeric('total_value_usd'),knownValueUsd:numeric('known_value_usd').notNull(),
  complete:boolean('complete').notNull(),estimated:boolean('estimated').notNull(),
  externalFlows:jsonb('external_flows').$type<Array<{id:string;fingerprint:string}>>().notNull().default([]),
  cashCheckpoints:jsonb('cash_checkpoints').$type<Array<{currency:string;confirmedAt:string|null}>>().notNull().default([]),
  positionCheckpoints:jsonb('position_checkpoints').$type<Array<{kind:'baseline'|'opening';id:string;fingerprint:string}>>().notNull().default([]),
},t=>[uniqueIndex('portfolio_value_point_slot').on(t.owner,t.slot)]);
