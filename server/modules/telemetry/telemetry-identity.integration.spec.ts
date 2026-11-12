import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { TelemetryService } from './telemetry.service';
import { telemetrySpans } from '../../database/telemetry.schema';

const at = '2026-11-11T01:00:00.000Z';
const query = { from: '2026-11-11', to: '2026-11-11' };
async function fixture(run: (context: { client: ReturnType<typeof postgres>; db: ReturnType<typeof drizzle>; service: TelemetryService; owner: string; other: string }) => Promise<void>) {
  const url = process.env.TELEMETRY_TEST_DATABASE_URL;
  assert.ok(url, 'Disposable TELEMETRY_TEST_DATABASE_URL required');
  const namespace = `telemetry_identity_${randomUUID().replaceAll('-', '')}`;
  const admin = postgres(url, { max: 1, onnotice: () => undefined });
  const client = postgres(url, { max: 3, onnotice: () => undefined, connection: { search_path: namespace } });
  try {
    await admin`CREATE SCHEMA ${admin(namespace)}`;
    await client.unsafe(readFileSync('scripts/db/01_schema.sql', 'utf8'));
    const db = drizzle(client);
    await run({ client, db, service: new TelemetryService(db), owner: randomUUID(), other: randomUUID() });
  } finally {
    await client.end();
    await admin`DROP SCHEMA IF EXISTS ${admin(namespace)} CASCADE`;
    await admin.end();
  }
}
async function session(client: ReturnType<typeof postgres>, owner: string, members: unknown[]) {
  const id = randomUUID(), cycle = randomUUID();
  await client`insert into council_sessions(id,owner,profile_version,profile_snapshot,ticker,title,status,revision,checkpoint,created_at,updated_at)
    values(${id},${owner},1,${JSON.stringify({ council: { members } })}::jsonb,'TEST','Research','completed',1,${JSON.stringify({ cycleId: cycle })}::jsonb,${at},${at})`;
  return { id, cycle, runId: `research:${id}:1:${cycle}` };
}
async function attempt(client: ReturnType<typeof postgres>, owner: string, source: { id: string; cycle: string }, memberId: string) {
  const id = randomUUID();
  await client`insert into council_member_attempts(id,owner,session_id,cycle_id,member_id,attempt,revision,turn,resource_key,input_hash,input_snapshot,status,result_acceptance,created_at,updated_at,started_at,completed_at)
    values(${id},${owner},${source.id},${source.cycle},${memberId},1,1,0,'local:fixture','hash','{}','completed','accepted',${at},${at},${at},${at})`;
  return id;
}

test('real telemetry query groups persistent people and immutable versions across slots, without guessing legacy identities', async () => fixture(async ({ client, db, service, owner, other }) => {
  const person = randomUUID(), version = randomUUID(), nextVersion = randomUUID(), secondPerson = randomUUID();
  const inputs = [
    { slot: 'first-slot', person, version }, { slot: 'other-team-slot', person, version },
    { slot: 'first-slot', person, version: nextVersion }, { slot: 'first-slot', person: secondPerson, version: randomUUID() },
    { slot: 'legacy-slot', person: undefined, version: undefined },
  ];
  for (const [index, input] of inputs.entries()) {
    const source = await session(client, owner, [{ id: input.slot, name: 'Same display name', role: 'researcher', executionMode: 'model',
      rosterAgentId: input.person, rosterAgentVersionId: input.version, model: 'slow', instructions: 'PRIVATE INSTRUCTIONS' }]);
    const receipt = await attempt(client, owner, source, input.slot);
    await db.insert(telemetrySpans).values({ owner, id: `model:${index}`, runId: source.runId, sourceId: `source:${index}`, sessionId: source.id,
      revision: 1, parentId: `attempt:${receipt}`, kind: 'model', name: 'model', scene: 'analysis', title: 'Model call', status: 'completed',
      agentId: input.slot, provider: 'provider', model: 'observed-model', executionMode: 'api', startedAt: new Date(at), completedAt: new Date(at), totalTokens: 5 });
  }
  await session(client, other, [{ id: 'legacy-slot', rosterAgentId: person, rosterAgentVersionId: version }]);
  const all = await service.workspace(owner, query);
  const rows = all.agents as Array<typeof all.agents[number] & { rosterAgentId?: string | null; rosterAgentVersionId?: string | null }>;
  assert.equal(rows.length, 4, 'two slots of the same persistent person/version are one group; distinct people and versions stay separate');
  assert.equal(rows.find(row => row.rosterAgentId === person && row.rosterAgentVersionId === version)?.executions, 2);
  assert.equal(rows.find(row => row.rosterAgentId === person && row.rosterAgentVersionId === version)?.memberId, null,
    'an aggregate across multiple seats must not claim the first seat as its only identity');
  assert.equal(rows.find(row => row.rosterAgentId === person)?.configuredModel, 'slow');
  assert.equal(rows.find(row => row.rosterAgentId === person)?.model, 'observed-model');
  assert.equal((await service.workspace(owner, { ...query, rosterAgentId: person })).total, 3);
  assert.equal((await service.workspace(owner, { ...query, rosterAgentId: person, rosterAgentVersionId: version })).total, 2);
  assert.equal(rows.find(row => row.name === 'Same display name' && !row.rosterAgentId)?.rosterAgentId, null);
  assert.ok(!JSON.stringify(all).includes('PRIVATE'));
}));

test('exact owned commission snapshots supply team, work and attempt dimensions and never external internals', async () => fixture(async ({ client, db, service, owner, other }) => {
  const source = await session(client, owner, [{ id: 'worker', name: 'Researcher', role: 'researcher', executionMode: 'a2a' }]);
  const team = randomUUID(), teamVersion = randomUUID(), commission = randomUUID(), person = randomUUID(), version = randomUUID(), workAttempt = randomUUID();
  const members = [{ memberId: 'worker', roleId: 'analysis', teamVersionId: teamVersion, label: 'Frozen name', rosterAgentId: person,
    rosterAgentVersionId: version, agentInstructions: 'PRIVATE TEAM INSTRUCTIONS', a2aFingerprint: { privateKey: 'PRIVATE KEY' },
    executor: { executionMode: 'a2a', connectionId: 'private-connection' } }];
  const binding = randomUUID(), account = randomUUID();
  await client`insert into teams(id,owner_id,name,display_json,layout_json) values(${team},${owner},'Team','{}','{}')`;
  await client`insert into team_versions(id,team_id,owner_id,version,semantic_revision,semantic_hash,config_json,display_snapshot,created_by)
    values(${teamVersion},${team},${owner},1,1,'hash','{}','{}',${owner})`;
  await client`insert into team_account_bindings(id,owner_id,team_id,account_id,binding_revision,team_version_id,state,execution_choice)
    values(${binding},${owner},${team},${account},1,${teamVersion},'active','keep_confirmed_rules')`;
  await client`insert into team_commissions(id,owner_id,team_id,account_id,binding_id,binding_revision,team_version_id,scope_revision,preview_id,plan_json,input_snapshot,member_snapshots,root_budget_task_id,session_id,cycle_id,state,budget_limit_json,requested_by)
    values(${commission},${owner},${team},${account},${binding},1,${teamVersion},1,${randomUUID()},'{}','{}',${JSON.stringify(members)}::jsonb,'root',${source.id},${source.cycle},'completed','{}',${owner})`;
  await client`insert into council_research_tasks(owner,session_id,cycle_id,revision,key,position,member_id,dependencies,state,attempts,skills,updated_at)
    values(${owner},${source.id},${source.cycle},1,'valuation',0,'worker','[]','accepted',${JSON.stringify([{ id: workAttempt, revision: 1, kind: 'work', state: 'succeeded', startedAt: at, finishedAt: at }])}::jsonb,'[]',${at})`;
  await db.insert(telemetrySpans).values({ owner, id: 'a2a:dispatch', runId: source.runId, sourceId: workAttempt, sessionId: source.id, revision: 1,
    parentId: `workflow:${workAttempt}`, kind: 'agent', name: 'a2a-dispatch', scene: 'research', title: 'Agent execution', status: 'completed', agentId: 'worker', executionMode: 'a2a',
    startedAt: new Date(at), completedAt: new Date(at) });
  const selected = await service.workspace(owner, { ...query, teamId: team, teamVersionId: teamVersion, commissionId: commission, workKey: 'valuation', attemptId: workAttempt });
  assert.equal(selected.total, 1);
  assert.equal(selected.agents[0]?.rosterAgentId, person);
  assert.equal(selected.agents[0]?.rosterAgentVersionId, version);
  assert.equal(selected.agents[0]?.model, null, 'a remote dispatch does not prove its internal model');
  assert.equal(selected.overview.estimatedCostUsd, null);
  for (const key of ['teamId', 'teamVersionId', 'commissionId', 'workKey', 'attemptId']) {
    assert.equal((await service.workspace(owner, { ...query, [key]: 'unrelated' })).total, 0, `${key} is an actual query dimension`);
  }
  const detail = await service.detail(owner, source.runId);
  assert.equal(detail.spans.find(span => span.id === `workflow:${workAttempt}`)?.workKey, 'valuation');
  assert.equal(detail.spans.find(span => span.id === 'a2a:dispatch')?.attemptId, workAttempt);
  assert.ok(!JSON.stringify(detail).includes('PRIVATE'));
  await assert.rejects(service.detail(other, source.runId), /TELEMETRY_RUN_NOT_FOUND/);
  await client`update council_sessions set deleted_at=now() where owner=${owner} and id=${source.id}`;
  assert.equal((await service.workspace(owner, { ...query, teamId: team })).total, 0);
}));

test('native detail resolves only its exact owned saved session and receipt, including seat references absent at capture', async () => fixture(async ({ client, db, service, owner }) => {
  const person = randomUUID(), version = randomUUID(), nativeTask = randomUUID();
  const source = await session(client, owner, [{ id: 'seat', name: 'Frozen local person', role: 'researcher', executionMode: 'local',
    rosterAgentId: person, rosterAgentVersionId: version }]);
  const receipt = await attempt(client, owner, source, 'seat');
  await client`update council_member_attempts set task_id=${nativeTask} where id=${receipt}`;
  await db.insert(telemetrySpans).values({ owner, id: `native:${nativeTask}`, runId: `native:${nativeTask}`, sourceId: nativeTask,
    sessionId: source.id, revision: 1, kind: 'agent', name: 'native-execution', scene: 'research', title: 'Agent execution', status: 'completed',
    agentId: 'local-connector', executionMode: 'native', startedAt: new Date(at), completedAt: new Date(at) });
  const detail = await service.detail(owner, `native:${nativeTask}`);
  assert.equal(detail.spans[0].rosterAgentId, person);
  assert.equal(detail.spans[0].rosterAgentVersionId, version);
  assert.equal(detail.spans[0].memberId, 'seat');
  assert.equal(detail.spans[0].attemptId, receipt);
  const ambiguous = await attempt(client, owner, source, 'another-seat');
  await client`update council_member_attempts set task_id=${nativeTask} where id=${ambiguous}`;
  const unresolved = await service.detail(owner, `native:${nativeTask}`);
  assert.equal(unresolved.spans[0].attemptId, null, 'a reused task ID cannot pick an arbitrary receipt');
  assert.equal(unresolved.spans[0].rosterAgentId, null);
}));

test('one shared manager review remains filterable for every reviewed work item without duplicate usage', async () => fixture(async ({ client, db, service, owner }) => {
  const source = await session(client, owner, [{ id: 'manager', name: 'Manager', role: 'manager' }]);
  const primary = randomUUID(), mirror = randomUUID();
  for (const [index, id] of [primary, mirror].entries()) {
    const attempts = [{ id, revision: 1, kind: 'review', reviewGroupId: primary, state: 'succeeded', startedAt: at, finishedAt: at }];
    await client`insert into council_research_tasks(owner,session_id,cycle_id,revision,key,position,member_id,dependencies,state,attempts,skills,updated_at)
      values(${owner},${source.id},${source.cycle},1,${index ? 'business' : 'valuation'},${index},'worker','[]','accepted',${JSON.stringify(attempts)}::jsonb,'[]',${at})`;
  }
  await db.insert(telemetrySpans).values({ owner, id: 'review-model', runId: source.runId, sourceId: primary, sessionId: source.id, revision: 1,
    parentId: `workflow:${primary}`, kind: 'model', name: 'model', scene: 'research', title: 'Review', status: 'completed', agentId: 'manager',
    executionMode: 'api', startedAt: new Date(at), completedAt: new Date(at), totalTokens: 5 });
  for (const workKey of ['valuation', 'business']) {
    const selected = await service.workspace(owner, { ...query, workKey });
    assert.equal(selected.total, 1, `shared review covers ${workKey}`);
    assert.equal(selected.agents[0].executions, 1);
    assert.equal(selected.agents[0].totalTokens, 5);
  }
}));
