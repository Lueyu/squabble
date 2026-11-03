import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import postgres from 'postgres';
import { createDatabase } from '../../common/platform/database.provider';

async function startDatabase(namespace: string): Promise<void> {
  const url = new URL(process.env.MEMORY_TEST_DATABASE_URL!);
  url.searchParams.set('search_path', namespace);
  url.searchParams.set('client_min_messages', 'error');
  const db = await createDatabase(url.toString());
  await (db as typeof db & { $client: postgres.Sql }).$client.end();
}

test('atomic thesis migration upgrades populated legacy tables and reapplies without rewriting old opinions', {
  skip: !process.env.MEMORY_TEST_DATABASE_URL,
}, async () => {
  const namespace = `atomic_migration_${randomUUID().replaceAll('-', '')}`;
  const admin = postgres(process.env.MEMORY_TEST_DATABASE_URL!, { max: 1, onnotice: () => {} });
  const client = postgres(process.env.MEMORY_TEST_DATABASE_URL!, { max: 1, onnotice: () => {}, connection: { search_path: namespace } });
  await admin`CREATE SCHEMA ${admin(namespace)}`;
  try {
    for (const file of ['01_schema.sql', '03_agent_builder.sql', '07_llm_budget.sql', '08_investment_council.sql',
      '12_council_dialogue.sql', '14_a2a_agents.sql', '17_research_memory.sql', '18_research_workflow.sql']) {
      const legacy = readFileSync(`scripts/db/${file}`, 'utf8').replace('  thesis_candidates JSONB,', '')
        .replaceAll("'candidate','accepted','confirmed'", "'candidate','confirmed'")
        .replaceAll("'candidate','accept','confirm'", "'candidate','confirm'");
      await client.unsafe(legacy);
    }
    const [session] = await client`INSERT INTO council_sessions (owner, profile_version, profile_snapshot, ticker)
      VALUES ('migration-owner', 1, '{}', 'AAPL') RETURNING id`;
    const [report] = await client`INSERT INTO council_reports
      (owner, session_id, version, revision, decision, summary, dissent, next_review_condition, evidence, engine)
      VALUES ('migration-owner', ${session.id}, 1, 1, 'wait', 'Legacy report summary', '[]', '', '[]', 'llm') RETURNING id`;
    const [memory] = await client`INSERT INTO research_memories
      (owner, ticker, market, topic, language, session_id, report_id, report_version, report_revision, report_created_at, summary, decision)
      VALUES ('migration-owner', 'AAPL', 'US', 'general', 'en', ${session.id}, ${report.id}, 1, 1, now(), 'Legacy report summary', 'wait') RETURNING id`;
    const [thesis] = await client`INSERT INTO research_theses (owner, memory_id, content)
      VALUES ('migration-owner', ${memory.id}, '{"claim":"Legacy opinion"}') RETURNING id`;
    // Use the production startup loader, including its statement splitting.
    await startDatabase(namespace);
    await startDatabase(namespace);
    const [after] = await client`SELECT summary, thesis_candidates FROM council_reports WHERE id = ${report.id}`;
    assert.deepEqual(after, { summary: 'Legacy report summary', thesis_candidates: null });
    const [legacy] = await client`SELECT content, status, version FROM research_theses WHERE id = ${thesis.id}`;
    assert.deepEqual(legacy, { content: { claim: 'Legacy opinion' }, status: 'candidate', version: 1 });
    await client`UPDATE research_theses SET status = 'accepted' WHERE id = ${thesis.id}`;
    await client`INSERT INTO research_thesis_versions (owner, thesis_id, version, content, status, action, excluded)
      VALUES ('migration-owner', ${thesis.id}, 1, '{"claim":"Explicit agent claim"}', 'accepted', 'accept', false)`;
  } finally { await client.end(); await admin`DROP SCHEMA ${admin(namespace)} CASCADE`; await admin.end(); }
});

test('production startup loader applies atomic thesis schema on a fresh base installation', {
  skip: !process.env.MEMORY_TEST_DATABASE_URL,
}, async () => {
  const namespace = `atomic_startup_${randomUUID().replaceAll('-', '')}`;
  const admin = postgres(process.env.MEMORY_TEST_DATABASE_URL!, { max: 1, onnotice: () => {} });
  const client = postgres(process.env.MEMORY_TEST_DATABASE_URL!, { max: 1, onnotice: () => {}, connection: { search_path: namespace } });
  await admin`CREATE SCHEMA ${admin(namespace)}`;
  try {
    await client.unsafe(readFileSync('scripts/db/01_schema.sql', 'utf8'));
    await startDatabase(namespace);
    assert.equal((await client`SELECT thesis_candidates FROM council_reports`).length, 0);
    const [constraint] = await client`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
      WHERE conrelid = 'research_theses'::regclass AND conname = 'research_theses_status_check'`;
    assert.match(constraint.definition, /accepted/);
  } finally { await client.end(); await admin`DROP SCHEMA ${admin(namespace)} CASCADE`; await admin.end(); }
});
