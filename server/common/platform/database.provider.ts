/**
 * First-party database provider: direct postgres.js + Drizzle connection.
 *
 * Replaces the platform datapaas layer. Services keep injecting the same
 * `DRIZZLE_DATABASE` token; the connection now goes straight to PostgreSQL
 * with per-row ownership enforced by the `owner` text column (see
 * server/database/schema.ts) instead of composite types and role switching.
 *
 * `DATABASE_URL` accepts both plain connection strings and legacy strings
 * carrying a `?schema=...` parameter (the parameter is ignored).
 */
import { Global, Module } from '@nestjs/common';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as schema from '../../database/schema';

/** DI token used by every business service to receive the Drizzle handle. */
export const DRIZZLE_DATABASE = Symbol('DRIZZLE_DATABASE');

/** Drizzle database handle bound to the table schema. */
export type SquabbleDatabase = PostgresJsDatabase<typeof schema>;

/** Re-exported so services can type their injected handle. */
export type { PostgresJsDatabase };

/** Strip legacy `?schema=` parameters from platform-era connection strings. */
function normalizeConnectionString(raw: string): string {
  if (!raw.includes('schema=')) return raw;
  try {
    const url = new URL(raw);
    url.searchParams.delete('schema');
    return url.toString().replace(/\?$/, '');
  } catch {
    return raw;
  }
}

/** Open the postgres.js pool, apply additive DDL, and wrap it in Drizzle. */
export async function createDatabase(connectionString?: string): Promise<SquabbleDatabase> {
  const raw = connectionString ?? process.env.DATABASE_URL;
  if (!raw) {
    throw new Error(
      'DATABASE_URL is not set. Point it at your PostgreSQL, e.g. postgres://postgres:postgres@db:5432/portfolio',
    );
  }
  const client = postgres(normalizeConnectionString(raw), {
    max: Number(process.env.DB_POOL_MAX ?? 10),
  });
  try {
    for (const name of ['03_agent_builder.sql', '04_user_api_settings.sql', '05_analysis_language.sql', '06_account_recovery.sql', '07_llm_budget.sql', '08_investment_council.sql', '09_builder_cadence.sql', '10_model_connections.sql', '11_research_tools.sql', '12_council_dialogue.sql', '13_budget_toggle.sql', '14_a2a_agents.sql', '15_native_agents.sql', '16_daily_strategy.sql', '17_research_memory.sql', '18_research_workflow.sql', '19_atomic_research_theses.sql', '20_research_memory_temporal.sql', '21_research_archive_jobs.sql', '22_research_monitors.sql', '23_monitor_observation_order.sql', '24_local_model_route.sql', '25_portfolio_report.sql', '26_research_documents.sql', '27_research_threads.sql', '28_simulation_experiments.sql', '29_strategy_mandates.sql', '30_strategy_daily_adjustments.sql', '31_simple_experience.sql', '32_autonomous_investment.sql', '33_simple_council.sql', '34_research_execution_recovery.sql', '35_import_batches.sql', '36_import_analysis_handoff.sql', '37_asset_ledger_integrity.sql', '39_user_investment_strategies.sql', '40_transaction_imports.sql', '41_portfolio_value_points.sql', '42_user_strategy_runtime.sql', '43_channel_workbench.sql', '44_strategy_draft_deletion.sql']) {
      const migrationPath = resolve(process.cwd(), 'scripts/db', name);
      const migration = readFileSync(migrationPath, 'utf8');
      await client.unsafe(migration);
    }
  } catch (error) {
    await client.end();
    throw error;
  }
  return drizzle(client, { schema });
}

/**
 * Global Nest module providing the Drizzle handle under DRIZZLE_DATABASE.
 * Import once from AppModule; every feature module injects the token.
 */
@Global()
@Module({
  providers: [{ provide: DRIZZLE_DATABASE, useFactory: createDatabase }],
  exports: [DRIZZLE_DATABASE],
})
export class DatabaseModule {}
