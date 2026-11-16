/**
 * 第一方数据库 provider：直连 postgres.js + Drizzle。
 *
 * 职责边界：负责创建并持有唯一的 Drizzle 数据库连接（连接池），并在启动时
 * 执行增量 DDL 迁移；不包含任何业务查询逻辑。取代旧的 platform datapaas
 * 层：service 仍注入同一个 `DRIZZLE_DATABASE` token，但连接直连 PostgreSQL，
 * 按行归属由 `owner` text 列强制约束（见 server/database/schema.ts），
 * 不再依赖复合类型与角色切换。
 *
 * 上下游：import drizzle/postgres/postgres.js、schema 表定义；DatabaseModule
 * 为 @Global 模块，由 AppModule 引入一次，全部业务 service 注入该 token。
 *
 * 关键约定（从代码读出）：
 * - `DATABASE_URL` 同时接受普通连接串和带 `?schema=...` 的旧格式字符串
 *   （该参数会被忽略并剥离）；
 * - 连接池上限取环境变量 DB_POOL_MAX，未设置时默认 10；
 * - 迁移脚本按编号顺序（03→15）从 scripts/db 读取，按分号切分逐条执行；
 * - 失败路径：任一迁移语句失败时先 client.end() 关闭连接池，再原样上抛，
 *   不留下半打开的池子（不做语句级回滚，DDL 执行是不可逆的破坏性操作）。
 */
import { Global, Module } from '@nestjs/common';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as schema from '../../database/schema';

/** DI token：所有业务 service 通过它拿到 Drizzle 句柄。 */
export const DRIZZLE_DATABASE = Symbol('DRIZZLE_DATABASE');

/** 绑定了表 schema 的 Drizzle 数据库句柄类型。 */
export type SquabbleDatabase = PostgresJsDatabase<typeof schema>;

/** 原样再导出，方便 service 声明注入句柄的类型。 */
export type { PostgresJsDatabase };

/** 剥离 platform 时代连接串里遗留的 `?schema=` 参数。 */
function normalizeConnectionString(raw: string): string {
  // 不含 schema= 就直接返回；含则尝试 URL 解析后删除该参数。
  if (!raw.includes('schema=')) return raw;
  try {
    const url = new URL(raw);
    url.searchParams.delete('schema');
    // URL 序列化可能在结尾残留一个 '?'，一并去掉。
    return url.toString().replace(/\?$/, '');
  } catch {
    // 解析失败（非法 URL）时保守地原样返回，交给 postgres.js 自己报错。
    return raw;
  }
}

/** 打开 postgres.js 连接池、执行增量 DDL，并包装成 Drizzle 句柄。 */
export async function createDatabase(connectionString?: string): Promise<SquabbleDatabase> {
  // 第 1 步：取连接串（参数优先，缺省读 DATABASE_URL），缺失直接报错，
  // 错误信息给出可照抄的示例格式。
  const raw = connectionString ?? process.env.DATABASE_URL;
  if (!raw) {
    throw new Error(
      'DATABASE_URL is not set. Point it at your PostgreSQL, e.g. postgres://postgres:postgres@db:5432/portfolio',
    );
  }

  // 第 2 步：建立连接池（池上限默认 10，可用 DB_POOL_MAX 覆盖）。
  const client = postgres(normalizeConnectionString(raw), {
    max: Number(process.env.DB_POOL_MAX ?? 10),
  });

  // 第 3 步：按编号顺序执行增量 DDL 迁移（03→15）。每个脚本按分号切成
  // 独立语句逐条执行；任一语句失败即停止后续迁移。
  try {
    for (const name of [
      '03_agent_builder.sql',
      '04_user_api_settings.sql',
      '05_analysis_language.sql',
      '06_account_recovery.sql',
      '07_llm_budget.sql',
      '08_investment_council.sql',
      '09_builder_cadence.sql',
      '10_model_connections.sql',
      '11_research_tools.sql',
      '12_council_dialogue.sql',
      '13_budget_toggle.sql',
      '14_a2a_agents.sql',
      '15_native_agents.sql',
    ]) {
      const migrationPath = resolve(process.cwd(), 'scripts/db', name);
      const migration = readFileSync(migrationPath, 'utf8');
      for (const statement of migration
        .split(';')
        .map((item) => item.trim())
        .filter(Boolean)) {
        await client.unsafe(statement);
      }
    }
  } catch (error) {
    // 失败路径：迁移中断必须先关闭连接池再上抛，避免半初始化状态继续运行。
    await client.end();
    throw error;
  }

  // 第 4 步：迁移完成后，把 client 连同表 schema 包装成 Drizzle 句柄。
  return drizzle(client, { schema });
}

/**
 * 全局 Nest 模块：在 DRIZZLE_DATABASE token 下提供 Drizzle 句柄。
 * AppModule 引入一次即可，所有业务模块都能注入该 token。
 */
@Global()
@Module({
  providers: [{ provide: DRIZZLE_DATABASE, useFactory: createDatabase }],
  exports: [DRIZZLE_DATABASE],
})
export class DatabaseModule {}
