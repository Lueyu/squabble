import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { councilSessions } from '../../database/council.schema';
import { councilMemberAttempts } from '../../database/simple-council.schema';
import { CouncilService } from './council.service';
import { CouncilMemberAttemptsService } from './council-member-attempts.service';
import { newCheckpoint } from './council.dialogue';
import { normalizeBuilderConfig } from '../paper-trading/agent-builder.rules';

test('stopping preserves uncertainty and settles confirmed attempts despite the revision fence', async () => {
  assert.ok(process.env.COUNCIL_TEST_DATABASE_URL, 'Temporary database required');
  const namespace = `stop_fixture_${randomUUID().replaceAll('-', '')}`;
  const admin = postgres(process.env.COUNCIL_TEST_DATABASE_URL!, { max: 1, onnotice: () => {} });
  const client = postgres(process.env.COUNCIL_TEST_DATABASE_URL!, { max: 6, onnotice: () => {}, connection: { search_path: namespace } });
  try {
    await admin`CREATE SCHEMA ${admin(namespace)}`;
    for (const name of readdirSync('scripts/db').filter(n => /^\d+.*\.sql$/u.test(n) && !n.startsWith('02_') && (Number(n.slice(0, 2)) <= 34 || n.startsWith('49_'))).sort()) await client.unsafe(readFileSync(`scripts/db/${name}`, 'utf8'));
    const owner = randomUUID(); await client`INSERT INTO users(id,username,password_hash) VALUES(${owner},'stop-fixture','test')`;
    const members = ['confirmed', 'uncertain', 'queued'].map((id, index) => ({ id, name: id, role: index === 2 ? 'manager' as const : 'researcher' as const, model: 'fast' as const, instructions: '', executionMode: 'local' as const, agentId: `native-${id}` }));
    const config = normalizeBuilderConfig({ name: 'Fixture', template: 'guard', tickers: ['AAPL'], minimumRating: 'Buy', customPrompt: '', maxOrderPct: 5, dailyLossLimitPct: 3, maxOrdersPerDay: 1, notifyOnProposal: false, priceRules: [], council: { enabled: true, members } });
    const checkpoint = newCheckpoint(members, { independent: true });
    const db = drizzle(client);
    const [session] = await db.insert(councilSessions).values({ owner, profileVersion: 1, profileSnapshot: config, ticker: 'AAPL', status: 'running', checkpoint }).returning();
    await db.insert(councilMemberAttempts).values(members.map((member, turn) => ({ owner, sessionId: session.id, cycleId: checkpoint.cycleId, memberId: member.id, attempt: 1, revision: session.revision, turn, resourceKey: `local:${member.agentId}`, inputHash: 'frozen', inputSnapshot: {}, status: 'running', dispatchStarted: turn < 2, taskId: member.id })));
    const agents = { cancelTask: async () => 'cancelled', store: { eventsForSession: async () => ({ events: [], cursor: 0, truncated: false }), task: async (_owner: string, id: string) => id === 'uncertain' ? { state: 'failed', error: 'LOCAL_DISPATCH_UNCERTAIN', runtimeEntered: true } : { state: 'cancelled', error: 'LOCAL_CANCELLED' } } };
    const council = new CouncilService(db, {} as never, {} as never, {} as never, {} as never, agents as never);
    await council.pauseSession(owner, session.id);
    const store = new CouncilMemberAttemptsService(db), attempts = await store.list(owner, session.id);
    assert.equal(attempts.find(a => a.memberId === 'confirmed')?.status, 'cancelled');
    assert.deepEqual(attempts.find(a => a.memberId === 'confirmed')?.failure?.recoveries, ['retry_member']);
    assert.equal(attempts.find(a => a.memberId === 'queued')?.status, 'cancelled');
    assert.equal(attempts.find(a => a.memberId === 'uncertain')?.status, 'unknown');
    assert.deepEqual(attempts.find(a => a.memberId === 'uncertain')?.failure?.recoveries, ['check_existing']);
    assert.equal(await store.settle(owner, attempts[0].id, { status: 'completed', resultAcceptance: 'accepted' }), false, 'old results remain fenced');

    let calls = 0, release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const llm = { isConfigured: async () => true, validateConnectionIds: async () => {}, chatFastJSON: async () => {
      const call = ++calls;
      if (call <= 2) await blocked;
      return { data: { content: 'Public view', evidenceIds: [], decision: 'wait', summary: 'Continue observing', dissent: [], nextReviewCondition: 'New evidence' }, tokens: 1 };
    } };
    const apiCouncil = new CouncilService(db, llm as never, { collectEvidence: async () => [] } as never,
      { getPortfolioContext: async () => ({ holdings: [], cash: 0, totalValue: 0 }) } as never, { listRuns: async () => ({ items: [] }) } as never);
    const api = await apiCouncil.createSession(owner, { ticker: 'AAPL', language: 'en', members: [
      { id: 'api-one', name: 'One', role: 'researcher', model: 'fast', instructions: '' },
      { id: 'api-two', name: 'Two', role: 'manager', model: 'fast', instructions: '' },
    ] }, { independent: true });
    await apiCouncil.runSession(owner, api.id);
    try {
      for (let count = 0; calls < 2 && count < 200; count++) await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(calls, 2);
      await apiCouncil.pauseSession(owner, api.id);
      assert.ok((await store.list(owner, api.id)).every(attempt => attempt.status === 'unknown'));
      await assert.rejects(apiCouncil.runSession(owner, api.id), /ORIGINAL_TASK_NOT_TERMINATED/u);
      assert.equal(calls, 2, 'a resume cannot replay uncertain API dispatch');
    } finally { release(); }
    for (let count = 0; count < 200; count++) {
      if ((await store.list(owner, api.id)).every(attempt => attempt.status === 'cancelled')) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok((await store.list(owner, api.id)).every(attempt => attempt.status === 'cancelled'), 'drained API calls acknowledge cancellation');
    assert.equal(calls, 2, 'settlement never dispatches research');
    await apiCouncil.runSession(owner, api.id);
    for (let count = 0; count < 200; count++) {
      if ((await apiCouncil.getSession(owner, api.id)).status !== 'running') break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal((await apiCouncil.getSession(owner, api.id)).status, 'completed');
    assert.ok(calls > 2, 'only the explicit settled resume starts a fresh cycle');

    let finishRetry!: () => void, retryCalls = 0, failRetry = false;
    let retryGate = new Promise<void>(resolve => { finishRetry = resolve; });
    const retryCouncil = new CouncilService(db, { chatFastJSON: async () => {
      retryCalls++; await retryGate;
      if (failRetry) throw new Error('LLM_REQUEST_TIMEOUT');
      return { data: { content: 'Recovered view', evidenceIds: [] }, tokens: 1 };
    } } as never, {} as never, {} as never, {} as never);
    const retryCheckpoint = newCheckpoint(config.council!.members, { independent: true });
    const apiConfig = { ...config, council: { ...config.council!, members: [
      { id: 'retry-api', name: 'API', role: 'manager' as const, model: 'fast' as const, instructions: '' },
    ] } };
    const [retrySession] = await db.insert(councilSessions).values({ owner, profileVersion: 1, profileSnapshot: apiConfig, ticker: 'AAPL', status: 'paused', checkpoint: retryCheckpoint }).returning();
    await db.insert(councilMemberAttempts).values({ owner, sessionId: retrySession.id, cycleId: retryCheckpoint.cycleId, memberId: 'retry-api', attempt: 1, revision: retrySession.revision, turn: 0, resourceKey: 'api:default', inputHash: 'frozen', inputSnapshot: { commonEvidence: [], commonMessageIds: [] }, status: 'failed', failure: { code: 'LOCAL_TASK_FAILED', stage: 'runtime', recoveries: ['retry_member'] } });
    await retryCouncil.recoverMember(owner, retrySession.id, { memberId: 'retry-api', action: 'retry_member', requestKey: 'stopped-api-retry', expectedRevision: retrySession.revision });
    try {
      for (let count = 0; retryCalls < 1 && count < 200; count++) await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(retryCalls, 1);
      await retryCouncil.pauseSession(owner, retrySession.id);
    } finally { finishRetry(); }
    for (let count = 0; count < 200; count++) {
      if ((await store.list(owner, retrySession.id)).at(-1)?.status === 'cancelled') break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal((await store.list(owner, retrySession.id)).at(-1)?.status, 'cancelled', 'a drained recovery call also acknowledges stop');
    assert.equal(retryCalls, 1);

    failRetry = true;
    retryGate = new Promise<void>(resolve => { finishRetry = resolve; });
    const beforeTimeout = await retryCouncil.getSession(owner, retrySession.id);
    await retryCouncil.recoverMember(owner, retrySession.id, { memberId: 'retry-api', action: 'retry_member', requestKey: 'timed-out-api-retry', expectedRevision: beforeTimeout.revision });
    try {
      for (let count = 0; retryCalls < 2 && count < 200; count++) await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(retryCalls, 2);
      await retryCouncil.pauseSession(owner, retrySession.id);
    } finally { finishRetry(); }
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal((await store.list(owner, retrySession.id)).at(-1)?.status, 'unknown', 'API transport timeout does not confirm upstream termination');
    await assert.rejects(retryCouncil.runSession(owner, retrySession.id), /ORIGINAL_TASK_NOT_TERMINATED/u);
    assert.equal(retryCalls, 2);
  } finally { await client.end(); await admin`DROP SCHEMA IF EXISTS ${admin(namespace)} CASCADE`; await admin.end(); }
});
