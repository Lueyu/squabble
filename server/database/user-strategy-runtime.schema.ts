import { pgTable, uuid, text, jsonb, timestamp } from 'drizzle-orm/pg-core';
import type { SimulationSeed } from '../../shared/simulation-experiment.interface';

/** First credible valuation for a quote-missing clone, separate from its immutable opening inventory. */
export const simulationValuationBaselines = pgTable('simulation_valuation_baselines', {
  accountId: uuid('account_id').primaryKey(), owner: text('owner').notNull(),
  seed: jsonb('seed').$type<SimulationSeed>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
