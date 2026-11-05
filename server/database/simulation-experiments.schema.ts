import { pgTable, text, uuid, timestamp, jsonb, numeric, uniqueIndex, boolean } from 'drizzle-orm/pg-core';
import type { SimulationSeed } from '../../shared/simulation-experiment.interface';

export const simulationPreviews = pgTable('simulation_previews', {
  id: uuid('id').primaryKey().defaultRandom(), owner: text('owner').notNull(),
  seed: jsonb('seed').$type<SimulationSeed>().notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
export const simulationSeeds = pgTable('simulation_seeds', {
  accountId: uuid('account_id').primaryKey(), owner: text('owner').notNull(),
  previewId: uuid('preview_id').notNull().unique(), idempotencyKey: text('idempotency_key').notNull(),
  requestHash: text('request_hash').notNull(), seed: jsonb('seed').$type<SimulationSeed>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex('simulation_seed_idempotency').on(t.owner, t.idempotencyKey)]);
export const simulationCash = pgTable('simulation_cash', {
  id: uuid('id').primaryKey().defaultRandom(), accountId: uuid('account_id').notNull(), owner: text('owner').notNull(),
  currency: text('currency').notNull(), available: numeric('available').notNull().default('0'),
  frozen: numeric('frozen').notNull().default('0'), unsettled: numeric('unsettled').notNull().default('0'),
  availabilityKnown: boolean('availability_known').notNull().default(false),
}, (t) => [uniqueIndex('simulation_cash_account_currency').on(t.accountId, t.currency)]);
export const simulationSettlements = pgTable('simulation_settlements', {
  id: uuid('id').primaryKey().defaultRandom(), accountId: uuid('account_id').notNull(), currency: text('currency').notNull(),
  amount: numeric('amount').notNull(), availableAt: timestamp('available_at', { withTimezone: true }).notNull(),
  settledAt: timestamp('settled_at', { withTimezone: true }),
});
