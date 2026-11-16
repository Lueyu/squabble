import { index, pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { users } from './schema';

export const modelConnections = pgTable(
  'model_connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    owner: uuid('owner')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 60 }).notNull(),
    baseUrl: text('base_url').notNull(),
    fastModel: varchar('fast_model', { length: 120 }).notNull(),
    slowModel: varchar('slow_model', { length: 120 }).notNull(),
    apiKeyEnc: text('api_key_enc').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [index('model_connections_owner_idx').on(table.owner)],
);
