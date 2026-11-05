import 'reflect-metadata';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { councilSessions } from '../../database/council.schema';
import { CouncilService } from './council.service';
import { newCheckpoint } from './council.dialogue';
import { LocalAgentError, type LocalAgentExecution, type LocalAgentResult } from '../local-agents/local-agents.types';
import type { CouncilMember } from '../../../shared/council.interface';
import type { NativeAgentConfiguration } from '../../../shared/local-agents.interface';

const team: CouncilMember[] = [
  { id: 'research', name: 'Research', role: 'researcher', instructions: '', model: 'fast', executionMode: 'local', agentId: 'local',
    agentSettings: { model: 'fixture/research', reasoningEffort: 'high' } },
  { id: 'manager', name: 'Manager', role: 'manager', instructions: '', model: 'slow', executionMode: 'local', agentId: 'local' },
];
const completed: LocalAgentResult = { text: '', usageTokens: null, data: {
  content: 'The agent researched the company and addressed the preceding view.',
  evidenceIds: [], reasoningSummary: ['Public rationale'], questions: [], researchStance: 'balanced',
  sources: [{ title: 'Issuer report', url: 'https://www.sec.gov/Archives/example', content: 'Agent-provided excerpt' }],
  decision: 'approve', dissent: ['Valuation uncertainty'], nextReviewCondition: 'Next earnings release',
} };

test('native council delegates research, persists task lifecycle, and preserves execution controls', {
  skip: !process.env.COUNCIL_TEST_DATABASE_URL,
}, async (t) => {
  const connection = process.env.COUNCIL_TEST_DATABASE_URL!;
  const namespace = `council_native_${randomUUID().replaceAll('-', '')}`;
  const admin = postgres(connection, { max: 1, onnotice: () => {} });
  const client = postgres(connection, { max: 8, onnotice: () => {}, connection: { search_path: namespace } });
  const owner = randomUUID();
  let created = false;
  try {
    await admin`CREATE SCHEMA ${admin(namespace)}`;
    created = true;
    for (const name of ['01_schema.sql', '03_agent_builder.sql', '07_llm_budget.sql',
      '08_investment_council.sql', '12_council_dialogue.sql', '13_budget_toggle.sql', '14_a2a_agents.sql', '15_native_agents.sql', '18_research_workflow.sql', '19_atomic_research_theses.sql', '21_research_archive_jobs.sql', '27_research_threads.sql']) {
      await client.unsafe(readFileSync(`scripts/db/${name}`, 'utf8'));
    }
    await client`INSERT INTO users (id, username, password_hash) VALUES (${owner}, 'native-fixture', 'test-only')`;
    const db = drizzle(client);
    const forbidden = async () => { throw new Error('Legacy model or evidence path must not run for delegated team'); };
    const makeService = (execute: (user: string, options: LocalAgentExecution) => Promise<LocalAgentResult>, enabled = false) =>
      new CouncilService(db, { validateConnectionIds: async (_user: string, ids: string[]) => assert.deepEqual(ids, []),
        isConfigured: forbidden, chatFastJSON: forbidden, chatSlowJSON: forbidden } as never,
      { collectEvidence: forbidden, collectResearch: forbidden } as never,
      { getPortfolioContext: forbidden } as never, { listRuns: forbidden } as never,
      { validate: async (user: string, agent: string, settings?: NativeAgentConfiguration) => {
        assert.equal(user, owner); assert.equal(agent, 'local');
        if (settings) assert.deepEqual(settings, team[0].agentSettings);
      }, execute } as never,
      { getSettings: async () => ({ enabled }) } as never);
    const done = async (service: CouncilService, id: string) => {
      for (let i = 0; i < 300; i++) {
        const session = await service.getSession(owner, id);
        if (session.status !== 'running') return session;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error('Council job did not settle');
    };
    const start = async (service: CouncilService) => {
      const session = await service.createSession(owner, { ticker: 'AAPL', language: 'en', members: team });
      await service.runSession(owner, session.id);
      return session.id;
    };

    await t.test('all native members do their own research and report unknown usage honestly', async () => {
      const calls: LocalAgentExecution[] = [];
      const service = makeService(async (_user, options) => {
        calls.push(options);
        await options.onDispatch?.();
        await options.onTask({ taskId: `task-${calls.length}`, contextId: 'context' });
        return completed;
      });
      const session = await done(service, await start(service));
      assert.equal(session.status, 'completed');
      assert.equal(calls.length, 4);
      assert.deepEqual(calls.map((call) => call.agentSettings), [team[0].agentSettings, undefined, team[0].agentSettings, undefined]);
      assert.deepEqual(session.members?.[0].agentSettings, team[0].agentSettings);
      assert.equal(session.reports.length, 1);
      assert.equal(session.reports[0].engine, 'local');
      assert.equal(session.reports[0].externalUsageUnknown, true);
      assert.equal(session.reports[0].decision, 'wait', 'standalone research cannot authorize an order');
      assert.ok(session.messages.filter((message) => message.role !== 'system').every((message) => message.externalAgent && message.externalUsageUnknown));
      assert.ok(session.reports[0].evidence.some((item) => item.sourceUrl === 'https://www.sec.gov/Archives/example'));
      const [row] = await db.select().from(councilSessions).where(eq(councilSessions.id, session.id));
      assert.deepEqual(row.profileSnapshot.council?.members[0].agentSettings, team[0].agentSettings);
      assert.ok(row.evidenceSnapshot.every((item) => item.relevanceScore === 0 && item.sourceName.includes('unverified')));
    });

    await t.test('native research leaves enabled model budgets in place', async () => {
      let calls = 0;
      const service = makeService(async () => { calls++; return completed; }, true);
      const session = await service.createSession(owner, { ticker: 'AAPL', members: team });
      await service.runSession(owner, session.id);
      assert.equal((await done(service, session.id)).status, 'completed');
      assert.equal(calls, 4);
    });

    await t.test('known task timeout resumes original task without new assignment ID', async () => {
      let timedOut = false;
      let originalMessage = '';
      let resumed = false;
      const service = makeService(async (_user, options) => {
        if (!timedOut) {
          timedOut = true; originalMessage = options.messageId;
          await options.onDispatch?.();
          await options.onTask({ taskId: 'slow-task', contextId: 'context' });
          throw new LocalAgentError('LOCAL_TIMEOUT', 'slow-task', 'context');
        }
        if (!resumed) {
          assert.equal(options.remoteTaskId, 'slow-task');
          assert.equal(options.messageId, originalMessage);
          resumed = true;
        }
        return completed;
      });
      const id = await start(service);
      assert.equal((await done(service, id)).status, 'paused');
      const [paused] = await db.select().from(councilSessions).where(eq(councilSessions.id, id));
      assert.equal(paused.checkpoint?.remote?.taskId, 'slow-task');
      await service.runSession(owner, id);
      assert.equal((await done(service, id)).status, 'completed');
      assert.equal(resumed, true);
    });

    await t.test('ambiguous dispatch is persisted and resume never resubmits paid work', async () => {
      let calls = 0;
      const service = makeService(async (_user, options) => {
        calls++;
        await options.onDispatch?.();
        throw new LocalAgentError('LOCAL_DISPATCH_UNCERTAIN');
      });
      const id = await start(service);
      assert.equal((await done(service, id)).status, 'paused');
      const [paused] = await db.select().from(councilSessions).where(eq(councilSessions.id, id));
      assert.equal(paused.checkpoint?.remote?.dispatchStarted, true);
      assert.equal(paused.checkpoint?.remote?.taskId, undefined);
      await service.runSession(owner, id);
      assert.equal((await done(service, id)).status, 'paused');
      assert.equal(calls, 1);
    });

    await t.test('discovery failure before dispatch can retry without an uncertain-send lockout', async () => {
      let attempts = 0;
      const service = makeService(async () => {
        if (++attempts === 1) throw new LocalAgentError('LOCAL_UNAVAILABLE');
        return completed;
      });
      const id = await start(service);
      assert.equal((await done(service, id)).status, 'paused');
      const [paused] = await db.select().from(councilSessions).where(eq(councilSessions.id, id));
      assert.equal(paused.checkpoint?.remote?.dispatchStarted, false);
      await service.runSession(owner, id);
      assert.equal((await done(service, id)).status, 'completed');
      assert.equal(attempts, 5);
    });

    await t.test('input-required only continues after a new user reply and uses a new message ID', async () => {
      let awaiting = false;
      let answered = false;
      let firstMessage = '';
      const service = makeService(async (_user, options) => {
        if (!awaiting) {
          awaiting = true; firstMessage = options.messageId;
          await options.onDispatch?.();
          await options.onTask({ taskId: 'question-task', contextId: 'context' });
          await options.onProgress('What investment horizon?');
          throw new LocalAgentError('LOCAL_INPUT_REQUIRED', 'question-task', 'context');
        }
        if (!answered && !options.resumeInput) throw new LocalAgentError('LOCAL_INPUT_REQUIRED', 'question-task', 'context');
        if (!answered) {
          assert.equal(options.remoteTaskId, 'question-task');
          assert.notEqual(options.messageId, firstMessage);
          assert.match(options.prompt, /Five years/);
          answered = true;
        }
        return completed;
      });
      const id = await start(service);
      assert.equal((await done(service, id)).status, 'paused');
      await service.runSession(owner, id);
      assert.equal((await done(service, id)).status, 'paused');
      assert.equal(answered, false);
      await service.addMessage(owner, id, 'Five years');
      await service.runSession(owner, id);
      assert.equal((await done(service, id)).status, 'completed');
      assert.equal(answered, true);
    });

    await t.test('restart retains the remote reference and pauses without issuing new work', async () => {
      let calls = 0;
      const service = makeService(async (_user, options) => {
        if (calls++ === 0) assert.equal(options.remoteTaskId, 'restart-task');
        return completed;
      });
      const session = await service.createSession(owner, { ticker: 'AAPL', members: team });
      await db.update(councilSessions).set({ status: 'running', checkpoint: { ...newCheckpoint(team),
        inflight: { id: 'old-worker', turn: 0, revision: session.revision },
        remote: { agentId: 'local', taskId: 'restart-task', contextId: 'context', messageId: 'original',
          turn: 0, revision: session.revision, dispatchStarted: true } } }).where(eq(councilSessions.id, session.id));
      await service.onModuleInit();
      const [paused] = await db.select().from(councilSessions).where(eq(councilSessions.id, session.id));
      assert.equal(paused.status, 'paused');
      assert.equal(paused.checkpoint?.inflight, undefined);
      assert.equal(paused.checkpoint?.remote?.taskId, 'restart-task');
      assert.equal(calls, 0);
      await service.runSession(owner, session.id);
      assert.equal((await done(service, session.id)).status, 'completed');
    });

    await t.test('a paused summary cannot publish an actionable stale report', async () => {
      let release: () => void = () => undefined;
      let reached: () => void = () => undefined;
      const blocked = new Promise<void>((resolve) => { release = resolve; });
      const summary = new Promise<void>((resolve) => { reached = resolve; });
      const service = makeService(async (_user, options) => {
        const assignment = JSON.parse(options.prompt.split('\n').at(-1)!);
        await options.onTask({ taskId: `task-${assignment.turn.phase}`, contextId: 'context' });
        if (assignment.turn.phase === 'summary') { reached(); await blocked; }
        return completed;
      });
      const id = await start(service);
      await summary;
      await service.pauseSession(owner, id);
      release();
      await new Promise((resolve) => setTimeout(resolve, 75));
      const session = await done(service, id);
      assert.equal(session.status, 'paused');
      assert.equal(session.reports.length, 0);
      assert.equal(session.messages.filter((message) => message.phase === 'summary').length, 0);
    });
  } finally {
    await client.end();
    if (created) await admin`DROP SCHEMA ${admin(namespace)} CASCADE`;
    await admin.end();
  }
});
