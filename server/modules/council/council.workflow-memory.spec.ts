import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import axios from 'axios';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { councilMessages, councilReports, councilSessions } from '../../database/council.schema';
import { councilResearchTasks } from '../../database/research-workflow.schema';
import { CouncilWorkflowExecutor } from './council.workflow-executor';
import { CouncilWorkflowStore } from './council.workflow-store';
import { ResearchMemoryService } from '../research-memory/research-memory.service';
import { LlmService } from '../research-core/llm.service';
import { LlmBudgetService } from '../llm-budget/llm-budget.service';
import { estimateInputTokens } from '../llm-budget/llm-budget.rules';
import { QuoteService } from '../quote/quote.service';
import type { CouncilMember, CouncilReport } from '../../../shared/council.interface';
import type { ResearchMemoryRecallItem } from '../../../shared/research-memory.interface';
import type { ResearchTaskAttempt } from '../../../shared/research-workflow.interface';
import type { SettingsService } from '../settings/settings.service';
import { LocalAgentsService } from '../local-agents/local-agents.service';
import { LocalAgentStore } from '../local-agents/local-agents.store';
import { providerCatalog } from '../local-agents/local-agents.requests';
import { researchSnapshotPrompt } from '../../local-agents/tool-config';
import { ResearchToolsService } from '../research-tools/research-tools.service';
import type { MemoryToolData } from '../research-memory/research-memory.context';
import type { ResearchDelivery } from '../../../shared/research-workflow.interface';
import { financialMetadata } from '../research-core/financial-evidence-metadata';

test('real executor submissions match durable inventories across languages, refresh, API failures, reviews and native callbacks', {
  skip: !process.env.COUNCIL_TEST_DATABASE_URL,
}, async t => {
  const url = process.env.COUNCIL_TEST_DATABASE_URL!;
  const namespace = `workflow_memory_${randomUUID().replaceAll('-', '')}`;
  const admin = postgres(url, { max: 1, onnotice: () => {} });
  const client = postgres(url, { max: 5, onnotice: () => {}, connection: { search_path: namespace } });
  const original = axios.defaults.adapter;
  const directory = await mkdtemp(join(tmpdir(), 'squabble-memory-dispatch-'));
  const priorOrigin = process.env.SQUABBLE_DESKTOP_ORIGIN;
  process.env.SQUABBLE_DESKTOP_ORIGIN = 'http://127.0.0.1:43199';
  const nativeServices: LocalAgentsService[] = [];
  await admin`CREATE SCHEMA ${admin(namespace)}`;
  try {
    for (const name of ['01_schema.sql', '03_agent_builder.sql', '07_llm_budget.sql', '08_investment_council.sql',
      '12_council_dialogue.sql', '13_budget_toggle.sql', '14_a2a_agents.sql', '15_native_agents.sql', '17_research_memory.sql',
      '18_research_workflow.sql', '19_atomic_research_theses.sql', '20_research_memory_temporal.sql', '21_research_archive_jobs.sql', '27_research_threads.sql']) await client.unsafe(readFileSync(`scripts/db/${name}`, 'utf8'));
    const db = drizzle(client), budgets = new LlmBudgetService(db), store = new CouncilWorkflowStore(db);
    const memory = new ResearchMemoryService(db, new QuoteService(db, undefined as never));
    const llm = new LlmService({ getLlmConfig: async () => ({ source: 'server', baseUrl: 'https://fixture.invalid',
      apiKey: 'fixture', fastModel: 'fixture', slowModel: 'fixture' }) } as unknown as SettingsService, budgets);
    for (const language of ['en', 'zh-CN'] as const) {
      let apiRequests = 0, nativeRequests = 0, agreements = 0, intactUnits = 0;
      const owner = randomUUID(), cycleId = randomUUID();
      await client`INSERT INTO users(id, username, password_hash) VALUES (${owner}, ${language}, 'fixture')`;
      await budgets.saveSettings(owner, { ...await budgets.getSettings(owner), maxCallsPerTask: 30 });
      const [source] = await db.insert(councilSessions).values({ owner, profileVersion: 1, profileSnapshot: {} as never,
        ticker: 'AAPL', language, status: 'completed' }).returning();
      const [report] = await db.insert(councilReports).values({ owner, sessionId: source.id, version: 1, revision: 1,
        decision: 'wait', summary: 'A report summary is history. '.repeat(100), dissent: [], nextReviewCondition: 'Next filing', engine: 'llm',
        evidence: [{ id: 'filing', title: 'Annual filing', content: 'Annual revenue 100 USD million.', sourceUrl: 'https://example.test/filing',
          metadata: financialMetadata({ ticker: 'AAPL', provider: 'SEC EDGAR', sourceUrl: 'https://example.test/filing',
            accession: '0000000123-26-000001', filed: '2026-02-01', end: '2025-12-31',
            facts: [{ concept: 'Revenues', value: 100000000, unit: 'USD', start: '2025-01-01' }] }),
          fetchedAt: new Date().toISOString() }] }).returning();
      await memory.archiveReport(owner, { sessionId: source.id, ticker: 'AAPL', language,
        report: { ...report, createdAt: report.createdAt.toISOString() } as CouncilReport,
        thesisCandidates: [{ claim: language === 'en' ? 'Revenue may grow if renewals hold.' : '续约保持时收入有望增长。',
          supportingEvidence: [{ evidenceId: 'filing' }], assumptions: ['Stable renewals'], indicators: ['Retention'],
          opposingEvidence: ['Customer concentration'], invalidationConditions: ['Revisit after two weaker periods.'], boundaryOrigin: 'stated' }] });
      const thesis = (await memory.list(owner, { ticker: 'AAPL' })).theses[0];
      await memory.updateThesis(owner, thesis.id, { action: 'confirm', expectedVersion: 1, expiresAt: '2027-02-01T00:00:00.000Z' });
      const frozen = await memory.recall(owner, { ticker: 'AAPL' });
      const selected = frozen.items[0];
      assert.equal(selected.content?.claim, thesis.claim);
      assert.equal(selected.expiresAt, '2027-02-01T00:00:00.000Z');
      const member: CouncilMember = { id: 'researcher', role: 'researcher', name: 'Fixture', instructions: '', model: 'fast' };
      const manager: CouncilMember = { ...member, id: 'manager', role: 'manager' };
      const [created] = await db.insert(councilSessions).values({ owner, profileVersion: 1, ticker: 'AAPL', language, status: 'running',
        profileSnapshot: { council: { members: [member, manager] } } as never,
        checkpoint: { cycleId, turns: [], nextTurn: 0, toolKindsUsed: [], pendingResearch: [],
          workflow: { goal: 'comprehensive', peers: [], parallelism: 1, recallEnabled: true, memory: frozen } },
        evidenceSnapshot: Array.from({ length: 8 }, (_, i) => ({ id: `e${i}`, role: 'fundamental' as const, evidenceType: 'financial',
          title: 'Filing', content: 'Optional evidence '.repeat(150), sourceName: 'Fixture', sourceUrl: 'https://example.test/e',
          fetchedAt: new Date().toISOString(), relevanceScore: 1 })) }).returning();
      const [taskRow] = await db.insert(councilResearchTasks).values({ owner, sessionId: created.id, cycleId, revision: 1,
        key: 'financials', memberId: member.id, position: 0, dependencies: [], skills: [] }).returning();
      let transportFails = false, expectedLimit = 6000, captures: Array<{ memory?: string; steering: string[]; submitted?: unknown;
        readOnlyToolResults: Array<{ data: { revenue: number; fiscalYear: number } }>;
        handoffs: Array<{ conclusion: string; evidenceIds: string[]; evidencePoints: string[]; assumptions: string[]; gaps: string[] }>;
        evidence: Array<{ id: string; content: string }> }> = [];
      const caveat = 'Customer retention is not independently verified; treat every revenue scenario as conditional. '.repeat(5);
      const result = { conclusion: 'Finding', response: { thesis: 'Finding', evidencePoints: [], risks: [], nextChecks: [] },
        evidenceIds: [], asOf: '2026-11-03', currency: null, units: 'unknown', assumptions: [], gaps: ['No current evidence verified'], skillVersions: [] };
      axios.defaults.adapter = async config => {
        const payload = JSON.parse(String(config.data));
        assert.ok(estimateInputTokens(payload.messages) <= expectedLimit);
        const input = JSON.parse(payload.messages.find((m: { role: string }) => m.role === 'user').content);
        captures.push(input);
        const live = (await store.list(owner, created.id, cycleId))[0].attempts.at(-1)!;
        assert.equal(live.dispatched, true, 'submission must be durable before the transport starts');
        const units = JSON.parse(input.memory || '[]') as ResearchMemoryRecallItem[];
        assert.deepEqual(live.memory!.submitted, units.map(({ kind, id, version }) => ({ kind, id, version })));
        apiRequests++; agreements++;
        for (const unit of units) { assert.deepEqual(unit.content, selected.content); assert.deepEqual(unit.citations, selected.citations); intactUnits++; }
        assert.equal(live.memory!.requestTokens, estimateInputTokens(payload.messages));
        if (transportFails) throw new Error('offline failure');
        return { status: 200, statusText: 'OK', headers: {}, config, data: { usage: { prompt_tokens: 10, completion_tokens: 5 },
          choices: [{ message: { content: JSON.stringify(input.submitted ? { accepted: true, feedback: 'Checked.' } : result) } }] } };
      };
      let launches = 0;
      const nativeTools = new ResearchToolsService(db, new QuoteService(db, undefined as never), {} as never, memory);
      const localAgents = new LocalAgentsService({
        detectNativeAgents: async () => [{ ...providerCatalog.codex, state: 'ready' }], openNativeLogin: async () => {},
        runNativeAgent: async (_provider, prompt, run) => {
          launches++;
          const after = (await store.list(owner, created.id, cycleId))[0].attempts.at(-1)!;
          const input = JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1));
          const units = JSON.parse(input.memory || '[]') as ResearchMemoryRecallItem[];
          assert.deepEqual(after.memory!.prepared, units.map(({ kind, id, version }) => ({ kind, id, version })));
          nativeRequests++;
          for (const unit of units) { assert.deepEqual(unit.content, selected.content); assert.deepEqual(unit.citations, selected.citations); intactUnits++; }
          assert.equal(after.memory!.counts.prepared, input.submitted ? 0 : 1);
          assert.equal(after.memory!.requestScope, 'application-prompt-and-snapshot');
          assert.equal(after.memory!.requestTokens, Buffer.byteLength(researchSnapshotPrompt(prompt, run.researchTools!.snapshot)));
          assert.equal(after.memory!.requestBudgetTokens, 32_000);
          assert.ok(!run.researchTools!.snapshot.includes(selected.content!.claim), 'bundle must not add hidden or duplicate memory');
          const tool = await run.researchTools!.call({ callId: 'memory', name: 'get_research_memory', arguments: {} }, run.signal);
          const data = tool.data as MemoryToolData;
          assert.equal(data.items.length, input.submitted ? 0 : 1);
          assert.ok(data.items.every(item => after.memory!.prepared.some(ref => ref.id === item.id && ref.version === item.version)));
          return { text: JSON.stringify(input.submitted ? { accepted: true, feedback: 'Checked.' } : result), usageTokens: null };
        },
      }, new LocalAgentStore(join(directory, language)), nativeTools);
      nativeServices.push(localAgents);
      await localAgents.connect(owner, 'native-codex');
      const tools = { call: async () => ({ status: 'succeeded', asOf: '2026-11-03', sources: [], truncated: false,
        data: { revenue: 123.45, fiscalYear: 2025, currency: 'USD', units: 'million', evidenceId: 'tool-current',
          explanation: 'Optional explanatory prose '.repeat(200) } }) } as unknown as ResearchToolsService;
      const executor = new CouncilWorkflowExecutor({ db, llm, memory, store, localAgents, tools, activity: async () => {} });
      const run = async (kind: ResearchTaskAttempt['kind'] = 'work', actor = member, summary = false) => {
        await db.update(councilResearchTasks).set({ state: kind === 'work' ? 'queued' : 'submitted' }).where(eq(councilResearchTasks.id, taskRow.id));
        const [row] = await db.select().from(councilSessions).where(eq(councilSessions.id, created.id));
        const [task] = await store.list(owner, created.id, cycleId);
        if (summary) { task.key = 'summary'; task.dependencies = ['financials']; }
        const attempt = (await store.claim(row, task, kind))!;
        let failure: unknown;
        const tasks = summary ? [task, { ...task, id: randomUUID(), key: 'financials' as const, delivery: { ...result,
          conclusion: 'CURRENT: revenue 123.45 USD million', evidenceIds: ['e0'], assumptions: [caveat],
          response: { ...result.response, evidencePoints: ['Unique CFO: USD 123.45 for FY2025.'] },
          gaps: ['Cash flow statements have not been independently reconciled. '.repeat(4)] } as ResearchDelivery }] : [task];
        try { const output = await executor.execute(row, task, attempt, actor, tasks);
          await store.finish(row, task, attempt, actor, output); }
        catch (error) { failure = error; await store.finish(row, task, attempt, actor, { error: String(error) }); }
        const latest = (await store.list(owner, created.id, cycleId))[0].attempts.at(-1)!;
        return { latest, failure };
      };
      const first = await run();
      assert.equal(first.failure, undefined);
      assert.equal(first.latest.memory!.counts.prepared, 1, 'whole memory gets capacity before optional evidence');
      assert.equal(captures[0].readOnlyToolResults[0].data.revenue, 123.45);
      assert.equal(captures[0].readOnlyToolResults[0].data.fiscalYear, 2025);
      assert.ok(captures[0].evidence.length > 0, 'history must not remove all current evidence');
      assert.deepEqual(JSON.parse(captures[0].memory!)[0].content, selected.content);
      assert.ok(!JSON.stringify(first.latest.memory).includes(selected.content!.claim), 'no prompt copy in telemetry');
      const review = await run('review'); assert.equal(review.failure, undefined);
      assert.deepEqual(review.latest.memory!.counts, { requested: 0, selected: 0, prepared: 0, submitted: 0 });
      expectedLimit = 3800;
      await budgets.saveSettings(owner, { ...await budgets.getSettings(owner), maxInputTokens: expectedLimit });
      const beforeSummary = captures.length;
      const summary = await run('work', member, true);
      if (summary.failure) {
        assert.match(String(summary.failure), /RESEARCH_CONTEXT_LIMIT/);
        assert.equal(captures.length, beforeSummary, 'unique current evidence must cause a safe no-fit rather than a weakened dispatch');
        assert.equal(summary.latest.memory!.counts.prepared, 0);
      } else {
        assert.match(captures.at(-1)!.handoffs[0].conclusion, /123.45/);
        assert.deepEqual(captures.at(-1)!.handoffs[0].evidenceIds, ['e0']);
        assert.deepEqual(captures.at(-1)!.handoffs[0].evidencePoints, ['Unique CFO: USD 123.45 for FY2025.']);
        assert.ok(captures.at(-1)!.evidence.some(item => item.id === 'e0' && item.content), 'a source ID alone cannot replace the cited source excerpt');
        assert.equal(captures.at(-1)!.handoffs[0].assumptions[0], caveat, 'historical memory must not squeeze out current caveats');
        assert.equal(captures.at(-1)!.handoffs[0].gaps[0], 'Cash flow statements have not been independently reconciled. '.repeat(4));
      }
      assert.ok(!summary.latest.memory!.prepared.some(item => item.kind === 'history'), 'selected thesis represents the same report without duplicate history');
      expectedLimit = 6000;
      await budgets.saveSettings(owner, { ...await budgets.getSettings(owner), maxInputTokens: expectedLimit });
      const savedMessages = await db.select().from(councilMessages).where(eq(councilMessages.sessionId, created.id));
      const savedMessage = savedMessages.find(message => message.metadata?.taskId === first.latest.id)!;
      assert.deepEqual(savedMessage.metadata?.memory, first.latest.memory, 'message details retain the attempt inventory across later cycles');
      const native = await run('work', { ...member, executionMode: 'local', agentId: 'native-codex' });
      assert.equal(native.failure, undefined); assert.equal(native.latest.memory!.submission, 'agent');
      assert.deepEqual(native.latest.memory!.submitted, native.latest.memory!.prepared);
      agreements++;
      const nativeReview = await run('review', { ...manager, executionMode: 'local', agentId: 'native-codex' });
      assert.equal(nativeReview.failure, undefined); assert.equal(nativeReview.latest.memory!.counts.submitted, 0);
      agreements++;
      assert.equal(launches, 2);
      // Quoting the known JSON snapshot adds bytes too; fail before native activation if that envelope cannot fit.
      const nativeBundle = nativeTools.bundle.bind(nativeTools);
      nativeTools.bundle = async (...args) => ({ ...await nativeBundle(...args), snapshot: JSON.stringify({ data: '"'.repeat(11_000) }) });
      const snapshotLimit = await run('work', { ...member, executionMode: 'local', agentId: 'native-codex' });
      nativeTools.bundle = nativeBundle;
      assert.match(String(snapshotLimit.failure), /RESEARCH_CONTEXT_LIMIT/, JSON.stringify(snapshotLimit.latest.memory));
      assert.ok(snapshotLimit.latest.memory!.requestTokens! > 32_000);
      assert.equal(snapshotLimit.latest.memory!.counts.submitted, 0); assert.equal(launches, 2);
      transportFails = true;
      const failed = await run(); assert.ok(failed.failure); assert.equal(failed.latest.memory!.counts.submitted, 1);
      transportFails = false;
      const before = captures.length;
      await budgets.saveSettings(owner, { ...await budgets.getSettings(owner), maxCallsPerTask: (await budgets.getUsage(owner)).dayCalls });
      const blocked = await run(); assert.ok(blocked.failure); assert.equal(captures.length, before);
      assert.equal(blocked.latest.memory!.counts.prepared, 1); assert.equal(blocked.latest.memory!.counts.submitted, 0);
      await budgets.saveSettings(owner, { ...await budgets.getSettings(owner), maxCallsPerTask: 30 });
      const { provenance: _author, ...editContent } = selected.content!;
      const reserve = budgets.reserve.bind(budgets);
      const previousCalls = (await budgets.getUsage(owner)).dayCalls;
      budgets.reserve = (user, request, dispatch) => reserve(user, request, async () => {
        await memory.updateThesis(owner, thesis.id, { action: 'edit', expectedVersion: 2,
          content: { ...editContent, claim: 'A newer changed claim' } });
        await dispatch?.();
      });
      const race = await run();
      budgets.reserve = reserve;
      assert.match(String(race.failure), /MEMORY_CONTEXT_CHANGED/);
      assert.equal(race.latest.memory!.counts.submitted, 0);
      assert.equal((await budgets.getUsage(owner)).dayCalls, previousCalls, 'pre-dispatch refresh failure releases only unsubmitted reservation');
      const changed = await run(); assert.equal(changed.failure, undefined);
      assert.equal(changed.latest.memory!.counts.submitted, 0);
      assert.equal(changed.latest.memory!.omissions[0].reason, 'version-changed');
      await memory.updateThesis(owner, thesis.id, { action: 'exclude', expectedVersion: 3, excluded: true });
      const revoked = await run(); assert.equal(revoked.latest.memory!.omissions[0].reason, 'revoked');
      await memory.updatePreferences(owner, { autoArchive: true, recallEnabled: false });
      const disabled = await run(); assert.equal(disabled.latest.memory!.omissions[0].reason, 'disabled');
      // Separate no-fit scenarios from the already-verified attempt history; production retries remain capped at twelve.
      await db.update(councilResearchTasks).set({ attempts: [] }).where(eq(councilResearchTasks.id, taskRow.id));
      await db.insert(councilMessages).values({ owner, sessionId: created.id, revision: 1, role: 'user', memberName: 'User', content: 'Latest steering '.repeat(4000) });
      captures = [];
      const oversized = await run(); assert.ok(oversized.failure); assert.equal(captures.length, 0);
      assert.equal(oversized.latest.memory!.counts.submitted, 0, 'latest steering must be rejected whole, never silently cut');
      assert.match(String(oversized.failure), /RESEARCH_CONTEXT_LIMIT/);
      await budgets.saveSettings(owner, { ...await budgets.getSettings(owner), enabled: false });
      assert.match(String((await run()).failure), /RESEARCH_CONTEXT_LIMIT/, 'disabled billing limits do not bypass context integrity');
      assert.match(String((await run('work', { ...member, executionMode: 'local', agentId: 'native-codex' })).failure), /RESEARCH_CONTEXT_LIMIT/);
      assert.equal(launches, 2);
      const higherSteering = 'Keep this instruction intact. '.repeat(250);
      await db.insert(councilMessages).values({ owner, sessionId: created.id, revision: 1, role: 'user', memberName: 'User', content: higherSteering });
      expectedLimit = 12_000;
      await budgets.saveSettings(owner, { ...await budgets.getSettings(owner), enabled: true, maxInputTokens: expectedLimit });
      const higher = await run(); assert.equal(higher.failure, undefined);
      assert.equal(higher.latest.memory!.requestBudgetTokens, expectedLimit);
      assert.ok(higher.latest.memory!.requestTokens! > 6000);
      assert.deepEqual(captures.at(-1)!.steering, [higherSteering], 'explicitly configured higher input limit remains usable');
      // Receipt recording is after runtime entry. Empty-memory tasks still require a live session at that boundary.
      await db.insert(councilMessages).values({ owner, sessionId: created.id, revision: 1, role: 'user', memberName: 'User', content: 'Check cash flow.' });
      const takeNative = localAgents.store.takeNative.bind(localAgents.store);
      for (const change of [{ status: 'paused' as const }, { revision: 2 }]) {
        await db.update(councilResearchTasks).set({ attempts: [] }).where(eq(councilResearchTasks.id, taskRow.id));
        localAgents.store.takeNative = async (...args) => { const taken = await takeNative(...args);
          await db.update(councilSessions).set(change).where(eq(councilSessions.id, created.id)); return taken; };
        const stopped = await run('work', { ...member, executionMode: 'local', agentId: 'native-codex' });
        assert.match(String(stopped.failure), /LOCAL_(?:PAUSED|CANCELLED)/);
        assert.equal(stopped.latest.memory!.counts.prepared, 0); assert.equal(stopped.latest.memory!.counts.submitted, 0);
        assert.equal(launches, 2, 'pause or steering revision at takeNative must block runtime entry');
        await db.update(councilSessions).set({ status: 'running', revision: 1 }).where(eq(councilSessions.id, created.id));
      }
      localAgents.store.takeNative = takeNative;
      const modeBefore = process.env.LOCAL_AGENTS_MODE;
      delete process.env.SQUABBLE_DESKTOP_ORIGIN; process.env.LOCAL_AGENTS_MODE = 'companion';
      const activate = localAgents.store.activate.bind(localAgents.store);
      try {
        const paired = await localAgents.store.pair((await localAgents.pairing(owner)).code, 'Fixture');
        const agents = [{ ...providerCatalog.codex, state: 'ready' as const }];
        await localAgents.store.poll(paired.token, { agents, updates: [] }); await localAgents.connect(owner, 'companion-codex');
        for (const change of [{ status: 'paused' as const }, { revision: 2 }]) {
          let commands = 0;
          await db.update(councilResearchTasks).set({ attempts: [] }).where(eq(councilResearchTasks.id, taskRow.id));
          localAgents.store.activate = async (...args) => {
            await activate(...args);
            await db.update(councilSessions).set(change).where(eq(councilSessions.id, created.id));
            commands += (await localAgents.store.poll(paired.token, { agents, updates: [] })).commands.length;
          };
          const stopped = await run('work', { ...member, executionMode: 'local', agentId: 'companion-codex' });
          assert.match(String(stopped.failure), /LOCAL_(?:PAUSED|CANCELLED)/);
          assert.equal(stopped.latest.memory!.counts.prepared, 0); assert.equal(stopped.latest.memory!.counts.submitted, 0);
          assert.equal(commands, 0, 'empty-memory queued work respects pause and steering before a companion command');
          await db.update(councilSessions).set({ status: 'running', revision: 1 }).where(eq(councilSessions.id, created.id));
        }
      } finally {
        localAgents.store.activate = activate;
        process.env.SQUABBLE_DESKTOP_ORIGIN = 'http://127.0.0.1:43199';
        if (modeBefore === undefined) delete process.env.LOCAL_AGENTS_MODE; else process.env.LOCAL_AGENTS_MODE = modeBefore;
      }
      t.diagnostic(`MEMORY_REQUEST_MEASUREMENT ${JSON.stringify({ language, apiRequests, nativeRequests, agreements, intactUnits })}`);
    }
  } finally {
    for (const service of nativeServices) await service.onModuleDestroy();
    if (priorOrigin === undefined) delete process.env.SQUABBLE_DESKTOP_ORIGIN; else process.env.SQUABBLE_DESKTOP_ORIGIN = priorOrigin;
    await rm(directory, { recursive: true, force: true });
    axios.defaults.adapter = original; await client.end(); await admin`DROP SCHEMA ${admin(namespace)} CASCADE`; await admin.end();
  }
});
