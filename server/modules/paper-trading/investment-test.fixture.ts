import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import type { PostgresJsDatabase } from '../../common/platform';
import { drizzle } from 'drizzle-orm/postgres-js';

export async function investmentFixture(run: (db: PostgresJsDatabase, client: ReturnType<typeof postgres>, owner: string) => Promise<void>) {
  const url = process.env.STRATEGY_TEST_DATABASE_URL;
  if (!url) throw new Error('Disposable STRATEGY_TEST_DATABASE_URL is required');
  const namespace = 'investment_test_' + randomUUID().replaceAll('-', '');
  const admin = postgres(url, { max: 1, onnotice: () => undefined });
  const client = postgres(url, { max: 8, onnotice: () => undefined, connection: { search_path: namespace } });
  await admin.unsafe('CREATE SCHEMA ' + namespace);
  try {
    await client.unsafe(readFileSync('scripts/db/01_schema.sql', 'utf8'));
    await client.unsafe(readFileSync('scripts/db/31_simple_experience.sql', 'utf8'));
    await client.unsafe(readFileSync('scripts/db/37_asset_ledger_integrity.sql', 'utf8'));
    await client.unsafe(readFileSync('scripts/db/32_autonomous_investment.sql', 'utf8'));
    await client.unsafe(readFileSync('scripts/db/32_autonomous_investment.sql', 'utf8'));
    await client.unsafe(readFileSync('scripts/db/42_user_strategy_runtime.sql', 'utf8'));
    await client.unsafe(readFileSync('scripts/db/45_portfolio_workspace.sql', 'utf8'));
    const owner = randomUUID();
    await client`INSERT INTO users(id,username,password_hash) VALUES(${owner},${'invest-'+owner.slice(0,20)},'fixture-only')`;
    await run(drizzle(client), client, owner);
  } finally { await client.end(); await admin.unsafe('DROP SCHEMA ' + namespace + ' CASCADE'); await admin.end(); }
}

/** Historical running-policy setup for legacy race/security/cycle tests only.
 * Product start deliberately creates a paused ledger; migrations pause this historical state. */
export async function startPreUserStrategyInvestmentFixture(service: import('./investment-policy.service').InvestmentPolicyService,
  db: PostgresJsDatabase, owner: string, request: unknown) {
  const result = await service.start(owner, request);
  return { ...result, policy: await restorePreUserStrategyRunningPolicyFixture(service, db, owner) };
}
export async function restorePreUserStrategyRunningPolicyFixture(service: import('./investment-policy.service').InvestmentPolicyService,
  db: PostgresJsDatabase, owner: string, bumpRevision = false) {
  const { and, eq } = await import('drizzle-orm');
  const { investmentPolicies, investmentCycles } = await import('../../database/investment-policy.schema');
  const { paperAccounts } = await import('../../database/schema');
  const { lockMemoryOwner } = await import('../research-memory/research-memory.fence');
  const { cancelInvestmentCandidates } = await import('./investment-policy.service');
  return db.transaction(async tx => {
    await lockMemoryOwner(tx, owner);
    const [policy] = await tx.select().from(investmentPolicies).where(eq(investmentPolicies.owner, owner)).for('update');
    if (policy.baseConfig.userStrategy) throw new Error('This fixture must never weaken confirmed user strategy authorization');
    if (bumpRevision) await cancelInvestmentCandidates(tx, owner, policy.accountId, 'Historical resume fixture');
    const [running] = await tx.update(investmentPolicies).set({ status: 'running', revision: policy.revision + Number(bumpRevision) }).where(eq(investmentPolicies.id, policy.id)).returning();
    await tx.update(paperAccounts).set({ botEnabled: true }).where(and(eq(paperAccounts.owner, owner), eq(paperAccounts.id, policy.accountId)));
    await service.enqueue(tx, running, bumpRevision ? 'resume' : 'start');
    return { ...running, confirmedAt: running.confirmedAt.toISOString(), updatedAt: running.updatedAt.toISOString() };
  });
}
