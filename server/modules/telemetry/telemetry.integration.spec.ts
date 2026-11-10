import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { and, eq } from 'drizzle-orm';
import { TelemetryService } from './telemetry.service';
import { telemetryFeedback, telemetrySpans } from '../../database/telemetry.schema';
import { councilSessions } from '../../database/council.schema';

const databaseUrl = process.env.TELEMETRY_TEST_DATABASE_URL ?? process.env.RESEARCH_TEST_DATABASE_URL;
const at = new Date('2026-11-11T01:00:00Z');
async function fixture(run: (context: { service: TelemetryService; db: ReturnType<typeof drizzle>; client: ReturnType<typeof postgres>; owner: string; other: string }) => Promise<void>) {
  assert.ok(databaseUrl, 'TELEMETRY_TEST_DATABASE_URL must point to a disposable database');
  const namespace = `telemetry_${randomUUID().replaceAll('-', '')}`;
  const admin = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  const client = postgres(databaseUrl, { max: 5, onnotice: () => {}, connection: { search_path: namespace } });
  try {
    await admin.unsafe(`CREATE SCHEMA ${namespace}`);
    await client.unsafe(readFileSync('scripts/db/01_schema.sql', 'utf8'));
    const db = drizzle(client);
    await run({ service: new TelemetryService(db), db, client, owner: randomUUID(), other: randomUUID() });
  } finally { await client.end(); await admin.unsafe(`DROP SCHEMA ${namespace} CASCADE`); await admin.end(); }
}
async function session(client: ReturnType<typeof postgres>, owner: string, title = 'Owned research') {
  const id = randomUUID(), cycle = randomUUID();
  await client`insert into council_sessions(id,owner,profile_version,profile_snapshot,ticker,title,status,revision,checkpoint,created_at,updated_at)
    values(${id},${owner},1,'{}','TEST',${title},'completed',1,${JSON.stringify({ cycleId: cycle })}::jsonb,${at.toISOString()},${new Date(at.getTime() + 1000).toISOString()})`;
  await client`insert into council_member_attempts(owner,session_id,cycle_id,member_id,attempt,revision,turn,resource_key,input_hash,input_snapshot,status,result_acceptance,created_at,updated_at,started_at,completed_at)
    values(${owner},${id},${cycle},'member',1,1,0,'local:fixture','hash','{}','completed','accepted',${at.toISOString()},${at.toISOString()},${at.toISOString()},${new Date(at.getTime() + 1000).toISOString()})`;
  return { id, cycle, runId: `research:${id}:1:${cycle}` };
}
function span(owner: string, id: string, status: 'completed' | 'failed' | 'cancelled', milliseconds: number) {
  return { owner, id, runId: `model:${id}`, sourceId: id, scene: 'analysis', title: id, kind: 'model' as const, name: 'model', status,
    agentId: 'model-agent', executionMode: 'api', startedAt: at, completedAt: new Date(at.getTime() + milliseconds), durationMs: milliseconds,
    inputTokens: 2, outputTokens: 3, totalTokens: 5 };
}

test('telemetry owner isolation, pagination totals, source deletion and race-safe feedback', async () => fixture(async ({ service, db, client, owner, other }) => {
  const owned = await session(client, owner), foreign = await session(client, other, 'Foreign private title');
  await db.insert(telemetrySpans).values(span(owner, 'one', 'completed', 1000));
  const workspace = await service.workspace(owner, { from: '2026-11-11', to: '2026-11-11', limit: 1, offset: 1 });
  assert.equal(workspace.total, 2); assert.equal(workspace.runs.length, 1); assert.equal(workspace.overview.totalRuns, 2);
  assert.ok(!JSON.stringify(workspace).includes('Foreign private title'));
  await assert.rejects(service.detail(owner, foreign.runId), /TELEMETRY_RUN_NOT_FOUND/);
  await assert.rejects(service.feedback(owner, foreign.runId, { rating: 'positive' }), /TELEMETRY_RUN_NOT_FOUND/);
  await Promise.all([service.feedback(owner, owned.runId, { rating: 'positive', comment: 'First' }), service.feedback(owner, owned.runId, { rating: 'negative', comment: 'Second' })]);
  assert.equal((await db.select().from(telemetryFeedback).where(and(eq(telemetryFeedback.owner, owner), eq(telemetryFeedback.runId, owned.runId)))).length, 1);
  assert.ok((await service.detail(owner, owned.runId)).feedback);
  await assert.rejects(service.feedback(owner, owned.runId, { rating: 'positive', comment: 'x'.repeat(2001) }), /TELEMETRY_FEEDBACK_INVALID/);
  await db.insert(telemetrySpans).values({ ...span(owner, 'linked', 'completed', 1000), runId: owned.runId, sessionId: owned.id, revision: 1 });
  await db.update(councilSessions).set({ deletedAt: new Date() }).where(eq(councilSessions.id, owned.id));
  await assert.rejects(service.detail(owner, owned.runId), /TELEMETRY_RUN_NOT_FOUND/);
  await assert.rejects(service.feedback(owner, owned.runId, { rating: 'positive' }), /TELEMETRY_RUN_NOT_FOUND/);
  assert.equal((await service.workspace(owner, { from: '2026-11-11', to: '2026-11-11' })).total, 1);
}));

test('completion and p95 use their actual populations; unknown quality stays unavailable', async () => fixture(async ({ service, db, owner }) => {
  await db.insert(telemetrySpans).values([span(owner, 'success', 'completed', 1000), span(owner, 'failure', 'failed', 90000), span(owner, 'cancel', 'cancelled', 200000)]);
  const workspace = await service.workspace(owner, { from: '2026-11-11', to: '2026-11-11' });
  assert.equal(workspace.overview.completionRate, .5); assert.equal(workspace.overview.p95DurationMs, 1000);
  assert.equal(workspace.agents[0].completionRate, .5); assert.equal(workspace.agents[0].p95DurationMs, 1000);
  assert.equal(workspace.overview.totalTokens, 15); assert.equal(workspace.overview.estimatedCostUsd, null);
  assert.deepEqual(workspace.quality.traceableEvidence, { numerator: 0, denominator: 0, value: null });
  assert.deepEqual(workspace.quality.adoption, { numerator: 0, denominator: 0, value: null });
  assert.equal((await service.workspace(owner, { from: '2026-11-11', to: '2026-11-11', status: 'failed' })).total, 1);
}));

test('every unique returned agent identity filters exactly its matching runs including anonymous and multiple models', async () => fixture(async ({ service, db, owner }) => {
  await db.insert(telemetrySpans).values([
    { ...span(owner, 'anonymous', 'completed', 1000), agentId: null, provider: 'provider', model: 'first' },
    { ...span(owner, 'named-one', 'completed', 1000), provider: 'provider', model: 'first' },
    { ...span(owner, 'named-two', 'completed', 1000), provider: 'provider', model: 'second' },
  ]);
  const query = { from: '2026-11-11', to: '2026-11-11' }, all = await service.workspace(owner, query);
  assert.equal(all.agents.length, 3); assert.equal(new Set(all.agents.map(agent => agent.id)).size, 3);
  for (const agent of all.agents) {
    assert.ok(agent.id.length <= 120);
    const filtered = await service.workspace(owner, { ...query, agentId: agent.id });
    assert.equal(filtered.total, 1); assert.equal(filtered.agents.length, 1); assert.equal(filtered.agents[0].id, agent.id);
  }
}));

test('old feedback outside the selected run set cannot exhaust a narrowed workspace or detail', async () => fixture(async ({ service, db, client, owner }) => {
  await db.insert(telemetrySpans).values(span(owner, 'selected', 'completed', 1000));
  await client`insert into telemetry_feedback(owner,run_id,rating) select ${owner},'old:'||g::text,'positive' from generate_series(1,20001) g`;
  const selected = await service.workspace(owner, { from: '2026-11-11', to: '2026-11-11' });
  assert.equal(selected.total, 1); assert.deepEqual(selected.quality.feedback, { positive: 0, negative: 0 });
  assert.equal((await service.detail(owner, 'model:selected')).feedback, null);
}));

test('safe workflow projection retains shared review identity and attributes its real generation to the manager', async () => fixture(async ({ service, db, client, owner }) => {
  const owned = await session(client, owner), primary = randomUUID(), mirror = randomUUID();
  await client`delete from council_member_attempts where owner=${owner} and session_id=${owned.id}`;
  await client`update council_sessions set profile_snapshot=${JSON.stringify({ council: { members: [{ id: 'manager', name: 'Manager', role: 'manager', instructions: 'private instruction' }] } })}::jsonb where id=${owned.id}`;
  for (const [index, id] of [primary, mirror].entries()) {
    const attempts = [{ id, revision: 1, kind: 'review', reviewGroupId: primary, state: 'succeeded', startedAt: at.toISOString(), finishedAt: new Date(at.getTime() + 1000).toISOString(), delivery: { conclusion: 'private delivery' } }];
    await client`insert into council_research_tasks(owner,session_id,cycle_id,revision,key,position,member_id,dependencies,state,attempts,skills,updated_at)
      values(${owner},${owned.id},${owned.cycle},1,${index ? 'business' : 'financials'},${index},'worker','[]','accepted',${JSON.stringify(attempts)}::jsonb,'[]',${at.toISOString()})`;
  }
  await db.insert(telemetrySpans).values([
    { ...span(owner, 'call', 'completed', 1000), runId: owned.runId, sessionId: owned.id, revision: 1, kind: 'task', parentId: `workflow:${primary}`, agentId: 'manager', inputTokens: null, outputTokens: null, totalTokens: null },
    { ...span(owner, 'model', 'completed', 1000), runId: owned.runId, sessionId: owned.id, revision: 1, parentId: 'call', agentId: 'manager', provider: 'provider', model: 'actual' },
  ]);
  const workspace = await service.workspace(owner, { from: '2026-11-11', to: '2026-11-11' });
  assert.equal(workspace.agents.length, 1); assert.equal(workspace.agents[0].name, 'Manager'); assert.equal(workspace.agents[0].role, 'manager');
  assert.equal(workspace.agents[0].executions, 1); assert.equal(workspace.agents[0].totalTokens, 5); assert.equal(workspace.agents[0].acceptanceKnown, 0);
  assert.equal(workspace.runs[0].usageKnown, true); assert.ok(!JSON.stringify(workspace).includes('private'));
}));

test('deleting an exact report source hides that cycle while preserving unrelated sibling cycles', async () => fixture(async ({ service, db, client, owner }) => {
  const owned = await session(client, owner), report = randomUUID(), document = randomUUID(), version = randomUUID();
  await client`insert into research_documents(id,owner,title,kind) values(${document},${owner},'Report','council')`;
  await client`insert into research_document_versions(id,owner,report_id,version,idempotency_key,content_hash,title,kind,content,sections,source,deleted_at)
    values(${version},${owner},${document},1,'key','hash','Report','council','private report','[]',${JSON.stringify({ type: 'council', id: report })}::jsonb,now())`;
  await client`insert into council_reports(id,owner,session_id,version,revision,decision,summary,dissent,next_review_condition,evidence,engine,coverage,research_version_id,publication_outcome,created_at)
    values(${report},${owner},${owned.id},1,1,'wait','private summary','[]','later','[]','local',${JSON.stringify({ cycleId: owned.cycle, complete: true })}::jsonb,${version},'succeeded',${at.toISOString()})`;
  await db.insert(telemetrySpans).values({ ...span(owner, 'linked', 'completed', 1000), runId: owned.runId, sessionId: owned.id, revision: 1 });
  await assert.rejects(service.detail(owner, owned.runId), /TELEMETRY_RUN_NOT_FOUND/);
  assert.equal((await service.workspace(owner, { from: '2026-11-11', to: '2026-11-11' })).total, 0);
}));
