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
        .replace('  "metadata" jsonb,', '')
        .replace(/CREATE TABLE IF NOT EXISTS research_archive_jobs[\s\S]*$/u, '')
        .replace(/  publication_outcome[^\n]+\n/u, '')
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
    const [run] = await client`INSERT INTO agent_runs (owner, ticker, trigger_type) VALUES ('migration-owner', 'AAPL', 'manual') RETURNING id`;
    const [oldEvidence] = await client`INSERT INTO agent_evidence (owner, run_id, role, evidence_type, title, content, fetched_at)
      VALUES ('migration-owner', ${run.id}, 'fundamental', 'financial', 'Legacy source', 'Existing body', '2026-05-01') RETURNING id`;
    assert.equal((await client`SELECT to_regclass('research_archive_jobs')::text AS name`)[0].name, null);
    // Use the production startup loader, including its statement splitting.
    await startDatabase(namespace);
    await startDatabase(namespace);
    const [temporal] = await client`SELECT to_regclass('research_memory_evidence')::text AS name`;
    assert.equal(temporal.name, 'research_memory_evidence');
    const [after] = await client`SELECT summary, thesis_candidates, publication_outcome FROM council_reports WHERE id = ${report.id}`;
    assert.deepEqual(after, { summary: 'Legacy report summary', thesis_candidates: null, publication_outcome: null });
    const [legacy] = await client`SELECT content, status, version FROM research_theses WHERE id = ${thesis.id}`;
    assert.deepEqual(legacy, { content: { claim: 'Legacy opinion' }, status: 'candidate', version: 1 });
    assert.deepEqual((await client`SELECT content, metadata FROM agent_evidence WHERE id = ${oldEvidence.id}`)[0],
      { content: 'Existing body', metadata: null });
    await client`UPDATE research_theses SET status = 'accepted' WHERE id = ${thesis.id}`;
    const [version] = await client`INSERT INTO research_thesis_versions (owner, thesis_id, version, content, status, action, excluded, change_reason)
      VALUES ('migration-owner', ${thesis.id}, 1, '{"claim":"Explicit agent claim"}', 'accepted', 'accept', false, 'Reviewed source') RETURNING id`;
    const [evidence] = await client`INSERT INTO research_memory_evidence
      (owner, memory_id, report_id, report_version, report_revision, evidence_id, metadata)
      VALUES ('migration-owner', ${memory.id}, ${report.id}, 1, 1, 'filing', '{"sources":[]}') RETURNING id, ingested_at`;
    await client`INSERT INTO research_thesis_evidence(owner, version_id, evidence_record_id, role)
      VALUES ('migration-owner', ${version.id}, ${evidence.id}, 'qualify')`;
    const [job] = await client`INSERT INTO research_archive_jobs(owner, report_id, session_id, report_version, ticker, topic, intent, state, attempts, error)
      VALUES ('migration-owner', ${report.id}, ${session.id}, 1, 'AAPL', 'general', 'manual', 'failed', 3, 'MEMORY_ARCHIVE_FAILED') RETURNING id`;
    const [event] = await client`INSERT INTO research_monitor_events(owner, rule_id, rule_version, thesis_id, thesis_version, observation_key, observation, state)
      VALUES ('migration-owner', ${randomUUID()}, 1, ${thesis.id}, 1, 'provider-observation', '{"state":"breached"}', 'breached') RETURNING id`;
    await startDatabase(namespace);
    assert.equal((await client`SELECT state FROM research_monitor_events WHERE id = ${event.id}`)[0].state, 'breached');
    assert.deepEqual((await client`SELECT state, attempts, error FROM research_archive_jobs WHERE id = ${job.id}`)[0],
      { state: 'failed', attempts: 3, error: 'MEMORY_ARCHIVE_FAILED' });
    assert.deepEqual((await client`SELECT id, ingested_at FROM research_memory_evidence`)[0], evidence);
    assert.equal((await client`SELECT change_reason FROM research_thesis_versions WHERE id = ${version.id}`)[0].change_reason, 'Reviewed source');
    assert.equal((await client`SELECT role FROM research_thesis_evidence`)[0].role, 'qualify');
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
    const [temporal] = await client`SELECT to_regclass('research_thesis_evidence')::text AS name`;
    assert.equal(temporal.name, 'research_thesis_evidence');
    assert.equal((await client`SELECT thesis_candidates, publication_outcome FROM council_reports`).length, 0);
    assert.equal((await client`SELECT * FROM research_archive_jobs`).length, 0);
    assert.equal((await client`SELECT * FROM research_monitor_rules`).length, 0);
    assert.equal((await client`SELECT * FROM research_thesis_replacements`).length, 0);
    assert.equal((await client`SELECT memory_inventory FROM strategy_plans`).length, 0);
    await startDatabase(namespace);
    const [constraint] = await client`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
      WHERE conrelid = 'research_theses'::regclass AND conname = 'research_theses_status_check'`;
    assert.match(constraint.definition, /accepted/);
  } finally { await client.end(); await admin`DROP SCHEMA ${admin(namespace)} CASCADE`; await admin.end(); }
});
