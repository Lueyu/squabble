import { pgTable, text, uuid, integer, timestamp, primaryKey } from 'drizzle-orm/pg-core';

export const builderScanLeases = pgTable('builder_scan_leases', {
  owner: text('owner').primaryKey(),
  token: uuid('token').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});
export const builderReviewChecks = pgTable(
  'builder_review_checks',
  {
    owner: text('owner').notNull(),
    profileId: uuid('profile_id').notNull(),
    ticker: text('ticker').notNull(),
    profileVersion: integer('profile_version').notNull(),
    inputHash: text('input_hash').notNull(),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }).notNull(),
    decision: text('decision').notNull(),
    reason: text('reason').notNull(),
  },
  (table) => [primaryKey({ columns: [table.owner, table.profileId, table.ticker] })],
);
