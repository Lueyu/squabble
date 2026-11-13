import { boolean, jsonb, numeric, pgTable, text, timestamp, uniqueIndex, uuid, index } from 'drizzle-orm/pg-core';
/** Provider facts, not timestamps synthesized from the sampling clock. */
export interface PortfolioMarketQuote {
    ticker: string;
    market: string;
    currency: string;
    price: number;
    quoteAt: string;
    source: string;
}
export const paperEquityObservations = pgTable('paper_equity_observations', {
    id: uuid('id').primaryKey().defaultRandom(), owner: text('owner').notNull(), accountId: uuid('account_id').notNull(),
    slot: text('slot').notNull(), dateKey: text('date_key').notNull(), capturedAt: timestamp('captured_at', { withTimezone: true }).notNull(),
    equityUsd: numeric('equity_usd'), knownValueUsd: numeric('known_value_usd').notNull(),
    complete: boolean('complete').notNull(), estimated: boolean('estimated').notNull(),
    marketQuotes: jsonb('market_quotes').$type<PortfolioMarketQuote[]>().notNull().default([]),
    gaps: jsonb('gaps').$type<string[]>().notNull().default([]),
    sourceFingerprint: text('source_fingerprint').notNull(),
}, t => [uniqueIndex('paper_equity_observation_slot').on(t.owner, t.accountId, t.slot),
    index('paper_equity_observation_time').on(t.owner, t.accountId, t.capturedAt)]);
/** A renewable, fenced claim prevents multiple processes fetching the same account/slot. */
export const portfolioValuationClaims = pgTable('portfolio_valuation_claims', {
    owner: text('owner').notNull(), accountKey: text('account_key').notNull(), slot: text('slot').notNull(),
    token: uuid('token').notNull(), leaseUntil: timestamp('lease_until', { withTimezone: true }).notNull(),
    completed: boolean('completed').notNull().default(false),
}, t => [uniqueIndex('portfolio_valuation_claim_slot').on(t.owner, t.accountKey, t.slot)]);
