import { index, pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { users } from './schema';
import type { ModelConnectionTestState } from '@shared/model-connections.interface';

/**
 * 用户自有的 OpenAI 兼容连接。迁移 10 创建连接表，迁移 70 添加测试回执字段。
 * `api_key_enc` 保存加密后的凭据，`owner` 外键随用户删除级联清理。
 */
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
    testAttemptId: uuid('test_attempt_id'),
    testState: varchar('test_state', { length: 12 }).$type<ModelConnectionTestState>(),
    testedAt: timestamp('tested_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [index('model_connections_owner_idx').on(table.owner)],
);
