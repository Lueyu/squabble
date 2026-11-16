/**
 * 用户自定义模型连接（model_connections）表定义（Drizzle schema）。
 *
 * 职责边界：只声明表结构与索引；加解密与 CRUD 逻辑在 settings 模块
 * （model-connections.service.ts / settings-security.ts），本文件不管。
 * 对应增量迁移脚本 scripts/db/10_model_connections.sql。
 *
 * 上下游：import drizzle-orm/pg-core 与 users 表（./schema）；被
 * modules/settings 的 service/controller 使用。
 *
 * 关键约定：owner 外键关联 users.id 且 onDelete: 'cascade'（用户删除时
 * 连接一并删除）；api_key_enc 存加密后的 API Key 密文（非明文）。
 */
import { index, pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { users } from './schema';

/**
 * 模型连接表：一个用户可配置多个自定义 OpenAI 兼容端点，含 fast/slow 两档
 * 模型名。owner 上建索引（model_connections_owner_idx）以加速按属主查询。
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
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [index('model_connections_owner_idx').on(table.owner)],
);
