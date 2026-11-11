import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { DailyWorkspaceResearchService } from './daily-workspace-research.service';
import { DailyWorkspaceService } from './daily-workspace.service';
import { CurrentResearchService } from './current-research.service';
import { SimpleCouncilService } from '../council/simple-council.service';
import { CouncilService } from '../council/council.service';
import { ResearchDocumentsService } from '../research-documents/research-documents.service';
import { paperAccounts, paperOrders, paperTrades, holdings } from '../../database/schema';
import { councilMessages, councilSessions } from '../../database/council.schema';
import type { CouncilMember } from '../../../shared/council.interface';
import type { OverallDailyEvidence } from '../../../shared/daily-workspace.interface';

test('explicit overall daily freezes all owner facts, seals independent work, reverse-checks and publishes separately with stable retries', {
  skip: !process.env.EXPERIENCE_TEST_DATABASE_URL,
}, async t => {
  const url = process.env.EXPERIENCE_TEST_DATABASE_URL!, namespace = `overall_daily_${randomUUID().replaceAll('-', '')}`;
  const admin = postgres(url, { max: 1, onnotice: () => {} });
  const client = postgres(url, { max: 6, onnotice: () => {}, connection: { search_path: namespace } });
  async function waitForDatabaseClock(): Promise<void> {
    // Published fixtures use PostgreSQL timestamps; a VM clock can briefly lead the application visibility fence.
    const [database] = await client<{ clock: number }[]>`SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::double precision AS clock`;
    const delay = database.clock - Date.now() + 5;
    assert.ok(delay <= 5000, 'fixture database clock must be within five seconds of the application clock');
    if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
  }
  await admin`CREATE SCHEMA ${admin(namespace)}`;
  try {
    for (const file of readdirSync('scripts/db').filter(name => /^\d\d_.*\.sql$/u.test(name) && !name.startsWith('02_')).sort()) await client.unsafe(readFileSync(`scripts/db/${file}`, 'utf8'));
    const db = drizzle(client), owner = randomUUID(), other = randomUUID(), day = '2026-11-09';
    for (const id of [owner, other]) await client`INSERT INTO users (id,username,password_hash) VALUES (${id},${`overall-${id.slice(0, 12)}`},'fixture-only')`;
    const documents = new ResearchDocumentsService(db);
    const historical = await documents.submit(owner, { idempotencyKey: 'original-personal', title: 'Original saved personal inputs', kind: 'portfolio',
      content: 'Original saved report', sections: [{ id: 'summary', title: 'Saved personal finding', content: 'Original saved report' }],
      snapshot: { businessDate: '2026-11-08', capturedAt: '2026-11-08T05:00:00Z', holdings: [{ ticker: 'HIST', shares: 9 }] } });
    await documents.submit(other, { idempotencyKey: 'foreign', title: 'PRIVATE original inputs', kind: 'portfolio', content: 'PRIVATE', sections: [{ id: 'summary', title: 'Foreign', content: 'PRIVATE' }], snapshot: { businessDate: '2026-11-08', holdings: [{ ticker: 'PRIVATE' }] } });
    await db.insert(holdings).values({ owner, ticker: 'CURRENT_ONLY', shares: '99', buyPrice: '1', currentPrice: '1' });
    const createdAt = new Date('2026-11-08T01:00:00Z');
    const [a, b, foreign] = await db.insert(paperAccounts).values([{ owner, name: 'Fictional income', createdAt }, { owner, name: 'Fictional growth', createdAt }, { owner: other, name: 'PRIVATE account', createdAt }]).returning();
    const [order] = await db.insert(paperOrders).values({ owner, accountId: a.id, ticker: 'FICT', side: 'buy', quantity: '1', currency: 'HKD', status: 'filled', createdAt }).returning();
    await db.insert(paperOrders).values([{ owner, accountId: b.id, ticker: 'WAIT', side: 'buy', quantity: '2', status: 'pending_approval', reason: 'Needs explicit approval', createdAt: new Date(`${day}T02:00:00Z`) },
      { owner, accountId: b.id, ticker: 'FAIL', side: 'buy', quantity: '2', status: 'failed', reason: 'Fictional execution failure', createdAt: new Date(`${day}T02:00:00Z`) }]);
    await db.insert(paperTrades).values({ owner, accountId: a.id, orderId: order.id, ticker: 'FICT', side: 'buy', quantity: '1', price: '10', fee: '0.1', cashAfter: '100', createdAt: new Date(`${day}T04:00:00Z`) });
    const prompts: Array<{ system: string; input: Record<string, unknown> }> = [];
    let budgetFailure = false;
    let failSummaryOnce = false;
    const llm = { validateConnectionIds: async () => {}, isConfigured: async () => true, chatFastJSON: async (messages: Array<{ content: string }>) => {
      if (budgetFailure) throw new Error('LLM_BUDGET_EXCEEDED_INPUT_TOKENS');
      const input = JSON.parse(messages[1].content); prompts.push({ system: messages[0].content, input });
      if (failSummaryOnce && input.phase === 'summary') { failSummaryOnce = false; throw new Error('Fictional temporary API summary failure'); }
      return { data: { response: { thesis: input.phase === 'opening' ? `SEALED_${input.member.name}` : input.phase === 'challenge' ? 'Reverse check complete' : 'Overall finding: income account filled; growth account awaits approval and had a failure. Historical personal evidence is limited.', evidencePoints: [], risks: ['Missing exact valuation boundaries'], nextChecks: ['Check failed execution reason'] },
        evidenceIds: [], researchStance: 'balanced', ...(input.phase === 'challenge' ? { reverseCheck: { outcome: 'unable_to_verify', checked: ['Compare saved fill and valuation timestamps'], findings: [], gaps: ['Missing closing valuation'], affectedPremises: ['Daily performance is complete'], evidenceIds: [] } } : {}) }, tokens: 1 };
    } };
    const council = new CouncilService(db, llm as never, { collectEvidence: async () => [] } as never,
      { getPortfolioContext: async () => { throw Error('Must not substitute live holdings'); } } as never,
      { listRuns: async () => ({ items: [] }) } as never, undefined, undefined, undefined, undefined, documents);
    const simple = new SimpleCouncilService(db, council, llm as never, undefined, undefined, documents);
    const members: CouncilMember[] = [
      { id: 'ledger', name: 'Ledger', role: 'researcher', model: 'fast', instructions: '' },
      { id: 'risk', name: 'Risk', role: 'challenger', model: 'fast', instructions: '' },
      { id: 'summary', name: 'Summary', role: 'manager', model: 'fast', instructions: '' },
    ];
    simple.resolveMembers = async () => ({ members, executors: members.map(member => ({ memberId: member.id, connection: member.id, identity: `fixture:${member.id}`, provider: 'fixture', model: member.id })) });
    const current = new CurrentResearchService(db, documents, {} as never, simple);
    const daily = new DailyWorkspaceService(db, current);
    const overall = new DailyWorkspaceResearchService(db, daily, simple);
    let captures = 0;
    const capture = overall.capture.bind(overall);
    overall.capture = async (...args) => { captures++; return capture(...args); };
    await waitForDatabaseClock();

    await t.test('reads perform no model calls and strict request scope cannot override owner/facts', async () => {
      assert.equal((await overall.read(owner, day)).latest, null);
      assert.equal(prompts.length, 0); assert.equal(captures, 0);
      await assert.rejects(overall.start(owner, { date: day, requestKey: 'bad', owner: other }));
      await assert.rejects(overall.start(owner, { date: '2026-02-30', requestKey: 'bad' }));
    });
    await overall.start(owner, { date: day, requestKey: 'stable' });
    let view = await overall.read(owner, day);
    for (let i = 0; i < 500 && ['idle', 'running'].includes(view.latest?.status ?? ''); i++) {
      await new Promise(resolve => setTimeout(resolve, 10)); view = await overall.read(owner, day);
    }
    await waitForDatabaseClock(); view = await overall.read(owner, day);
    assert.equal(view.latest?.status, 'completed', view.latest?.error ?? 'not completed');
    assert.equal(view.reports.length, 1); assert.equal(captures, 1);
    assert.equal(prompts.filter(prompt => prompt.input.phase === 'opening').length, 3);
    assert.equal(prompts.filter(prompt => prompt.input.phase === 'challenge').length, 1);
    assert.equal(prompts.filter(prompt => prompt.input.phase === 'summary').length, 1);
    let frozen: OverallDailyEvidence | undefined;
    for (const prompt of prompts) {
      assert.match(prompt.system, /different starting points|Different starting points/i);
      const evidence = (prompt.input.evidence as Array<{ source: string; content: string }>).find(item => item.source === 'Frozen owner context');
      assert.ok(evidence, 'mandatory owner input survives all phases');
      const input = JSON.parse(evidence.content) as OverallDailyEvidence;
      frozen ??= input; assert.deepEqual(input, frozen, 'every phase sees exactly the same atomic fact bundle');
      assert.equal(input.facts.date, day); assert.equal(input.facts.timezone, 'Asia/Shanghai');
      assert.equal(input.facts.accounts.length, 2);
      assert.equal(input.facts.accounts.find(account => account.id === a.id)!.trades[0].feeCurrency, 'USD');
      assert.deepEqual(input.facts.accounts.find(account => account.id === b.id)!.notExecuted.map(row => row.status).sort(), ['failed', 'pending_approval']);
      assert.equal(input.personalHistory.currentStoredPortfolio, null, 'current holdings cannot stand in for the historical report');
      assert.equal(input.personalHistory.sources[0].versionId, historical.id);
      assert.equal(JSON.stringify(input).includes('PRIVATE'), false); assert.equal(JSON.stringify(input).includes('CURRENT_ONLY'), false);
      if (prompt.input.phase === 'opening') assert.equal(JSON.stringify(prompt.input).includes('SEALED_'), false);
    }
    const published = await documents.getVersion(owner, view.reports[0].versionId);
    assert.equal((published.snapshot?.overallDaily as { date: string }).date, day);
    assert.equal(published.snapshot?.businessDate, day);
    assert.equal((published.snapshot?.evidence as Array<{ content: string }>).some(row => row.content === JSON.stringify(frozen)), true);
    assert.equal((await current.getDailyReports(owner, day)).history.length, 0, 'overall publication never becomes the original personal report or discussion');
    assert.equal((await overall.read(other, day)).reports.length, 0);
    assert.equal((await documents.getVersion(owner, historical.id)).content, historical.content);
    const beforeRetry = prompts.length;
    await overall.start(owner, { date: day, requestKey: 'stable' });
    assert.equal(captures, 1); assert.equal(prompts.length, beforeRetry, 'durable request replay neither recaptures facts nor recalls the model');
    await t.test('generic run/message/fork cannot turn an overall archive into a new ordinary cycle', async () => {
      const id = view.latest!.sessionId;
      const session = await council.getSession(owner, id);
      await assert.rejects(council.runSession(owner, id), /OVERALL_DAILY_RESUME_REQUIRED/);
      await assert.rejects(council.addMessage(owner, id, 'Change the frozen question'), /OVERALL_DAILY_NEW_REQUEST_REQUIRED/);
      await assert.rejects(simple.addMessage(owner, id, { message: 'Change the frozen question', requestKey: 'forbidden-followup' }), /OVERALL_DAILY_NEW_REQUEST_REQUIRED/);
      await assert.rejects(council.forkSession(owner, id, { messageId: session.messages[0].id }), /OVERALL_DAILY_NEW_REQUEST_REQUIRED/);
      assert.equal(prompts.length, beforeRetry);
      const [stored] = await db.select().from(councilSessions).where(eq(councilSessions.id, id));
      await db.update(councilSessions).set({ checkpoint: { ...stored.checkpoint!, simple: { ...stored.checkpoint!.simple!, overallDaily: undefined } } }).where(eq(councilSessions.id, id));
      assert.equal((await overall.read(owner, day)).reports.length, 1, 'history belongs to the immutable version marker, not a mutable session');
      assert.equal((await current.getDailyReports(owner, day)).history.length, 0);
      await db.update(councilSessions).set({ checkpoint: stored.checkpoint }).where(eq(councilSessions.id, id));
    });
    const [ledger] = await client`SELECT count(*)::int AS fills FROM paper_trades WHERE owner=${owner}`;
    assert.equal(ledger.fills, 1);
    const [strategies] = await client`SELECT count(*)::int AS count FROM user_investment_strategies WHERE owner=${owner}`;
    assert.equal(strategies.count, 0, 'publication grants no strategy or trading authority');

    await t.test('explicit API summary continuation retains the cycle and never pays for completed openings again', async () => {
      failSummaryOnce = true;
      const startCalls = prompts.length;
      await overall.start(owner, { date: day, requestKey: 'summary-failure' });
      let failed = await overall.read(owner, day);
      for (let i = 0; i < 500 && ['idle', 'running'].includes(failed.latest?.status ?? ''); i++) {
        await new Promise(resolve => setTimeout(resolve, 10)); failed = await overall.read(owner, day);
      }
      assert.equal(failed.latest?.status, 'failed');
      const id = failed.latest!.sessionId;
      const [before] = await db.select().from(councilSessions).where(eq(councilSessions.id, id));
      const payload = { expectedRevision: before.revision, requestKey: 'resume-exact-summary' };
      await simple.resumeReport(owner, id, payload);
      for (let i = 0; i < 500; i++) {
        await new Promise(resolve => setTimeout(resolve, 10)); failed = await overall.read(owner, day);
        if (!['idle', 'running'].includes(failed.latest?.status ?? '')) break;
      }
      await waitForDatabaseClock(); failed = await overall.read(owner, day);
      assert.equal(failed.latest?.status, 'completed', failed.latest?.error ?? 'not completed');
      const [after] = await db.select().from(councilSessions).where(eq(councilSessions.id, id));
      assert.equal(after.checkpoint?.cycleId, before.checkpoint?.cycleId);
      assert.deepEqual(after.checkpoint?.simple?.overallDaily, before.checkpoint?.simple?.overallDaily);
      const attempts = prompts.slice(startCalls);
      assert.equal(attempts.filter(prompt => prompt.input.phase === 'opening').length, 3);
      assert.equal(attempts.filter(prompt => prompt.input.phase === 'challenge').length, 1);
      assert.equal(attempts.filter(prompt => prompt.input.phase === 'summary').length, 2);
      const count = prompts.length; await simple.resumeReport(owner, id, payload); assert.equal(prompts.length, count);
      assert.equal(failed.reports.length, 2);
    });

    await t.test('budget failure remains a visible failed research without an invented report', async () => {
      budgetFailure = true;
      await overall.start(other, { date: day, requestKey: 'budget-failure' });
      let failed = await overall.read(other, day);
      for (let i = 0; i < 500 && ['idle', 'running'].includes(failed.latest?.status ?? ''); i++) {
        await new Promise(resolve => setTimeout(resolve, 10)); failed = await overall.read(other, day);
      }
      assert.equal(failed.reports.length, 0); assert.notEqual(failed.latest?.status, 'completed');
      assert.ok(failed.latest?.sessionId);
      await assert.rejects(council.runSession(other, failed.latest!.sessionId), /OVERALL_DAILY_RESUME_REQUIRED/);
      const [stored] = await db.select().from(councilSessions).where(eq(councilSessions.id, failed.latest!.sessionId));
      assert.equal(stored.checkpoint?.simple?.overallDaily?.date, day);
      assert.equal((await overall.read(owner, day)).reports.length, 2);
      assert.ok(foreign.id);
    });
    await t.test('recovered openings release their original waiting barrier without another opening dispatch', async () => {
      budgetFailure = false;
      const id = (await overall.read(other, day)).latest!.sessionId;
      const [before] = await db.select().from(councilSessions).where(eq(councilSessions.id, id));
      assert.equal(before.checkpoint?.simple?.stage, 'waiting');
      const startingCalls = prompts.length;
      for (const member of members) {
        const saved = await simple.get(other, id);
        await simple.recover(other, id, { memberId: member.id, action: 'retry_member', expectedRevision: saved.revision, requestKey: `recover-${member.id}` });
        for (let i = 0; i < 500; i++) {
          await new Promise(resolve => setTimeout(resolve, 10));
          if ((await simple.get(other, id)).status !== 'running') break;
        }
      }
      const accepted = await simple.get(other, id);
      assert.ok(accepted.memberStates.every(state => state.resultAcceptance === 'accepted'));
      const request = { expectedRevision: accepted.revision, requestKey: 'release-saved-openings' };
      await simple.resumeReport(other, id, request);
      let finished = await overall.read(other, day);
      for (let i = 0; i < 500 && ['idle', 'running'].includes(finished.latest?.status ?? ''); i++) {
        await new Promise(resolve => setTimeout(resolve, 10)); finished = await overall.read(other, day);
      }
      await waitForDatabaseClock(); finished = await overall.read(other, day);
      assert.equal(finished.latest?.status, 'completed', finished.latest?.error ?? 'not completed');
      assert.equal(finished.reports.length, 1);
      const [after] = await db.select().from(councilSessions).where(eq(councilSessions.id, id));
      assert.equal(after.checkpoint?.cycleId, before.checkpoint?.cycleId);
      const calls = prompts.slice(startingCalls);
      assert.equal(calls.filter(prompt => prompt.input.phase === 'opening').length, 3, 'only the three explicitly requested member retries');
      assert.equal(calls.filter(prompt => prompt.input.phase === 'challenge').length, 1);
      assert.equal(calls.filter(prompt => prompt.input.phase === 'summary').length, 1);
      const delivered = (await db.select().from(councilMessages).where(eq(councilMessages.sessionId, id)))
        .filter(message => message.metadata?.phase === 'opening' || message.metadata?.phase === 'response');
      assert.equal(delivered.length, 3, 'each recovered sealed contribution is delivered once at the barrier');
      assert.equal(delivered.reduce((sum, message) => sum + message.tokensUsed, 0), 3, 'usage is not counted again as a supplemental response');
      const completedCalls = prompts.length;
      await simple.resumeReport(other, id, request); assert.equal(prompts.length, completedCalls);
    });
    await t.test('a committed request interrupted before dispatch resumes explicitly without recapture or startup calls', async () => {
      const priorCalls = prompts.length, priorCaptures = captures;
      const interrupted = new SimpleCouncilService(db, council, llm as never, undefined, undefined, documents);
      interrupted.resolveMembers = simple.resolveMembers;
      Object.defineProperty(interrupted, 'start', { value: async () => { throw Error('Fictional exit before dispatch'); } });
      const command = new DailyWorkspaceResearchService(db, daily, interrupted);
      command.capture = overall.capture;
      await assert.rejects(command.start(owner, { date: day, requestKey: 'before-dispatch' }), /Fictional exit/);
      const saved = (await overall.read(owner, day)).latest!;
      assert.equal(saved.status, 'idle');
      const [before] = await db.select().from(councilSessions).where(eq(councilSessions.id, saved.sessionId));
      await council.onModuleInit(); await simple.onApplicationBootstrap();
      await overall.start(owner, { date: day, requestKey: 'before-dispatch' });
      assert.equal((await overall.read(owner, day)).latest!.status, 'paused');
      assert.equal(prompts.length, priorCalls, 'startup, reads and receipt replay never dispatch');
      assert.equal(captures, priorCaptures + 1);
      const recovered = await simple.get(owner, saved.sessionId);
      const input = { expectedRevision: recovered.revision, requestKey: 'resume-before-dispatch' };
      await simple.resumeReport(owner, saved.sessionId, input);
      let finished = await overall.read(owner, day);
      for (let i = 0; i < 500 && ['idle', 'running'].includes(finished.latest?.status ?? ''); i++) {
        await new Promise(resolve => setTimeout(resolve, 10)); finished = await overall.read(owner, day);
      }
      assert.equal(finished.latest?.status, 'completed', finished.latest?.error ?? 'not completed');
      const [after] = await db.select().from(councilSessions).where(eq(councilSessions.id, saved.sessionId));
      assert.equal(after.checkpoint?.cycleId, before.checkpoint?.cycleId);
      assert.deepEqual(after.checkpoint?.simple?.overallDaily, before.checkpoint?.simple?.overallDaily);
      assert.equal(prompts.length - priorCalls, 5);
      await simple.resumeReport(owner, saved.sessionId, input);
      assert.equal(prompts.length - priorCalls, 5);
    });
  } finally {
    await client.end(); await admin`DROP SCHEMA IF EXISTS ${admin(namespace)} CASCADE`; await admin.end();
  }
});
