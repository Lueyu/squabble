import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { councilSessions } from '../../database/council.schema';
import { councilResearchTasks } from '../../database/research-workflow.schema';
import { llmBudgetUsage } from '../../database/llm-budget.schema';
import type { ResearchDelivery, ResearchTaskAttempt, ResearchTaskKind, ResearchTaskState } from '../../../shared/research-workflow.interface';
import { LlmBudgetService } from '../llm-budget/llm-budget.service';
import { pinResearchSkills } from '../research-skills/research-skills.registry';
import { CouncilService } from './council.service';
import { DEFAULT_MEMBERS } from './council.rules';
import { planResearchTasks } from './council.tasks';
import { CouncilWorkflowStore } from './council.workflow-store';

const url = process.env.COUNCIL_TEST_DATABASE_URL;
interface Input {
  task: { id: string; key: ResearchTaskKind };
  submitted?: object | Array<{ taskId: string; submittedAttemptId: string }>;
  skills: ResearchDelivery['skillVersions'];
  evidence: Array<{ id: string }>;
}
const delivery = (key: ResearchTaskKind, skills: ResearchDelivery['skillVersions']): ResearchDelivery => ({
  conclusion: `${key} finding`, evidenceIds: ['filing'], asOf: '2026-01-01', currency: 'USD', units: 'USD million',
  assumptions: [], gaps: [], skillVersions: skills,
  response: { thesis: `${key} finding`, evidencePoints: ['Reported annual figures'], risks: ['Demand risk'], nextChecks: ['Next filing'] },
});
const attempt = (kind: ResearchTaskAttempt['kind'], state: ResearchTaskAttempt['state']): ResearchTaskAttempt => ({
  id: randomUUID(), messageId: randomUUID(), revision: 1, kind, state, startedAt: new Date().toISOString(),
});

async function fixture(parallelism: 1 | 2, exercise: (context: {
  service: CouncilService; store: CouncilWorkflowStore; owner: string; id: string; calls: Input[];
  db: ReturnType<typeof drizzle>; budget: LlmBudgetService;
  seed(financialState: ResearchTaskState, failedReview?: boolean): Promise<void>;
  onCall(callback: (input: Input) => Promise<void>): void;
  execute(): Promise<void>;
}) => Promise<void>) {
  const namespace = `workflow_resume_${randomUUID().replaceAll('-', '')}`;
  const admin = postgres(url!, { max: 1, onnotice: () => {} });
  const client = postgres(url!, { max: 8, onnotice: () => {}, connection: { search_path: namespace } });
  await admin`CREATE SCHEMA ${admin(namespace)}`;
  try {
    for (const name of ['01_schema.sql', '03_agent_builder.sql', '07_llm_budget.sql', '08_investment_council.sql',
      '12_council_dialogue.sql', '13_budget_toggle.sql', '14_a2a_agents.sql', '15_native_agents.sql', '18_research_workflow.sql']) {
      await client.unsafe(readFileSync(`scripts/db/${name}`, 'utf8'));
    }
    const db = drizzle(client), budget = new LlmBudgetService(db), store = new CouncilWorkflowStore(db);
    const owner = randomUUID(), calls: Input[] = [];
    await client`INSERT INTO users(id, username, password_hash) VALUES (${owner}, 'resume-test', 'test-only')`;
    let onCall = async (_input: Input) => {};
    const model = async (messages: Array<{ role: string; content: string }>, user: string, options: { taskId: string; maxOutputTokens: number }) => {
      const input: Input = JSON.parse(messages[1].content);
      const reservation = await budget.reserve(user, { ...options, model: 'offline-fixture', messages });
      calls.push(input);
      try {
        await onCall(input);
        const data = Array.isArray(input.submitted) ? { reviews: input.submitted.map(submitted => ({
          taskId: submitted.taskId, submittedAttemptId: submitted.submittedAttemptId, accepted: true,
          feedback: `Checked submission for ${submitted.taskId}`,
        })) } : input.submitted ? { accepted: true, feedback: `Checked ${input.task.key} finding` }
          : { ...delivery(input.task.key, input.skills), evidenceIds: input.evidence.map(item => item.id) };
        await budget.settle(user, reservation.id, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
        return { data, tokens: 15 };
      } catch (error) {
        await budget.settle(user, reservation.id, { prompt_tokens: 10, completion_tokens: 0, total_tokens: 10 }, true);
        throw error;
      }
    };
    const service = new CouncilService(db, { validateConnectionIds: async () => undefined, isConfigured: async () => true,
      chatFastJSON: model, chatSlowJSON: model } as never, {} as never, {} as never, {} as never, undefined, budget);
    const session = await service.createSession(owner, { ticker: 'AAPL', language: 'en', goal: 'comprehensive', parallelism, recallEnabled: false });
    const [row] = await db.update(councilSessions).set({ status: 'running', evidenceSnapshot: [{ id: 'filing',
      role: 'fundamental', evidenceType: 'financial', title: 'Fictional annual filing', content: 'Annual revenue USD 100 million.',
      sourceName: 'Fixture', sourceUrl: 'https://example.test/filing', fetchedAt: new Date().toISOString(), relevanceScore: 1 }] })
      .where(eq(councilSessions.id, session.id)).returning();
    await store.initialize(row, planResearchTasks('comprehensive', DEFAULT_MEMBERS), pinResearchSkills);
    await exercise({ service, store, owner, id: session.id, calls, db, budget, onCall: callback => { onCall = callback; },
      execute: () => service['workflow'].execute(owner, session.id),
      seed: async (financialState, failedReview = false) => {
        const tasks = await store.list(owner, session.id, row.checkpoint!.cycleId);
        const financial = tasks.find(task => task.key === 'financials')!, business = tasks.find(task => task.key === 'business')!;
        const financialAttempt = attempt('work', financialState === 'running' ? 'running' : financialState === 'accepted' ? 'succeeded' : 'failed');
        await db.update(councilResearchTasks).set({ state: financialState,
          attempts: financialState === 'queued' ? [] : [financialAttempt],
          ...(financialState === 'accepted' ? { delivery: delivery('financials', financial.skills), acceptedAttemptId: financialAttempt.id } : {}) })
          .where(eq(councilResearchTasks.id, financial.id));
        await db.update(councilResearchTasks).set({ state: failedReview ? 'failed' : 'submitted',
          delivery: delivery('business', business.skills), attempts: [attempt('work', 'succeeded'), ...(failedReview ? [attempt('review', 'failed')] : [])] })
          .where(eq(councilResearchTasks.id, business.id));
        // A completed business draft has already used one of the default eight calls.
        const priorCalls = failedReview ? 3 : 1;
        if (failedReview) await budget.saveSettings(owner, { ...await budget.getSettings(owner), maxCallsPerTask: priorCalls + 7 });
        for (let i = 0; i < priorCalls; i++) {
          const reservation = await budget.reserve(owner, { taskId: row.taskId, model: 'offline-fixture', messages: [{ role: 'user', content: 'Prior attempt' }] });
          await budget.settle(owner, reservation.id, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
        }
      },
    });
  } finally { await client.end(); await admin`DROP SCHEMA ${admin(namespace)} CASCADE`; await admin.end(); }
}

for (const parallelism of [1, 2] as const) {
  test(`mixed resumed opening drafts share one review with parallelism ${parallelism}`, { skip: !url }, async () => {
    await fixture(parallelism, async ({ service, owner, id, calls, db, seed, execute }) => {
      await seed('queued');
      await execute();
      const completed = await service.getSession(owner, id);
      assert.equal(completed.status, 'completed', 'seven remaining calls must complete the graph');
      assert.equal(calls.length, 7);
      const reviews = calls.filter(input => Array.isArray(input.submitted));
      assert.equal(reviews.length, 1);
      assert.equal((reviews[0].submitted as unknown[]).length, 2);
      const openings = completed.workflow!.tasks.filter(task => ['financials', 'business'].includes(task.key));
      for (const task of openings) {
        assert.equal(task.state, 'accepted');
        assert.equal(task.attempts.at(-1)?.review?.accepted, true);
        assert.equal(task.attempts.at(-1)?.review?.feedback, `Checked submission for ${task.id}`);
      }
      assert.equal(openings[0].attempts.at(-1)?.reviewGroupId, openings[1].attempts.at(-1)?.reviewGroupId);
      assert.ok(openings[0].attempts.at(-1)?.reviewGroupId);
      assert.equal((await db.select().from(llmBudgetUsage)).length, 8);
      assert.equal(completed.reports.at(-1)?.coverage?.complete, true);
    });
  });
}

test('explicit resume rebases failed work and failed review into one opening review', { skip: !url }, async () => {
  await fixture(2, async ({ service, owner, id, calls, db, seed }) => {
    await seed('failed', true);
    await db.update(councilSessions).set({ status: 'paused' }).where(eq(councilSessions.id, id));
    await service.runSession(owner, id);
    await service['jobs'].get(`${owner}:${id}`);
    const completed = await service.getSession(owner, id);
    assert.equal(completed.status, 'completed', 'execution must honor the seven-call preflight estimate');
    assert.equal(calls.length, 7);
    assert.equal(completed.workflow!.tasks.find(task => task.key === 'business')!.attempts.filter(a => a.kind === 'work').length, 1);
    assert.equal(completed.reports.at(-1)?.coverage?.complete, true);
  });
});

test('a pending counterpart failure releases the surviving opening draft for solo review', { skip: !url }, async () => {
  await fixture(2, async ({ service, owner, id, calls, seed, onCall, execute }) => {
    await seed('queued');
    onCall(async input => { if (input.task.key === 'financials') throw new Error('LLM_REQUEST_TIMEOUT'); });
    await execute();
    const completed = await service.getSession(owner, id);
    assert.equal(completed.status, 'completed');
    assert.equal(completed.workflow!.tasks.find(task => task.key === 'financials')!.state, 'failed');
    assert.equal(completed.workflow!.tasks.find(task => task.key === 'business')!.state, 'accepted');
    assert.equal(completed.reports.at(-1)?.coverage?.complete, false);
    assert.deepEqual(calls.map(input => `${input.task.key}:${input.submitted ? 'review' : 'work'}`), ['financials:work', 'business:review', 'summary:work']);
    assert.ok(calls.every(input => !Array.isArray(input.submitted)));
  });
});

for (const state of ['failed', 'blocked', 'accepted', 'cancelled', 'uncertain'] as const) {
  test(`counterpart state ${state} does not hold the surviving opening review`, { skip: !url }, async () => {
    await fixture(1, async ({ service, owner, id, calls, seed, execute }) => {
      await seed(state);
      await execute();
      const completed = await service.getSession(owner, id);
      assert.equal(completed.status, 'completed');
      assert.equal(completed.workflow!.tasks.find(task => task.key === 'business')!.state, 'accepted');
      assert.equal(calls[0].task.key, 'business');
      assert.ok(calls[0].submitted && !Array.isArray(calls[0].submitted));
    });
  });
}

test('revision cancellation preserves the deferred draft without dispatching its review', { skip: !url }, async () => {
  await fixture(2, async ({ service, owner, id, calls, seed, onCall, execute }) => {
    await seed('needs_revision');
    onCall(async input => { if (input.task.key === 'financials') await service.pauseSession(owner, id); });
    await execute();
    const paused = await service.getSession(owner, id);
    assert.equal(paused.status, 'paused');
    assert.deepEqual(calls.map(input => input.task.key), ['financials']);
    const business = paused.workflow!.tasks.find(task => task.key === 'business')!;
    assert.equal(business.state, 'submitted');
    assert.equal(business.attempts.length, 1);
    assert.equal(business.delivery?.conclusion, 'business finding');
    assert.equal(paused.workflow!.tasks.find(task => task.key === 'financials')!.attempts.at(-1)?.state, 'cancelled');
    assert.equal(paused.reports.length, 0);
  });
});
