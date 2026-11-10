import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { CouncilMemberAttemptsService } from './council-member-attempts.service';
import { councilSessions } from '../../database/council.schema';
import { newCheckpoint } from './council.dialogue';
import { normalizeBuilderConfig } from '../paper-trading/agent-builder.rules';
import { CouncilService } from './council.service';

test('durable member claims enforce concurrent limits, preserve neighbors and fence late writes', async () => {
  assert.ok(process.env.COUNCIL_TEST_DATABASE_URL, 'Temporary database required');
  const namespace = `attempt_fixture_${randomUUID().replaceAll('-', '')}`;
  const admin = postgres(process.env.COUNCIL_TEST_DATABASE_URL!, { max: 1, onnotice: () => {} });
  const client = postgres(process.env.COUNCIL_TEST_DATABASE_URL!, { max: 8, onnotice: () => {}, connection: { search_path: namespace } });
  try {
    await admin`CREATE SCHEMA ${admin(namespace)}`;
    for (const name of readdirSync('scripts/db').filter(name => /^\d+.*\.sql$/u.test(name) && !name.startsWith('02_') && (Number(name.slice(0, 2)) <= 34 || name.startsWith('49_'))).sort()) await client.unsafe(readFileSync(`scripts/db/${name}`, 'utf8'));
    const owner = randomUUID(); await client`INSERT INTO users(id,username,password_hash) VALUES(${owner},'attempt-fixture','test')`;
    const members = ['one','two','three'].map((id,index) => ({ id, name: id, role: index === 2 ? 'manager' as const : 'researcher' as const, model: 'fast' as const, instructions: '' }));
    const checkpoint = newCheckpoint(members, { independent: true });
    const db = drizzle(client); const service = new CouncilMemberAttemptsService(db);
    const config = normalizeBuilderConfig({ name: 'Fixture', template: 'guard', tickers: ['AAPL'], minimumRating: 'Buy', customPrompt: '', maxOrderPct: 5, dailyLossLimitPct: 3, maxOrdersPerDay: 1, notifyOnProposal: false, priceRules: [], council: { enabled: true, members } });
    const [session] = await db.insert(councilSessions).values({ owner, profileSnapshot: config, profileVersion: 1, ticker: 'AAPL', status: 'running', checkpoint }).returning();
    const claim = (memberId: string, resourceKey = memberId) => service.claim({ owner, sessionId: session.id, cycleId: checkpoint.cycleId, memberId, revision: session.revision, turn: members.findIndex(m => m.id === memberId), resourceKey, inputHash: 'frozen', inputSnapshot: { question: 'Frozen question' } });
    const [first, duplicate] = await Promise.all([claim('one'), claim('one')]);
    assert.ok(first); assert.equal(duplicate, null);
    const second = await claim('two'); assert.ok(second); assert.equal(await claim('three'), null);
    await service.settle(owner, first!.id, { status: 'failed', resultAcceptance: 'pending', failure: { code: 'LOCAL_TASK_FAILED', stage: 'runtime', recoveries: ['retry_member'] } });
    const third = await claim('three'); assert.ok(third);
    const states = await service.list(owner, session.id, checkpoint.cycleId);
    assert.equal(states.find(x => x.memberId === 'two')?.status, 'queued');
    assert.equal(await service.settle('another-owner', second!.id, { status: 'completed', resultAcceptance: 'accepted' }), false);
    await client`UPDATE council_sessions SET revision=revision+1 WHERE id=${session.id}`;
    assert.equal(await service.settle(owner, third!.id, { status: 'completed', resultAcceptance: 'accepted' }), false);
    // Two independent model calls must enter before either is allowed to finish.
    let started = 0; let entered!: () => void; let finish!: () => void;
    const bothEntered = new Promise<void>(resolve => { entered = resolve; });
    const blocked = new Promise<void>(resolve => { finish = resolve; }); const prompts: string[] = [];
    const llm = { validateConnectionIds: async () => {}, isConfigured: async () => true,
      chatFastJSON: async (prompt: Array<{content:string}>) => {
        const n = ++started; prompts.push(JSON.stringify(prompt));
        if (n <= 2) { if (n === 2) entered(); await blocked; }
        return { data: { content: n === 1 ? 'FIRST_PRIVATE_VIEW' : 'Another public view.', evidenceIds: [] }, tokens: 1 };
      } };
    const council = new CouncilService(db, llm as never, { collectEvidence: async () => [] } as never,
      { getPortfolioContext: async () => ({ totalValue: 0, cash: 0, holdings: [] }) } as never, { listRuns: async () => ({items:[]}) } as never);
    const conversation = await council.createSession(owner, { ticker: 'AAPL', language: 'en', members: members.slice(0,2).map((m,i)=>({...m,role:i?'manager':'researcher'})) }, { independent:true });
    await council.runSession(owner, conversation.id);
    let barrierTimeout: ReturnType<typeof setTimeout> | undefined;
    try {
      // This is a concurrency barrier, not a startup-latency benchmark. Schema
      // and TypeScript cold starts on a shared worker must not release either call.
      await Promise.race([bothEntered, new Promise((_, reject) => {
        barrierTimeout = setTimeout(() => reject(new Error('Independent calls did not run concurrently')), 10_000);
      })]);
    } finally {
      if (barrierTimeout) clearTimeout(barrierTimeout);
      finish();
    }
    assert.equal(prompts[1].includes('FIRST_PRIVATE_VIEW'), false);
    for (let n=0;n<200;n++) { if ((await council.getSession(owner, conversation.id)).status !== 'running') break; await new Promise(resolve=>setTimeout(resolve,10)); }
    assert.equal((await council.getSession(owner, conversation.id)).status,'completed');
  } finally { await client.end(); await admin`DROP SCHEMA IF EXISTS ${admin(namespace)} CASCADE`; await admin.end(); }
});
