import { sql } from 'drizzle-orm';
import { check, index, pgTable, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { users } from './schema';

export const researchToolUsage = pgTable(
  'research_tool_usage',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    owner: uuid('owner')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    taskId: varchar('task_id', { length: 160 }).notNull(),
    provider: varchar('provider', { length: 40 }).notNull().default('deepseek_search'),
    status: varchar('status', { length: 24 }).notNull().default('reserved'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    settledAt: timestamp('settled_at', { withTimezone: true }),
  },
  (table) => [
    index('research_tool_usage_owner_date').on(table.owner, table.createdAt),
    index('research_tool_usage_owner_task').on(table.owner, table.taskId),
    check(
      'research_tool_usage_status',
      sql`${table.status} IN ('reserved', 'succeeded', 'failed', 'cancelled')`,
    ),
  ],
);
