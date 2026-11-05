import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { CouncilService } from './council.service';
import { SimpleCouncilService } from './simple-council.service';
import type { CouncilMember } from '../../../shared/council.interface';
import { builderProfiles } from '../../database/schema';
import { normalizeBuilderConfig } from '../paper-trading/agent-builder.rules';
import { AutomaticResearchBudgetService } from '../paper-trading/automatic-research-budget.service';
import { councilSessions } from '../../database/council.schema';
import { eq } from 'drizzle-orm';

const team: CouncilMember[] = [
  { id: 'one', name: 'One', role: 'researcher', model: 'fast', instructions: '' },
  { id: 'two', name: 'Two', role: 'manager', model: 'fast', instructions: '' },
];
const url = process.env.COUNCIL_TEST_DATABASE_URL;
test('independent submissions stay blind in actual execution, persist, and release together', { skip: !url }, async t => {
  const namespace = `simple_council_${randomUUID().replaceAll('-', '')}`;
  const admin = postgres(url!, { max: 1, onnotice: () => {} });
  const client = postgres(url!, { max: 6, onnotice: () => {}, connection: { search_path: namespace } });
  try {
    await admin`CREATE SCHEMA ${admin(namespace)}`;
    for (const file of readdirSync('scripts/db').filter(name => /^\d+.*\.sql$/u.test(name) && !name.startsWith('02_') && Number(name.slice(0, 2)) <= 33).sort()) {
      try { await client.unsafe(readFileSync(`scripts/db/${file}`, 'utf8')); }
      catch (error) { throw new Error(`Migration ${file}`, { cause: error }); }
    }
    const owner = randomUUID();
    await client`INSERT INTO users (id,username,password_hash) VALUES (${owner}, 'simple-fixture', 'fixture')`;
    let calls = 0;
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const prompts: string[] = [];
    const llm = { validateConnectionIds: async () => {}, isConfigured: async () => true,
      chatFastJSON: async (prompt: Array<{ content: string }>) => {
        prompts.push(JSON.stringify(prompt)); calls++;
        if (calls === 2) { enter(); await blocked; }
        return { data: { content: calls === 1 ? 'PRIVATE_FIRST_CONCLUSION' : 'Public research.', evidenceIds: [], researchStance: 'balanced' }, tokens: 2 };
      } };
    const service = new CouncilService(drizzle(client), llm as never,
      { collectEvidence: async () => [] } as never,
      { getPortfolioContext: async () => ({ totalValue: 0, cash: 0, holdings: [] }) } as never,
      { listRuns: async () => ({ items: [] }) } as never);
    const initial = await Reflect.apply(service.createSession, service, [owner, { ticker: 'AAPL', members: team, language: 'en' }, { independent: true }]);
    await service.runSession(owner, initial.id);
    await entered;
    const partial = await service.getSession(owner, initial.id);
    const leaked = JSON.stringify(partial).includes('PRIVATE_FIRST_CONCLUSION');
    release();
    for (let i = 0; i < 300; i++) {
      const result = await service.getSession(owner, initial.id);
      if (result.status !== 'running') break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(leaked, false, 'public projection must not publish the first member before the barrier');
    assert.equal(prompts[1].includes('PRIVATE_FIRST_CONCLUSION'), false, 'second initial prompt cannot see the first conclusion');
    const final = await service.getSession(owner, initial.id);
    assert.equal(final.status, 'completed');
    const [stored] = await client`SELECT checkpoint FROM council_sessions WHERE id=${initial.id}`;
    assert.equal(stored.checkpoint.simple.stage, 'completed');
    assert.deepEqual(stored.checkpoint.simple.outcome.confirmed, [], 'agreement is not source verification');
    assert.deepEqual(final.messages.filter(message => message.memberId).map(message => message.phase), ['opening', 'opening', 'summary']);
    const submissions = await client`SELECT * FROM council_independent_submissions WHERE owner=${owner}`;
    assert.equal(submissions.length, 2);
    assert.ok(submissions.every(row => row.released_at));
    await assert.rejects(client`UPDATE council_independent_submissions SET contribution='{}' WHERE owner=${owner}`, /immutable/u);

    await t.test('fresh simple stock research freezes one common provider snapshot before either initial submission', async () => {
      const db = drizzle(client);
      const seen: Array<{ phase: string; evidence: Array<{ id: string; content: string }> }> = [];
      let collections = 0;
      const model = { validateConnectionIds: async () => {}, isConfigured: async () => true,
        chatFastJSON: async (prompt: Array<{ content: string }>) => {
          seen.push(JSON.parse(prompt[1].content));
          return { data: { content: 'A public research response.', evidenceIds: [] }, tokens: 1 };
        } };
      const evidence = { collectEvidence: async (ticker: string, actualOwner: string, _portfolio: unknown, _language: unknown, options: { webResearch: boolean }) => {
        collections++; assert.equal(ticker, 'AAPL'); assert.equal(actualOwner, owner); assert.equal(options.webResearch, false);
        return ['QUOTE_FACT', 'FINANCIAL_FACT', 'NEWS_FACT'].map((content, index) => ({ content, title: content, role: 'fundamental',
          evidenceType: index === 0 ? 'price' : 'other', relevanceScore: 1, sourceName: 'Fixture provider' }));
      } };
      const council = new CouncilService(db, model as never, evidence as never,
        { getPortfolioContext: async () => ({ totalValue: 1000, cash: 1000, holdings: [] }) } as never, {} as never);
      const frozen = { id: 'owner-context', title: 'Owner context', content: 'FROZEN_OWNER_CONTEXT', role: 'fundamental' as const,
        evidenceType: 'other' as const, relevanceScore: 1, sourceName: 'Frozen owner context', sourceUrl: null, fetchedAt: new Date().toISOString() };
      const initial = await council.createSession(owner, { ticker: 'AAPL', members: team, webResearch: true }, { independent: true });
      const [row] = await db.select().from(councilSessions).where(eq(councilSessions.id, initial.id));
      await db.update(councilSessions).set({ evidenceSnapshot: [frozen], checkpoint: { ...row.checkpoint!, simple: {
        ...row.checkpoint!.simple!, commonEvidence: [frozen],
      } } }).where(eq(councilSessions.id, initial.id));
      await council.runSession(owner, initial.id);
      for (let i = 0; i < 300; i++) {
        if ((await council.getSession(owner, initial.id)).status !== 'running') break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.equal(collections, 1, 'a populated owner context must not suppress provider facts');
      assert.deepEqual(seen[0].evidence, seen[1].evidence, 'all initial members receive the identical frozen fact IDs and content');
      for (const marker of ['FROZEN_OWNER_CONTEXT', 'QUOTE_FACT', 'FINANCIAL_FACT', 'NEWS_FACT']) assert.ok(JSON.stringify(seen[0]).includes(marker));
      for (const scene of ['period_strategy', 'portfolio_daily', 'trade_post_review'] as const) {
        const topic = await council.createSession(owner, { scene, ticker: scene === 'trade_post_review' ? 'AAPL' : undefined, subject: 'Existing frozen context', members: team }, { independent: true });
        const [topicRow] = await db.select().from(councilSessions).where(eq(councilSessions.id, topic.id));
        await db.update(councilSessions).set({ evidenceSnapshot: [frozen], checkpoint: { ...topicRow.checkpoint!, simple: {
          ...topicRow.checkpoint!.simple!, commonEvidence: [frozen],
        } } }).where(eq(councilSessions.id, topic.id));
        await council.runSession(owner, topic.id);
        for (let i = 0; i < 300; i++) {
          if ((await council.getSession(owner, topic.id)).status !== 'running') break;
          await new Promise(resolve => setTimeout(resolve, 10));
        }
      }
      assert.equal(collections, 1, 'generic, portfolio and historical decision discussions never fetch fresh stock facts');
    });

    await t.test('a question appended during the summary is answered at the next safe step', async () => {
      let summaryEntered!: () => void; let continueSummary!: () => void;
      const awaitingSummary = new Promise<void>(resolve => { summaryEntered = resolve; });
      const summaryGate = new Promise<void>(resolve => { continueSummary = resolve; });
      const seen: string[] = [];
      const model = { validateConnectionIds: async () => {}, isConfigured: async () => true,
        getExecutionInfo: async () => ({ provider: 'fixture', modelFast: 'fixture-model' }),
        chatFastJSON: async (prompt: Array<{ content: string }>) => {
          seen.push(JSON.stringify(prompt));
          if (seen.length === 2) { summaryEntered(); await summaryGate; }
          return { data: { content: 'Public response', evidenceIds: [] }, tokens: 1 };
        } };
      const council = new CouncilService(drizzle(client), model as never, {} as never, {} as never, {} as never);
      const simple = new SimpleCouncilService(drizzle(client), council, model as never);
      const conversation = await simple.create(owner, { message: 'Original question', requestKey: 'summary-steering' });
      if (!('id' in conversation)) throw new Error('Unexpected clarification');
      await awaitingSummary;
      await simple.addMessage(owner, conversation.id, { message: 'LATE_SUMMARY_QUESTION', requestKey: 'summary-followup' });
      continueSummary();
      for (let i = 0; i < 300; i++) {
        const result = await simple.get(owner, conversation.id);
        if (result.status !== 'running') break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.equal(seen.length, 3, 'the outdated summary must be replaced with one responding to the late question');
      assert.equal(seen[2].includes('LATE_SUMMARY_QUESTION'), true);
    });

    await t.test('specific claim challenges get public responses and stop after two unsuccessful supplements', async () => {
      let requestCount = 0;
      const phases: string[] = [];
      const model = { validateConnectionIds: async () => {}, isConfigured: async () => true,
        chatFastJSON: async (prompt: Array<{ content: string }>) => {
          requestCount++;
          const input = JSON.parse(prompt[1].content);
          phases.push(input.phase);
          const claimId = input.publicClaims?.[0]?.id;
          return { data: { content: 'Evidence remains insufficient.', evidenceIds: [],
            claims: [{ id: `claim-${requestCount}`, statement: 'Recurring margin remains uncertain.', evidenceIds: [] }],
            questions: input.phase === 'opening' ? ['Can recurring margin be established from a filing?'] : [],
            ...(claimId && input.phase !== 'summary' ? { respondsToClaims: [claimId], stanceChange: { status: 'unconfirmed', reason: 'No new verified evidence.' },
              researchRequests: [{ kind: 'financials' }] } : {}) }, tokens: 1 };
        } };
      const council = new CouncilService(drizzle(client), model as never, { collectEvidence: async () => [], collectResearch: async () => [] } as never,
        { getPortfolioContext: async () => ({ totalValue: 0, cash: 0, holdings: [] }) } as never, {} as never);
      const initial = await council.createSession(owner, { ticker: 'AAPL', members: team }, { independent: true });
      await council.runSession(owner, initial.id);
      let final = initial;
      for (let i = 0; i < 400; i++) {
        final = await council.getSession(owner, initial.id);
        if (final.status !== 'running') break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.equal(final.status, 'completed');
      const [stored] = await client`SELECT checkpoint FROM council_sessions WHERE id=${initial.id}`;
      assert.equal(stored.checkpoint.simple.supplementRounds, 2);
      assert.ok(requestCount <= 12);
      assert.ok(phases.includes('response'));
      assert.ok(final.messages.some(item => item.respondsToClaims?.length && item.stanceChange?.status === 'unconfirmed'));
      assert.equal(final.reports.at(-1)?.decision, 'wait');
      assert.equal(stored.checkpoint.simple.outcome.currentAction, 'research_more');
    });

    await t.test('offline members receive no fabricated message and a restart never replays an uncertain initial model call', async () => {
      let calls = 0;
      const model = { validateConnectionIds: async () => {}, isConfigured: async () => true,
        chatFastJSON: async () => { calls++; return { data: { content: 'Actual available member output', evidenceIds: [] }, tokens: 1 }; } };
      const council = new CouncilService(drizzle(client), model as never, { collectEvidence: async () => [] } as never,
        { getPortfolioContext: async () => ({ totalValue: 0, cash: 0, holdings: [] }) } as never, {} as never);
      const initial = await council.createSession(owner, { ticker: 'AAPL', members: team }, { independent: true });
      await client`UPDATE council_sessions SET status='running', checkpoint=jsonb_set(checkpoint,'{inflight}',${JSON.stringify({ id: randomUUID(), turn: 0, revision: 1 })}::jsonb) WHERE id=${initial.id}`;
      await council.onModuleInit();
      await council.runSession(owner, initial.id);
      let final = initial;
      for (let i = 0; i < 300; i++) {
        final = await council.getSession(owner, initial.id);
        if (final.status !== 'running') break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.equal(final.status, 'completed');
      assert.equal(calls, 2, 'only the second initial source and its real summary run');
      assert.equal(final.messages.filter(item => item.memberId === 'one').length, 0);
      const [stored] = await client`SELECT checkpoint FROM council_sessions WHERE id=${initial.id}`;
      assert.equal(stored.checkpoint.simple.unavailable[0].memberId, 'one');
    });

    await t.test('automatic candidate review shares the same task and reserves every real Council call', async () => {
      const db = drizzle(client);
      const automatic = new AutomaticResearchBudgetService(db);
      const task = await automatic.claimAutomaticResearch(owner, null, 'automatic-review', 'candidate-review');
      assert.ok(task.taskId);
      const config = normalizeBuilderConfig({ name: 'Review fixture', template: 'guard', tickers: ['AAPL'], minimumRating: 'Buy', customPrompt: '',
        maxOrderPct: 5, dailyLossLimitPct: 3, maxOrdersPerDay: 1, notifyOnProposal: false, priceRules: [], council: { enabled: true, members: team } });
      const [profile] = await db.insert(builderProfiles).values({ owner, config }).returning();
      let calls = 0;
      const model = { validateConnectionIds: async () => {}, isConfigured: async () => true,
        chatFastJSON: async () => { calls++; return { data: { content: 'Wait for verified evidence.', evidenceIds: [], decision: 'wait', dissent: [], nextReviewCondition: 'Verified filing' }, tokens: 1 }; } };
      const council = new CouncilService(db, model as never, { collectEvidence: async () => [] } as never,
        { getPortfolioContext: async () => ({ totalValue: 1000, cash: 1000, holdings: [] }) } as never, { listRuns: async () => ({ items: [] }) } as never);
      await council.reviewCandidate(owner, { ...profile, createdAt: profile.createdAt.toISOString(), updatedAt: profile.updatedAt.toISOString() } as never,
        { ticker: 'AAPL', side: 'buy', quantity: 1, price: 10, reason: 'A fixture candidate' }, { automaticTaskId: task.taskId } as never);
      const [stored] = await client`SELECT calls,state FROM automatic_research_tasks WHERE id=${task.taskId}`;
      assert.equal(stored.calls, calls);
      assert.equal(stored.state, 'completed');
      assert.ok(calls > 0);
    });
  } finally {
    await client.end(); await admin`DROP SCHEMA IF EXISTS ${admin(namespace)} CASCADE`; await admin.end();
  }
});
