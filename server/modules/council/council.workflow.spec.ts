import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { and, eq } from 'drizzle-orm';
import { CouncilService } from './council.service';
import { councilResearchTasks } from '../../database/research-workflow.schema';
import { councilSessions } from '../../database/council.schema';
import { DEFAULT_MEMBERS } from './council.rules';
import { LlmBudgetService } from '../llm-budget/llm-budget.service';
import { ResearchToolsService } from '../research-tools/research-tools.service';
import { CouncilWorkflowStore } from './council.workflow-store';
import type { CouncilSession } from '../../../shared/council.interface';
import type { ResearchTaskKind } from '../../../shared/research-workflow.interface';

const url = process.env.COUNCIL_TEST_DATABASE_URL;
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
interface Input { task: { key: ResearchTaskKind; id: string }; submitted?: unknown; handoffs?: unknown; skills: { id: string; version: string; hash: string }[];
  evidence: { id: string }[]; steering: string[] }
const output = (input: Input) => input.submitted ? Array.isArray(input.submitted)
  ? { reviews: input.submitted.map(s => ({ taskId: s.taskId, submittedAttemptId: s.submittedAttemptId, accepted: true, feedback: 'Evidence and scope checked.' })) }
  : { accepted: true, feedback: 'Evidence and scope checked.' } : {
  conclusion: `${input.task.key} finding`, evidenceIds: input.evidence.map(e => e.id).slice(0, 3),
  asOf: new Date().toISOString(), currency: 'USD', units: 'USD million', assumptions: [], gaps: [],
  skillVersions: input.skills.map(({ id, version, hash }) => ({ id, version, hash })),
  response: { thesis: `${input.task.key} finding`, evidencePoints: ['Supported observation'], risks: ['Demand risk'], nextChecks: ['Next filing'] },
  ...(input.task.key === 'valuation' ? { valuationScenario: { metric: 'earnings', multiples: { bear: 10, base: 15, bull: 20 } } } : {}),
};

test('durable workflow executes parallel work, reviews, partial failure and targeted retry without discarding accepted branches', { skip: !url }, async () => {
  const namespace = `workflow_test_${randomUUID().replaceAll('-', '')}`;
  const admin = postgres(url!, { max: 1, onnotice: () => {} });
  const client = postgres(url!, { max: 8, onnotice: () => {}, connection: { search_path: namespace } });
  await admin`CREATE SCHEMA ${admin(namespace)}`;
  try {
    for (const name of ['01_schema.sql', '03_agent_builder.sql', '07_llm_budget.sql', '08_investment_council.sql',
      '12_council_dialogue.sql', '13_budget_toggle.sql', '14_a2a_agents.sql', '15_native_agents.sql', '18_research_workflow.sql']) await client.unsafe(readFileSync(`scripts/db/${name}`, 'utf8'));
    const db = drizzle(client);
    const owner = randomUUID();
    await client`INSERT INTO users(id, username, password_hash) VALUES (${owner}, 'workflow-test', 'test-only')`;
    let active = 0, maximum = 0, failFinancials = false, rejectFinancials = 0;
    const calls: string[] = [];
    const summaryHandoffs: string[] = [];
    let releaseHeld: (() => void) | undefined;
    let holdFinancials = false;
    let parallelProbe = true, openings = 0;
    let releaseOpenings!: () => void;
    const openingBarrier = new Promise<void>(resolve => { releaseOpenings = resolve; });
    const model = async (prompt: { content: string }[]) => {
      const input: Input = JSON.parse(prompt[1].content);
      const key = `${input.task.key}:${input.submitted ? 'review' : 'work'}`;
      if (input.task.key === 'summary') summaryHandoffs.push(JSON.stringify(input.handoffs));
      calls.push(key); active++; maximum = Math.max(maximum, active);
      try {
        if (parallelProbe && ['financials:work', 'business:work'].includes(key)) {
          if (++openings === 2) releaseOpenings();
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('Independent research did not start concurrently')), 5000);
            void openingBarrier.then(() => { clearTimeout(timer); resolve(); });
          });
        }
        if (holdFinancials && key === 'financials:work') await new Promise<void>(resolve => { releaseHeld = resolve; });
        await pause(10);
        if (failFinancials && key === 'financials:work') throw new Error('LLM_REQUEST_TIMEOUT');
        if (rejectFinancials && key === 'financials:review') {
          rejectFinancials--;
          const data = output(input);
          return { data: 'reviews' in data ? { reviews: data.reviews!.map((r, i) => i === 0 ? { ...r, accepted: false, feedback: 'Verify the reporting period.' } : r) }
            : { accepted: false, feedback: 'Verify the reporting period.' }, tokens: 5 };
        }
        return { data: output(input), tokens: 5 };
      } finally { active--; }
    };
    const svc = new CouncilService(db, { validateConnectionIds: async () => undefined, isConfigured: async () => true,
      chatFastJSON: model, chatSlowJSON: model } as never,
    { collectEvidence: async () => [{ role: 'fundamental', evidenceType: 'other', title: 'Annual financial filing',
      content: 'Annual revenue 100 USD million; net income 10 USD million.', sourceName: 'Filing', sourceUrl: 'https://example.test/filing', relevanceScore: 1 }] } as never,
    { getPortfolioContext: async () => ({ totalValue: 1000, holdings: [], cash: 1000 }) } as never,
    { listRuns: async () => ({ items: [] }) } as never);
    const waitFor = async (id: string, predicate: (session: CouncilSession) => boolean = s => s.status !== 'running') => {
      for (let i = 0; i < 500; i++) { const session = await svc.getSession(owner, id); if (predicate(session)) return session; await pause(10); }
      throw new Error('Workflow did not reach expected state');
    };
    const create = () => svc.createSession(owner, { ticker: 'AAPL', language: 'en', goal: 'comprehensive', recallEnabled: false });
    const first = await create();
    await svc.runSession(owner, first.id);
    const complete = await waitFor(first.id);
    assert.equal(complete.status, 'completed');
    assert.equal(maximum, 2);
    assert.equal(calls.length, 8, 'two initial drafts share one call with separate review verdicts');
    parallelProbe = false;
    assert.ok(complete.workflow!.tasks.every(t => t.state === 'accepted' && t.acceptedAttemptId));
    assert.equal(complete.reports.at(-1)?.coverage?.complete, true);
    assert.ok(complete.messages.filter(m => m.role !== 'system').every(m => m.response));
    assert.deepEqual((await svc.listSessions(randomUUID())), []);

    failFinancials = true; calls.length = 0;
    const second = await create(); await svc.runSession(owner, second.id);
    const partial = await waitFor(second.id);
    assert.equal(partial.reports.at(-1)?.coverage?.complete, false);
    assert.equal(partial.workflow!.tasks.find(t => t.key === 'business')?.state, 'accepted');
    assert.equal(calls.filter(c => c === 'financials:work').length, 1, 'execution failure cannot automatically retry');
    const businessCalls = calls.filter(c => c.startsWith('business:')).length;
    const failed = partial.workflow!.tasks.find(t => t.key === 'financials')!;
    failFinancials = false;
    await svc.retryTask(owner, second.id, failed.id);
    const recovered = await waitFor(second.id);
    assert.equal(recovered.reports.at(-1)?.coverage?.complete, true);
    assert.equal(calls.filter(c => c.startsWith('business:')).length, businessCalls);
    assert.equal(recovered.workflow!.tasks.find(t => t.id === failed.id)?.attempts.filter(a => a.kind === 'work').length, 2);

    rejectFinancials = 2; calls.length = 0;
    const third = await create(); await svc.runSession(owner, third.id);
    const rejected = await waitFor(third.id);
    assert.equal(rejected.reports.at(-1)?.coverage?.complete, false);
    assert.equal(calls.filter(c => c === 'financials:work').length, 2, 'only one business rework is allowed');
    assert.equal(rejected.workflow!.tasks.find(t => t.key === 'financials')?.reworks, 1);

    holdFinancials = true; calls.length = 0;
    const fourth = await create(); await svc.runSession(owner, fourth.id);
    await waitFor(fourth.id, () => Boolean(releaseHeld));
    await svc.pauseSession(owner, fourth.id);
    const resuming = await svc.runSession(owner, fourth.id);
    holdFinancials = false; releaseHeld!();
    const resumed = await waitFor(fourth.id);
    assert.equal(resumed.reports.at(-1)?.coverage?.complete, true);
    const old = resumed.workflow!.tasks.find(t => t.key === 'financials')!.attempts[0];
    assert.equal(old.state, 'cancelled');
    assert.ok(resumed.messages.filter(m => m.role === 'researcher').every(m => m.revision === resuming.revision));

    const restart = await create();
    await db.update(councilSessions).set({ status: 'running' }).where(eq(councilSessions.id, restart.id));
    await db.insert(councilResearchTasks).values({ owner, sessionId: restart.id, cycleId: randomUUID(), revision: 1,
      key: 'financials', position: 0, memberId: DEFAULT_MEMBERS[0].id, dependencies: [], skills: [], state: 'running',
      attempts: [{ id: randomUUID(), messageId: randomUUID(), kind: 'work', revision: 1, startedAt: new Date().toISOString(), state: 'running', dispatched: true }] });
    const beforeRecovery = calls.length;
    await svc.onModuleInit();
    assert.equal((await svc.getSession(owner, restart.id)).status, 'paused');
    const [recoveredTask] = await db.select().from(councilResearchTasks).where(and(eq(councilResearchTasks.owner, owner), eq(councilResearchTasks.sessionId, restart.id)));
    assert.equal(recoveredTask.state, 'uncertain');
    assert.equal(recoveredTask.attempts[0].state, 'uncertain');
    assert.equal(calls.length, beforeRecovery, 'restart recovery is not a paid retry');

    const [rebasedRow] = await db.update(councilSessions).set({ status: 'running', revision: 3 })
      .where(eq(councilSessions.id, restart.id)).returning();
    await db.update(councilResearchTasks).set({ cycleId: rebasedRow.checkpoint!.cycleId }).where(eq(councilResearchTasks.id, recoveredTask.id));
    let rebasing = Promise.resolve();
    await db.transaction(async tx => {
      await tx.select().from(councilSessions).where(eq(councilSessions.id, restart.id)).for('update');
      rebasing = new CouncilWorkflowStore(db).rebase(owner, rebasedRow);
      await pause(50);
      await tx.update(councilResearchTasks).set({ attempts: recoveredTask.attempts.map(a => ({ ...a,
        tokens: 37, externalAgent: true, externalUsageUnknown: false, remoteTaskId: 'retained-remote-task' })) })
        .where(eq(councilResearchTasks.id, recoveredTask.id));
    });
    await rebasing;
    const [rebasedTask] = await db.select().from(councilResearchTasks).where(eq(councilResearchTasks.id, recoveredTask.id));
    assert.equal(rebasedTask.attempts[0].tokens, 37, 'rebase must read attempts after obtaining the session lock');
    assert.equal(rebasedTask.attempts[0].externalUsageUnknown, false);
    assert.equal(rebasedTask.attempts[0].remoteTaskId, 'retained-remote-task');

    const budgetService = new LlmBudgetService(db);
    await budgetService.saveSettings(owner, { ...await budgetService.getSettings(owner), maxCallsPerTask: 7 });
    const budgeted = new CouncilService(db, svc['llm'], svc['evidence'], svc['portfolio'], svc['research'], undefined, budgetService);
    const overBudget = await budgeted.createSession(owner, { ticker: 'MSFT', goal: 'comprehensive', language: 'en', recallEnabled: false });
    const beforeBudgetCheck = calls.length;
    await assert.rejects(budgeted.runSession(owner, overBudget.id), /at least 8.*7 remaining/);
    assert.equal(calls.length, beforeBudgetCheck, 'default budget mismatch must be reported before spending any calls');
    assert.equal((await budgeted.getSession(owner, overBudget.id)).status, 'idle');
    await budgetService.saveSettings(owner, { ...await budgetService.getSettings(owner), maxCallsPerTask: 8 });
    await budgeted.runSession(owner, overBudget.id);
    assert.equal((await waitFor(overBudget.id)).reports.at(-1)!.coverage?.complete, true, 'default eight-call budget admits the full graph');

    const nativeCalls: string[] = [];
    let nativeFailure: 'quota' | 'malformed' | null = null;
    const local = { validate: async () => undefined, execute: async (_owner: string, options: {
      prompt: string; onDispatch(): Promise<void>; onTask(ref: { taskId: string; contextId: string }): Promise<void>;
    }) => {
      const input: Input = JSON.parse(options.prompt.slice(options.prompt.lastIndexOf('\n') + 1));
      nativeCalls.push(`${input.task.key}:${input.submitted ? 'review' : 'work'}`);
      await options.onDispatch();
      const taskId = randomUUID(); await options.onTask({ taskId, contextId: randomUUID() });
      if (input.task.key === 'financials' && nativeFailure === 'quota') throw new Error('LOCAL_USAGE_LIMIT');
      if (input.task.key === 'financials' && nativeFailure === 'malformed') return { taskId, text: 'invalid JSON', usageTokens: null };
      const data = input.submitted ? output(input) : { ...output(input), evidenceIds: [...input.evidence.map(e => e.id).slice(0, 3), 'source'],
        sources: [{ id: 'source', title: 'Native filing', url: 'https://example.test/filing', content: 'Annual data' }] };
      return { taskId, text: '', data, usageTokens: 7 };
    } };
    const nativeSvc = new CouncilService(db, svc['llm'], svc['evidence'], svc['portfolio'], svc['research'], local as never);
    const localMembers = DEFAULT_MEMBERS.map(m => ({ ...m, executionMode: 'local' as const, agentId: 'native-codex' }));
    const nativeSession = await nativeSvc.createSession(owner, { ticker: 'MSFT', goal: 'comprehensive', language: 'en', recallEnabled: false, members: localMembers });
    await nativeSvc.runSession(owner, nativeSession.id);
    const nativeComplete = await waitFor(nativeSession.id);
    assert.equal(nativeCalls.length, 8);
    assert.equal(nativeComplete.reports.at(-1)!.tokensUsed, 56, 'native moderator review usage must be counted once per actual request');
    assert.equal(nativeComplete.reports.at(-1)!.externalUsageUnknown, false);

    nativeCalls.length = 0; nativeFailure = 'quota';
    const limited = await nativeSvc.createSession(owner, { ticker: 'MSFT', goal: 'comprehensive', language: 'en', recallEnabled: false, members: localMembers });
    await nativeSvc.runSession(owner, limited.id);
    const stopped = await waitFor(limited.id);
    assert.equal(stopped.status, 'paused');
    assert.equal(nativeCalls.length, 1, 'quota failure blocks queued calls on the same native connection');
    assert.equal(stopped.reports.length, 0, 'unavailable moderator does not fabricate a report');

    nativeFailure = 'malformed';
    const mixedMembers = DEFAULT_MEMBERS.map((m, index) => index === 0 ? { ...m, executionMode: 'local' as const, agentId: 'native-codex' } : m);
    const malformed = await nativeSvc.createSession(owner, { ticker: 'MSFT', goal: 'comprehensive', language: 'en', recallEnabled: false, members: mixedMembers });
    await nativeSvc.runSession(owner, malformed.id);
    const incomplete = await waitFor(malformed.id);
    assert.equal(incomplete.reports.at(-1)!.coverage?.complete, false);
    assert.equal(incomplete.reports.at(-1)!.externalUsageUnknown, true, 'malformed native output still has unknown external billing');

    const researchedTickers: string[] = [];
    const providerEvidence = { collectResearch: async (ticker: string) => {
      researchedTickers.push(ticker);
      return [{ role: 'fundamental', evidenceType: 'financial', title: 'Reported financials',
        content: 'Period: 2025-01-01 to 2025-12-31. Net income: USD 100; Revenue: USD 1000;',
        sourceName: 'SEC EDGAR', sourceUrl: 'https://www.sec.gov/Archives/fixture', relevanceScore: 1 }];
    } };
    const tools = new ResearchToolsService(db, { getQuote: async (ticker: string) => ({ symbol: ticker,
      price: '100', currency: 'USD', market: 'US', timestamp: Date.now() }) } as never, providerEvidence as never, {} as never);
    const withTools = new CouncilService(db, svc['llm'], svc['evidence'], svc['portfolio'], svc['research'], undefined, undefined, undefined, tools);
    const peers = await withTools.createSession(owner, { ticker: 'AAPL', peers: ['MSFT'], goal: 'peers', language: 'en', recallEnabled: false });
    await withTools.runSession(owner, peers.id);
    const compared = await waitFor(peers.id);
    assert.equal(compared.reports.at(-1)!.coverage?.complete, true);
    assert.ok(researchedTickers.includes('MSFT'), 'API-only workflow really fetches the frozen peer data');
    assert.ok(compared.reports.at(-1)!.evidence.some(e => e.content.includes('MSFT')));
    const valuation = await withTools.createSession(owner, { ticker: 'AAPL', goal: 'valuation', language: 'en', recallEnabled: false });
    await withTools.runSession(owner, valuation.id);
    const calculated = await waitFor(valuation.id);
    assert.equal(calculated.reports.at(-1)!.coverage?.complete, true);
    const valuationDelivery = calculated.workflow!.tasks.find(t => t.key === 'valuation')!.delivery!;
    assert.equal((valuationDelivery.valuation!.data as { scenarios: { equityValue: number }[] }).scenarios[1].equityValue, 1500);
    assert.ok(summaryHandoffs.at(-1)!.includes('"equityValue":1500'), 'moderator must receive structured calculated ranges, not clipped JSON evidence');
  } finally { await client.end(); await admin`DROP SCHEMA ${admin(namespace)} CASCADE`; await admin.end(); }
});
