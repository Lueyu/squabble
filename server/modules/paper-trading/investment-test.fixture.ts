import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';

export async function investmentFixture(run: (db: ReturnType<typeof drizzle>, client: ReturnType<typeof postgres>, owner: string) => Promise<void>) {
  const url = process.env.STRATEGY_TEST_DATABASE_URL;
  if (!url) throw new Error('Disposable STRATEGY_TEST_DATABASE_URL is required');
  const namespace = 'investment_test_' + randomUUID().replaceAll('-', '');
  const admin = postgres(url, { max: 1, onnotice: () => undefined });
  const client = postgres(url, { max: 8, onnotice: () => undefined, connection: { search_path: namespace } });
  await admin.unsafe('CREATE SCHEMA ' + namespace);
  try {
    await client.unsafe(readFileSync('scripts/db/01_schema.sql', 'utf8'));
    await client.unsafe(readFileSync('scripts/db/31_simple_experience.sql', 'utf8'));
    await client.unsafe(readFileSync('scripts/db/32_autonomous_investment.sql', 'utf8'));
    await client.unsafe(readFileSync('scripts/db/32_autonomous_investment.sql', 'utf8'));
    const owner = randomUUID();
    await client`INSERT INTO users(id,username,password_hash) VALUES(${owner},${'invest-'+owner.slice(0,20)},'fixture-only')`;
    await run(drizzle(client), client, owner);
  } finally { await client.end(); await admin.unsafe('DROP SCHEMA ' + namespace + ' CASCADE'); await admin.end(); }
}
