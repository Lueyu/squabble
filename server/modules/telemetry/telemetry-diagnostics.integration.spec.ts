import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { TelemetryService } from './telemetry.service';
import { TelemetryDiagnosticsService } from './telemetry-diagnostics.service';
import { LocalAgentError } from '../local-agents/local-agents.types';
import type { ResearchEvent } from '../../../shared/research-events.interface';

const databaseUrl = process.env.TELEMETRY_TEST_DATABASE_URL;
const at = '2026-11-11T01:00:00.000Z';
async function fixture(run: (context: { client: ReturnType<typeof postgres>; owner: string; other: string; service: any; journals: Map<string, any>; reads: string[] }) => Promise<void>) {
  assert.ok(databaseUrl, 'TELEMETRY_TEST_DATABASE_URL must point to a disposable database');
  const namespace = `diagnostics_${randomUUID().replaceAll('-', '')}`;
  const admin = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  const client = postgres(databaseUrl, { max: 5, onnotice: () => {}, connection: { search_path: namespace } });
  try {
    await admin.unsafe(`CREATE SCHEMA ${namespace}`);
    await client.unsafe(readFileSync('scripts/db/01_schema.sql', 'utf8'));
    const db = drizzle(client), journals = new Map<string, any>(), reads: string[] = [];
    const local = { getTaskDiagnostics: async (owner: string, id: string) => {
      reads.push(id); const task = journals.get(id);
      if (!task || task.owner !== owner) throw new LocalAgentError('LOCAL_TASK_NOT_FOUND');
      return structuredClone(task);
    } };
    const service = new TelemetryDiagnosticsService(db, new TelemetryService(db), { get: () => local } as any);
    await run({ client, owner: randomUUID(), other: randomUUID(), service, journals, reads });
  } finally { await client.end(); await admin.unsafe(`DROP SCHEMA ${namespace} CASCADE`); await admin.end(); }
}
async function session(client: ReturnType<typeof postgres>, owner: string) {
  const id = randomUUID(), cycle = randomUUID();
  await client`insert into council_sessions(id,owner,profile_version,profile_snapshot,ticker,title,status,revision,checkpoint,created_at,updated_at)
    values(${id},${owner},1,${JSON.stringify({ council: { members: [{ id: 'member', name: 'Fixture member', role: 'researcher' }] } })}::jsonb,'TEST','Fictional research','completed',1,${JSON.stringify({ cycleId: cycle })}::jsonb,${at},${at})`;
  return { id, cycle, runId: `research:${id}:1:${cycle}` };
}
async function attempt(client: ReturnType<typeof postgres>, owner: string, source: Awaited<ReturnType<typeof session>>, taskId: string, options: { cycle?: string; revision?: number; number?: number; acceptance?: string; failure?: unknown } = {}) {
  const id = randomUUID();
  await client`insert into council_member_attempts(id,owner,session_id,cycle_id,member_id,attempt,revision,turn,resource_key,input_hash,input_snapshot,status,result_acceptance,task_id,failure,created_at,updated_at,started_at,completed_at)
    values(${id},${owner},${source.id},${options.cycle ?? source.cycle},'member',${options.number ?? 1},${options.revision ?? 1},0,'local:fixture','hash','{}','completed',${options.acceptance ?? 'accepted'},${taskId},${options.failure ? JSON.stringify(options.failure) : null}::jsonb,${at},${at},${at},${at})`;
  return id;
}
function journal(owner: string, source: Awaited<ReturnType<typeof session>>, taskId: string, changes: Record<string, unknown> = {}) {
  return { owner, taskId, agentId: 'native:codex', provider: 'codex', executionMode: 'native', state: 'completed',
    createdAt: at, updatedAt: at, commandEmitted: true, runtimeEntered: true, configuredModel: 'configured-only', observedModel: null,
    activityContext: { sessionId: source.id, revision: 1, cycleId: source.cycle, memberId: 'member', memberName: 'Fixture member', attempt: 1, turn: 0, language: 'en' },
    diagnostics: [{ id: 'process:exit', stage: 'process', status: 'succeeded', at, exitCode: 0, outputBytes: 90 }],
    events: [], diagnosticsTruncated: false, eventsTruncated: false, ...changes };
}
function event(source: Awaited<ReturnType<typeof session>>, taskId: string, changes: Partial<ResearchEvent> = {}): ResearchEvent {
  return { id: 'tool:1', taskId, sequence: 2, sessionId: source.id, revision: 1, cycleId: source.cycle,
    memberId: 'member', memberName: 'Fixture member', attempt: 1, turn: 0, kind: 'tool', status: 'succeeded', at,
    summary: 'Read public fixture data', toolName: 'read_data', callId: 'call:1', ...changes };
}

test('diagnostic reads validate owner and source before touching the local journal and on every poll', async () => fixture(async ({ client, owner, other, service, journals, reads }) => {
  const source = await session(client, owner), foreign = await session(client, other), taskId = randomUUID();
  await attempt(client, owner, source, taskId); await attempt(client, other, foreign, randomUUID());
  journals.set(taskId, journal(owner, source, taskId));
  await assert.rejects(service.read(owner, foreign.runId), /TELEMETRY_RUN_NOT_FOUND/);
  assert.deepEqual(reads, []);
  const first = await service.read(owner, source.runId), second = await service.read(owner, source.runId);
  assert.equal(first.cursor, second.cursor); assert.equal(first.tasks[0].taskId, taskId);
  await client`update council_sessions set deleted_at=now() where id=${source.id}`;
  await assert.rejects(service.read(owner, source.runId), /TELEMETRY_RUN_NOT_FOUND/);
  assert.equal(reads.length, 2);
}));

test('diagnostics join exact cycle revision attempt and task identities and retain only public fields', async () => fixture(async ({ client, owner, service, journals }) => {
  const source = await session(client, owner), taskId = randomUUID(), wrongCycle = randomUUID(), wrongRevision = randomUUID(), wrongAttempt = randomUUID();
  await attempt(client, owner, source, taskId);
  await attempt(client, owner, source, wrongCycle, { cycle: randomUUID() });
  await attempt(client, owner, source, wrongRevision, { revision: 2, number: 3 });
  await attempt(client, owner, source, wrongAttempt, { number: 2 });
  journals.set(taskId, journal(owner, source, taskId, { events: [event(source, taskId), event(source, taskId, { id: 'foreign-cycle', cycleId: randomUUID(), summary: 'private unrelated' })],
    prompt: 'private prompt', text: 'private result', agentSettings: { apiKey: 'private credential' }, diagnosticsTruncated: true }));
  journals.set(wrongAttempt, journal(owner, source, wrongAttempt));
  const result = await service.read(owner, source.runId);
  assert.deepEqual(result.tasks.filter((task: any) => task.retained).map((task: any) => task.taskId), [taskId]);
  assert.equal(result.tasks[0].events.filter((row: any) => row.kind === 'tool').length, 1);
  assert.equal(result.tasks[0].eventsTruncated, true); assert.equal(result.coverage, 'partial');
  assert.equal(result.tasks[0].configuredModel, 'configured-only'); assert.equal(result.tasks[0].observedModel, null);
  assert.ok(!JSON.stringify(result).includes('private'));
}));

test('completed CLI output stays separate from rejected app acceptance and missing retention preserves safe parse failures', async () => fixture(async ({ client, owner, service, journals }) => {
  const source = await session(client, owner), taskId = randomUUID(), expired = randomUUID();
  const failure = { code: 'LOCAL_INVALID_RESULT', stage: 'parse', fieldPath: 'response.evidence', expectedType: 'array', actualType: 'string',
    exitCode: 0, outputBytes: 42, stderrBytes: 12, terminalEvent: true, recoveries: ['reparse_existing'], stderr: 'private stderr' };
  await attempt(client, owner, source, taskId, { acceptance: 'rejected', failure });
  await attempt(client, owner, source, expired, { number: 2, acceptance: 'rejected', failure });
  journals.set(taskId, journal(owner, source, taskId));
  const result = await service.read(owner, source.runId);
  assert.equal(result.tasks[0].state, 'completed'); assert.equal(result.tasks[0].acceptance, 'rejected');
  assert.equal(result.publication, 'unknown'); assert.equal(result.tasks[0].processState, 'exited');
  const missing = result.tasks.find((task: any) => task.taskId === expired);
  assert.equal(missing.retained, false); assert.equal(missing.provider, null); assert.equal(missing.processState, 'unknown');
  assert.equal(missing.failure.fieldPath, 'response.evidence'); assert.deepEqual(missing.failure.recoveries, ['reparse_existing']);
  assert.equal(missing.failure.stderrBytes, 12);
  assert.equal(missing.heartbeatAt, null); assert.ok(!JSON.stringify(result).includes('private stderr'));
}));

test('reconnecting reads return updated full snapshots without duplicated public events', async () => fixture(async ({ client, owner, service, journals }) => {
  const source = await session(client, owner), taskId = randomUUID(); await attempt(client, owner, source, taskId);
  journals.set(taskId, journal(owner, source, taskId, { state: 'running', diagnostics: [], events: [event(source, taskId, { status: 'running' })] }));
  const before = await service.read(owner, source.runId);
  journals.set(taskId, journal(owner, source, taskId, { events: [event(source, taskId), event(source, taskId)] }));
  const after = await service.read(owner, source.runId);
  assert.notEqual(before.cursor, after.cursor);
  assert.equal(after.tasks[0].events.filter((row: any) => row.kind === 'tool').length, 1);
  assert.equal(after.tasks[0].heartbeatAt, null);
}));

test('a uniquely associated legacy task remains readable when its optional retry coordinate was not recorded', async () => fixture(async ({ client, owner, service, journals }) => {
  const source = await session(client, owner), taskId = randomUUID(); await attempt(client, owner, source, taskId, { number: 2 });
  const task = journal(owner, source, taskId); delete task.activityContext.attempt;
  journals.set(taskId, task);
  const result = await service.read(owner, source.runId);
  assert.equal(result.tasks[0].retained, true); assert.equal(result.coverage, 'available');
}));

test('a remote task reused by different attempt receipts is ambiguous even with matching journal coordinates', async () => fixture(async ({ client, owner, service, journals }) => {
  const source = await session(client, owner), taskId = randomUUID();
  await attempt(client, owner, source, taskId); await attempt(client, owner, source, taskId, { number: 2 });
  journals.set(taskId, journal(owner, source, taskId));
  const result = await service.read(owner, source.runId);
  assert.equal(result.coverage, 'unavailable'); assert.ok(result.tasks.every((task: any) => !task.retained));
  assert.equal(new Set(result.tasks.map((task: any) => task.taskId)).size, 2);
}));

test('native marker order preserves causality at equal timestamps and known adapter support is separate from observed events', async () => fixture(async ({ client, owner, service, journals }) => {
  const source = await session(client, owner), taskId = randomUUID(); await attempt(client, owner, source, taskId);
  journals.set(taskId, journal(owner, source, taskId, { activityCapability: 'tools', diagnostics: [
    { id: 'z-start', stage: 'process', status: 'running', at },
    { id: 'a-exit', stage: 'process', status: 'succeeded', at, exitCode: 0 },
  ] }));
  const result = await service.read(owner, source.runId);
  assert.deepEqual(result.tasks[0].events.filter((event: any) => event.id.startsWith('native:')).map((event: any) => event.status), ['running', 'succeeded']);
  assert.equal(result.tasks[0].activityCapability, 'tools'); assert.equal(result.tasks[0].modelRequestsVisible, false);
}));

test('shared manager review and rebased work join their exact original revisions and only the primary review', async () => fixture(async ({ client, owner, service, journals }) => {
  const source = await session(client, owner), work = randomUUID(), review = randomUUID(), mirror = randomUUID(), taskId = randomUUID(), reviewTaskId = randomUUID();
  await client`update council_sessions set revision=2,profile_snapshot=${JSON.stringify({ council: { members: [{ id: 'member', name: 'Worker', role: 'researcher' }, { id: 'manager', name: 'Manager', role: 'manager' }] } })}::jsonb where id=${source.id}`;
  for (const [position, id] of [mirror, review].entries()) {
    const entries = [...(position ? [{ id: work, revision: 1, kind: 'work', state: 'succeeded', startedAt: at, finishedAt: at, remoteTaskId: taskId, externalAgent: true }] : []),
      { id, revision: 2, kind: 'review', reviewGroupId: review, state: 'succeeded', startedAt: at, finishedAt: at, remoteTaskId: reviewTaskId, externalAgent: true }];
    await client`insert into council_research_tasks(owner,session_id,cycle_id,revision,key,position,member_id,dependencies,state,attempts,skills,updated_at)
      values(${owner},${source.id},${source.cycle},2,${position ? 'business' : 'financials'},${position},'member','[]','accepted',${JSON.stringify(entries)}::jsonb,'[]',${at})`;
  }
  const workTask = journal(owner, source, taskId); workTask.activityContext.turn = 1;
  journals.set(taskId, workTask);
  const managerTask = journal(owner, source, reviewTaskId); managerTask.activityContext = { ...managerTask.activityContext, revision: 2, memberId: 'manager', attempt: 2, turn: 1 };
  journals.set(reviewTaskId, managerTask);
  const original = await service.read(owner, source.runId);
  assert.deepEqual(original.tasks.map((task: any) => task.taskId), [taskId]); assert.equal(original.tasks[0].retained, true);
  const latest = await service.read(owner, `research:${source.id}:2:${source.cycle}`);
  assert.equal(latest.tasks.length, 1); assert.equal(latest.tasks[0].retained, true); assert.equal(latest.tasks[0].memberId, 'manager');
}));

test('deleted exact report sources cannot be read through diagnostics and publication is independent of acceptance', async () => fixture(async ({ client, owner, service, journals, reads }) => {
  const source = await session(client, owner), taskId = randomUUID(), report = randomUUID(), document = randomUUID(), version = randomUUID();
  await attempt(client, owner, source, taskId); journals.set(taskId, journal(owner, source, taskId));
  await client`insert into research_documents(id,owner,title,kind) values(${document},${owner},'Fixture report','council')`;
  await client`insert into research_document_versions(id,owner,report_id,version,idempotency_key,content_hash,title,kind,content,sections,source)
    values(${version},${owner},${document},1,'key','hash','Fixture report','council','fictional report','[]',${JSON.stringify({ type: 'council', id: report })}::jsonb)`;
  await client`insert into council_reports(id,owner,session_id,version,revision,decision,summary,dissent,next_review_condition,evidence,engine,coverage,research_version_id,publication_outcome,created_at)
    values(${report},${owner},${source.id},1,1,'wait','Fictional summary','[]','later','[]','local',${JSON.stringify({ cycleId: source.cycle, complete: true })}::jsonb,${version},'failed',${at})`;
  const result = await service.read(owner, source.runId);
  assert.equal(result.tasks[0].acceptance, 'accepted'); assert.equal(result.publication, 'failed');
  await client`update research_document_versions set deleted_at=now() where id=${version}`;
  const before = reads.length;
  await assert.rejects(service.read(owner, source.runId), /TELEMETRY_RUN_NOT_FOUND/);
  assert.equal(reads.length, before);
}));

test('source deletion during an asynchronous journal read is revalidated before any snapshot is returned', async () => fixture(async ({ client, owner }) => {
  const source = await session(client, owner), taskId = randomUUID(); await attempt(client, owner, source, taskId);
  const db = drizzle(client);
  const service = new TelemetryDiagnosticsService(db, new TelemetryService(db), { get: () => ({ getTaskDiagnostics: async () => {
    await client`update council_sessions set deleted_at=now() where id=${source.id}`;
    return journal(owner, source, taskId);
  } }) } as any);
  await assert.rejects(service.read(owner, source.runId), /TELEMETRY_RUN_NOT_FOUND/);
}));

test('saved review decisions stay attached to the reviewed work during rework, later revisions and final review failure', async () => fixture(async ({ client, owner, service, journals }) => {
  const source = await session(client, owner), firstTaskId = randomUUID(), nextTaskId = randomUUID(), finalTaskId = randomUUID(), parseTaskId = randomUUID();
  const reviewedAt = '2026-11-11T01:00:05.000Z';
  const work = (taskId: string, state = 'succeeded') => ({ id: randomUUID(), revision: 1, kind: 'work', state, startedAt: at, finishedAt: at,
    remoteTaskId: taskId, externalAgent: true });
  const review = (accepted: boolean, state = 'succeeded', revision = 1) => ({ id: randomUUID(), revision, kind: 'review', state,
    startedAt: at, finishedAt: reviewedAt, externalAgent: false, review: { accepted, feedback: 'private review rationale' } });
  const groups = [
    { key: 'financials', state: 'running', attempts: [work(firstTaskId), review(false, 'succeeded', 2), review(true, 'failed', 2), work(nextTaskId, 'running')] },
    { key: 'business', state: 'failed', attempts: [work(finalTaskId), review(false)] },
    { key: 'valuation', state: 'failed', attempts: [work(parseTaskId, 'failed')] },
  ];
  for (const [position, group] of groups.entries()) {
    await client`insert into council_research_tasks(owner,session_id,cycle_id,revision,key,position,member_id,dependencies,state,attempts,skills,updated_at)
      values(${owner},${source.id},${source.cycle},1,${group.key},${position},'member','[]',${group.state},${JSON.stringify(group.attempts)}::jsonb,'[]',${reviewedAt})`;
    for (const [index, entry] of group.attempts.entries()) if (entry.kind === 'work') {
      const taskId = (entry as ReturnType<typeof work>).remoteTaskId;
      const saved = journal(owner, source, taskId); saved.activityContext.attempt = index + 1; saved.activityContext.turn = position;
      if (entry.state === 'running') saved.state = 'running';
      journals.set(taskId, saved);
    }
  }
  const result = await service.read(owner, source.runId), byId = new Map(result.tasks.map((task: any) => [task.taskId, task]));
  assert.equal(byId.get(firstTaskId).acceptance, 'rejected');
  assert.equal(byId.get(nextTaskId).acceptance, 'pending');
  assert.equal(byId.get(finalTaskId).acceptance, 'rejected');
  assert.equal(byId.get(parseTaskId).acceptance, 'pending', 'a failed workflow state alone does not establish a recorded review decision');
  assert.equal(byId.get(firstTaskId).events.find((event: any) => event.kind === 'acceptance').at, reviewedAt);
  assert.ok(!JSON.stringify(result).includes('private review rationale'));
}));

test('API workflow task IDs never manufacture missing local journals while legacy native receipt IDs remain readable', async () => fixture(async ({ client, owner, service, journals, reads }) => {
  const source = await session(client, owner), apiWork = randomUUID(), apiReview = randomUUID(), legacyNative = randomUUID();
  const groups = [
    { key: 'financials', attempts: [
      { id: apiWork, revision: 1, kind: 'work', state: 'succeeded', startedAt: at, finishedAt: at, taskId: apiWork, externalAgent: false },
      { id: apiReview, revision: 1, kind: 'review', state: 'succeeded', startedAt: at, finishedAt: at, taskId: apiReview, externalAgent: false, review: { accepted: true, feedback: 'Fictional review' } },
    ] },
    { key: 'business', attempts: [{ id: randomUUID(), revision: 1, kind: 'work', state: 'succeeded', startedAt: at, finishedAt: at, taskId: legacyNative, externalAgent: true }] },
  ];
  for (const [position, group] of groups.entries()) await client`insert into council_research_tasks(owner,session_id,cycle_id,revision,key,position,member_id,dependencies,state,attempts,skills,updated_at)
    values(${owner},${source.id},${source.cycle},1,${group.key},${position},'member','[]','accepted',${JSON.stringify(group.attempts)}::jsonb,'[]',${at})`;
  const saved = journal(owner, source, legacyNative); saved.activityContext.turn = 1; journals.set(legacyNative, saved);
  const result = await service.read(owner, source.runId);
  assert.deepEqual(result.tasks.map((task: any) => task.taskId), [legacyNative]);
  assert.equal(result.tasks[0].retained, true); assert.deepEqual(reads, [legacyNative]);
}));
