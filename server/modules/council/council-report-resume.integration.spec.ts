import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { councilMessages, councilSessions } from '../../database/council.schema';
import { councilIndependentSubmissions } from '../../database/simple-council.schema';
import { CouncilService } from './council.service';
import { newCheckpoint } from './council.dialogue';
import { normalizeBuilderConfig } from '../paper-trading/agent-builder.rules';
import { ResearchDocumentsService } from '../research-documents/research-documents.service';
import type { CouncilMember } from '../../../shared/council.interface';
import type { CouncilEvidence } from './council.rules';
import type { AgentTask } from '../local-agents/local-agents.store';
import type { LocalAgentExecution } from '../local-agents/local-agents.types';
import { LocalAgentError } from '../local-agents/local-agents.types';
import { agentAssignment } from './council.native';
import { threadPromptContext } from './council.thread';
import { automaticResearchTasks } from '../../database/investment-policy.schema';
import { researchCurrentViews } from '../../database/simple-experience.schema';
import { CurrentResearchService } from '../experience/current-research.service';

test('saved daily report explicitly resumes only the necessary full-context gate and summary', async t => {
  assert.ok(process.env.COUNCIL_TEST_DATABASE_URL, 'Disposable database required');
  const namespace = `resume_report_${randomUUID().replaceAll('-', '')}`;
  const admin = postgres(process.env.COUNCIL_TEST_DATABASE_URL!, { max: 1, onnotice: () => {} });
  const client = postgres(process.env.COUNCIL_TEST_DATABASE_URL!, { max: 6, onnotice: () => {}, connection: { search_path: namespace } });
  try {
    await admin`CREATE SCHEMA ${admin(namespace)}`;
    for (const file of readdirSync('scripts/db').filter(name => /^\d\d_.*\.sql$/u.test(name) && !name.startsWith('02_')).sort()) {
      await client.unsafe(readFileSync(`scripts/db/${file}`, 'utf8'));
    }
    const db = drizzle(client);
    const members: CouncilMember[] = [
      { id: 'first', name: 'First', role: 'researcher', model: 'fast', instructions: '', executionMode: 'local', agentId: 'native-codex' },
      { id: 'last', name: 'Last', role: 'manager', model: 'fast', instructions: '', executionMode: 'local', agentId: 'native-opencode' },
    ];
    const evidence: CouncilEvidence = { id: 'owner-context', title: 'Fictional portfolio', sourceName: 'Frozen owner context',
      content: JSON.stringify({ holdings: Array.from({ length: 13 }, (_, i) => ({ ticker: `FICTION${i}`, shares: i + 1, note: 'complete fixture '.repeat(20) })),
        cash: [{ currency: 'USD', balance: 100 }, { currency: 'HKD', balance: 200 }, { currency: 'CNY', balance: 300 }] }),
      sourceUrl: null, fetchedAt: new Date().toISOString(), relevanceScore: 1, role: 'fundamental', evidenceType: 'other' };
    async function fixture(state: AgentTask['state'] = 'failed', error = 'LOCAL_PROTOCOL_INCOMPLETE', legacy = true, failSummaryOnce = false) {
      const owner = randomUUID();
      await client`INSERT INTO users(id,username,password_hash) VALUES(${owner},${owner.slice(0, 24)},'fictional')`;
      const checkpoint = newCheckpoint(members, { independent: true });
      checkpoint.turns = [...checkpoint.turns, { memberId: 'last', phase: 'challenge' }, { memberId: 'last', phase: 'summary' }];
      checkpoint.nextTurn = 3;
      checkpoint.simple = { ...checkpoint.simple!, researchOnly: true, stage: 'discussion', calls: 4, commonEvidence: [evidence], contextDate: '2026-11-07' };
      const config = normalizeBuilderConfig({ name: 'Fictional', template: 'guard', tickers: ['PORTFOLIO'], minimumRating: 'Buy', customPrompt: '',
        maxOrderPct: 5, dailyLossLimitPct: 3, maxOrdersPerDay: 1, notifyOnProposal: false, priceRules: [], council: { enabled: true, members } });
      const [session] = await db.insert(councilSessions).values({ owner, profileVersion: 1, profileSnapshot: config, ticker: 'PORTFOLIO', scene: 'portfolio_daily',
        status: 'paused', revision: 2, checkpoint, evidenceSnapshot: [evidence], language: 'en' }).returning();
      const tasks = new Map<string, AgentTask>();
      const task = (id: string, turn: number, taskState: AgentTask['state'], prompt: string): AgentTask => ({ id, owner, agentId: turn === 0 ? 'native-codex' : 'native-opencode',
        provider: turn === 0 ? 'codex' : 'opencode', kind: 'run', messageId: randomUUID(), prompt, state: taskState, createdAt: Date.now(), updatedAt: Date.now(),
        runtimeEntered: true, activityContext: { sessionId: session.id, revision: 2, memberId: members[turn === 0 ? 0 : 1].id, memberName: 'Fixture', turn, language: 'en', cycleId: checkpoint.cycleId } });
      for (const [i, member] of members.entries()) {
        const id = randomUUID(); const raw = task(id, i, 'completed', JSON.stringify({ evidence: [{ ...evidence, content: legacy ? evidence.content.slice(0, 1500) : evidence.content }] }));
        tasks.set(id, raw);
        const contribution = { content: `Retained ${member.id} finding`, evidenceIds: [evidence.id], reasoningSummary: [], questions: [], researchRequests: [], researchStance: 'balanced' as const };
        await db.insert(councilIndependentSubmissions).values({ owner, sessionId: session.id, cycleId: checkpoint.cycleId, memberId: member.id,
          executorIdentity: { identity: member.id, connection: member.agentId!, provider: raw.provider, model: 'fictional', memberId: member.id }, contribution,
          evidence: [], tokensUsed: 1, taskId: id, releasedAt: new Date() });
        await db.insert(councilMessages).values({ owner, sessionId: session.id, role: member.role, memberName: member.name, revision: 2, tokensUsed: 1,
          content: contribution.content, metadata: { cycleId: checkpoint.cycleId, turn: i, phase: 'opening', memberId: member.id, taskId: id } });
      }
      await db.insert(councilMessages).values({ owner, sessionId: session.id, role: 'manager', memberName: 'Last', revision: 2, tokensUsed: 1, content: 'Old incomplete-input check',
        metadata: { cycleId: checkpoint.cycleId, turn: 2, phase: 'challenge', memberId: 'last', reverseCheck: { outcome: 'unable_to_verify', checked: ['Old input'], findings: [],
          gaps: ['Legacy input omitted holdings and cash'], affectedPremises: ['Portfolio coverage'], evidenceIds: [] } } });
      const failedId = randomUUID(), failed = task(failedId, 3, state, 'Previous summary'); failed.error = error; tasks.set(failedId, failed);
      checkpoint.remote = { agentId: 'native-opencode', messageId: failed.messageId, taskId: failedId, turn: 3, revision: 2, dispatchStarted: true };
      await db.update(councilSessions).set({ checkpoint }).where(eq(councilSessions.id, session.id));
      const calls: LocalAgentExecution[] = [];
      const hooks: { taskRead?: (saved: AgentTask) => void } = {};
      const local = { store: { task: async (who: string, id: string) => { const saved = tasks.get(id); assert.equal(saved?.owner, who); hooks.taskRead?.(saved!); return saved!; },
        eventsForSession: async () => ({ events: [], cursor: 0, truncated: false }) },
        execute: async (_owner: string, options: LocalAgentExecution) => {
          calls.push(options);
          const assignment = JSON.parse(options.prompt.split('\n').at(-1)!);
          assert.notEqual(assignment.turn.phase, 'opening', 'accepted openings must never replay');
          assert.ok(options.prompt.includes('FICTION12')); assert.ok(options.prompt.includes('CNY'));
          assert.ok(options.prompt.includes('Retained first finding'));
          const newId = randomUUID(), current = task(newId, options.activityContext!.turn, 'completed', options.prompt);
          current.messageId = options.messageId; current.agentId = options.agentId; current.activityContext = options.activityContext;
          tasks.set(newId, current);
          await options.onTask({ taskId: newId, contextId: newId }); await options.onDispatch?.();
          if (assignment.turn.phase === 'summary' && failSummaryOnce) {
            failSummaryOnce = false; current.state = 'failed'; current.error = 'LOCAL_PROTOCOL_INCOMPLETE';
            throw new LocalAgentError('LOCAL_PROTOCOL_INCOMPLETE', newId, newId);
          }
          const result = assignment.turn.phase === 'challenge' ? { content: 'Corrected full portfolio check', evidenceIds: [evidence.id],
            reverseCheck: { outcome: 'no_counterevidence_found', checked: ['All 13 positions and three cash currencies'], findings: [], gaps: [], affectedPremises: ['Full portfolio concentration'], evidenceIds: [evidence.id] } }
            : { content: '# Complete corrected daily report\n\nAll positions and cash were reviewed.', evidenceIds: [evidence.id], decision: 'wait', dissent: [], nextReviewCondition: 'Next filing' };
          return { text: JSON.stringify(result), usageTokens: null, taskId: newId };
        } };
      const service = new CouncilService(db, {} as never, {} as never, {} as never, {} as never, local as never, undefined, undefined, undefined, new ResearchDocumentsService(db));
      return { owner, session, calls, service, failed, tasks, hooks };
    }
    async function completedResult(phase: 'challenge' | 'summary' = 'challenge') {
      const f = await fixture();
      const [row] = await db.select().from(councilSessions).where(eq(councilSessions.id, f.session.id));
      const known = [evidence, ...Array.from({ length: 9 }, (_, i) => ({ ...evidence, id: `known-${i}`, sourceName: 'Fictional source', content: `Fact ${i}` }))];
      const sourceIds = Array.from({ length: 11 }, (_, i) => `declared-${i}`);
      const check = { outcome: 'partially_weakened', checked: ['Full fictional portfolio checked'], findings: ['A premise needs narrower scope'], gaps: [],
        affectedPremises: ['Concentration'], evidenceIds: [...known.map(fact => fact.id), ...sourceIds] };
      const checkpoint = { ...row.checkpoint!, nextTurn: phase === 'challenge' ? 4 : 5,
        turns: [...row.checkpoint!.turns, { memberId: 'last', phase: 'challenge' as const }, { memberId: 'last', phase: 'summary' as const }],
        simple: { ...row.checkpoint!.simple!, calls: phase === 'challenge' ? 5 : 6,
          inputCorrection: { originalIndependentContextComplete: false as const,
            contextHash: createHash('sha256').update(JSON.stringify({ evidence: [{ id: evidence.id, content: evidence.content }], references: [], resolvedReferences: [] })).digest('hex'),
            sourceTaskIds: [...f.tasks.values()].filter(task => task.activityContext!.turn < 2).map(task => task.id),
            revision: 3, challengeTurn: 4, revalidated: phase === 'summary' } } };
      row.checkpoint = checkpoint; row.revision = 3; row.evidenceSnapshot = known;
      const saved = f.failed; saved.state = 'completed'; delete saved.error;
      saved.activityContext = { ...saved.activityContext!, turn: checkpoint.nextTurn, revision: 3 };
      checkpoint.remote = { ...checkpoint.remote!, turn: checkpoint.nextTurn, revision: 3 };
      if (phase === 'summary') await db.insert(councilMessages).values({ owner: f.owner, sessionId: row.id, role: 'manager', memberName: 'Last', revision: 3,
        content: 'Accepted full-context check', tokensUsed: 1, metadata: { phase: 'challenge', memberId: 'last', cycleId: checkpoint.cycleId, turn: 4,
          reverseCheck: { ...check, evidenceIds: known.map(fact => fact.id) } } });
      const history = await db.select().from(councilMessages).where(eq(councilMessages.sessionId, row.id)).orderBy(councilMessages.createdAt);
      saved.prompt = agentAssignment({ ticker: row.ticker, language: row.language, member: members[1], turn: { memberId: 'last', phase },
        thread: threadPromptContext(row), candidate: row.candidate, messages: history, evidence: known });
      saved.text = JSON.stringify({ content: phase === 'challenge' ? 'Saved complete check with all 21 citations' : 'Saved complete daily report', evidenceIds: known.map(fact => fact.id),
        ...(phase === 'challenge' ? { reverseCheck: check, sources: sourceIds.map(id => ({ id, title: id, url: `https://issuer.example/${id}`, content: `Original fictional excerpt ${id}` })) } : {}) });
      saved.usageTokens = 7;
      await db.update(councilSessions).set({ revision: 3, checkpoint, evidenceSnapshot: known, error: 'LOCAL_INVALID_RESULT' }).where(eq(councilSessions.id, row.id));
      return { ...f, saved, startingCalls: checkpoint.simple.calls, row };
    }
    await t.test('the first legacy resume retains research, runs two turns once and publishes the latest bound reverse check', async () => {
      const f = await fixture(); const input = { expectedRevision: 2, requestKey: 'explicit-report-resume' };
      const documents = new ResearchDocumentsService(db);
      const previous = await documents.submit(f.owner, { idempotencyKey: 'retained-previous', title: 'Earlier fictional report', kind: 'portfolio', ticker: 'PORTFOLIO',
        content: 'Earlier saved research.', sections: [{ id: 'summary', title: 'Summary', content: 'Earlier saved research.' }] });
      const [view, replaced, foreign] = await db.insert(researchCurrentViews).values([
        { owner: f.owner, topicKey: 'portfolio', dateKey: '2026-11-07', state: 'failed', taskKind: 'daily_research', taskId: f.session.id,
          generationSequence: 7, currentDocumentId: previous.id, error: 'Previous summary failed' },
        { owner: f.owner, topicKey: 'portfolio', dateKey: '2026-11-06', state: 'failed', taskKind: 'daily_research', taskId: randomUUID(), generationSequence: 9 },
        { owner: randomUUID(), topicKey: 'portfolio', dateKey: '2026-11-07', state: 'failed', taskKind: 'daily_research', taskId: f.session.id, generationSequence: 9 },
      ]).returning();
      const before = await client`SELECT id,contribution FROM council_independent_submissions WHERE session_id=${f.session.id} ORDER BY id`;
      await f.service.resumeDailyReport(f.owner, f.session.id, input);
      const [resuming] = await db.select().from(researchCurrentViews).where(eq(researchCurrentViews.id, view.id));
      assert.equal(resuming.state, 'generating'); assert.equal(resuming.error, null);
      assert.equal(resuming.generationSequence, 7); assert.equal(resuming.currentDocumentId, previous.id);
      await f.service.resumeDailyReport(f.owner, f.session.id, input);
      let result = await f.service.getSession(f.owner, f.session.id);
      for (let i = 0; i < 200 && result.status === 'running'; i++) { await new Promise(resolve => setTimeout(resolve, 10)); result = await f.service.getSession(f.owner, f.session.id); }
      assert.equal(result.status, 'completed', result.error ?? ''); assert.equal(f.calls.length, 2);
      assert.deepEqual(await client`SELECT id,contribution FROM council_independent_submissions WHERE session_id=${f.session.id} ORDER BY id`, before);
      assert.equal(f.failed.state, 'failed'); assert.equal(f.failed.error, 'LOCAL_PROTOCOL_INCOMPLETE');
      assert.equal(result.messages.filter(m => m.phase === 'opening').length, 2);
      const report = result.reports.at(-1)!; assert.equal(report.publicationOutcome, 'succeeded'); assert.ok(report.researchVersionId);
      await new CurrentResearchService(db, documents, {} as never, {} as never).reconcile();
      const [finished] = await db.select().from(researchCurrentViews).where(eq(researchCurrentViews.id, view.id));
      assert.equal(finished.state, 'ready'); assert.equal(finished.currentDocumentId, report.researchVersionId);
      assert.equal(finished.generationSequence, 7);
      assert.deepEqual((await db.select().from(researchCurrentViews).where(eq(researchCurrentViews.id, replaced.id)))[0], replaced);
      assert.deepEqual((await db.select().from(researchCurrentViews).where(eq(researchCurrentViews.id, foreign.id)))[0], foreign);
      assert.equal(report.coverage?.reverseCheck?.outcome, 'no_counterevidence_found');
      assert.equal(report.coverage?.complete, false, 'original independent context remains incomplete');
      assert.equal(report.coverage?.independentDeliveriesComplete, true);
      assert.equal(report.coverage?.inputCorrection?.originalIndependentContextComplete, false);
      assert.equal(report.coverage?.inputCorrection?.revalidated, true);
      assert.match(report.summary, /Input supplementation and coverage/); assert.doesNotMatch(report.summary, /some independent deliveries are unavailable/);
      const [stored] = await db.select().from(councilSessions).where(eq(councilSessions.id, f.session.id));
      assert.equal(stored.checkpoint?.simple?.calls, 6); assert.equal(stored.checkpoint?.nextTurn, 6);
      assert.match(f.calls[1].prompt, /All 13 positions and three cash currencies/);
      await f.service.resumeDailyReport(f.owner, f.session.id, input); assert.equal(f.calls.length, 2);
      await assert.rejects(f.service.resumeDailyReport(f.owner, f.session.id, { ...input, expectedRevision: 3 }), /REQUEST_KEY_CONFLICT/);
    });
    await t.test('an unchanged successful correction is reused when only the summary needs another explicit retry', async () => {
      const f = await fixture('failed', 'LOCAL_PROTOCOL_INCOMPLETE', true, true);
      await f.service.resumeDailyReport(f.owner, f.session.id, { expectedRevision: 2, requestKey: 'first-correction' });
      let result = await f.service.getSession(f.owner, f.session.id);
      for (let i = 0; i < 200 && result.status === 'running'; i++) { await new Promise(resolve => setTimeout(resolve, 10)); result = await f.service.getSession(f.owner, f.session.id); }
      assert.equal(result.status, 'paused'); assert.equal(f.calls.length, 2);
      await f.service.resumeDailyReport(f.owner, f.session.id, { expectedRevision: result.revision, requestKey: 'retry-summary-only' });
      result = await f.service.getSession(f.owner, f.session.id);
      for (let i = 0; i < 200 && result.status === 'running'; i++) { await new Promise(resolve => setTimeout(resolve, 10)); result = await f.service.getSession(f.owner, f.session.id); }
      assert.equal(result.status, 'completed', result.error ?? ''); assert.equal(f.calls.length, 3);
      assert.equal(result.messages.filter(message => message.phase === 'challenge').length, 2, 'retain the old check plus exactly one correction');
      assert.equal(result.reports.at(-1)?.coverage?.reverseCheck?.outcome, 'no_counterevidence_found');
      assert.equal(result.reports.at(-1)?.coverage?.inputCorrection?.revision, 3, 'a summary retry stays bound to the completed correction revision');
    });
    await t.test('full opening wire context needs only the failed summary, and cancellation also permits explicit resume', async () => {
      const f = await fixture('cancelled', 'LOCAL_CANCELLED', false);
      await f.service.resumeDailyReport(f.owner, f.session.id, { expectedRevision: 2, requestKey: 'full-context-summary' });
      let result = await f.service.getSession(f.owner, f.session.id);
      for (let i = 0; i < 200 && result.status === 'running'; i++) { await new Promise(resolve => setTimeout(resolve, 10)); result = await f.service.getSession(f.owner, f.session.id); }
      assert.equal(result.status, 'completed', result.error ?? ''); assert.equal(f.calls.length, 1);
      assert.equal(result.reports.at(-1)?.coverage?.complete, true);
      assert.equal(result.reports.at(-1)?.coverage?.inputCorrection, undefined);
    });
    await t.test('foreign owners, stale revisions and ambiguous upstream tasks cannot schedule work', async () => {
      for (const [state, error] of [['running', ''], ['failed', 'LOCAL_INTERRUPTED'], ['failed', 'LOCAL_DISPATCH_UNCERTAIN']] as const) {
        const f = await fixture(state, error);
        await assert.rejects(f.service.resumeDailyReport(f.owner, f.session.id, { expectedRevision: 2, requestKey: randomUUID() }), /ORIGINAL_TASK_NOT_TERMINATED/);
        assert.equal(f.calls.length, 0);
      }
      const f = await fixture();
      await assert.rejects(f.service.resumeDailyReport(randomUUID(), f.session.id, { expectedRevision: 2, requestKey: randomUUID() }));
      await assert.rejects(f.service.resumeDailyReport(f.owner, f.session.id, { expectedRevision: 1, requestKey: randomUUID() }), /RESEARCH_REVISION_CHANGED/);
      assert.equal(f.calls.length, 0);
    });
    await t.test('controlled zero-call reparse accepts exact full or legacy wire evidence while retaining scope checks', async () => {
      for (const legacy of [false, true]) {
        const f = await fixture();
        const [message] = await db.insert(councilMessages).values({ owner: f.owner, sessionId: f.session.id, role: 'user', memberName: 'You',
          content: 'Fictional question', revision: 1, tokensUsed: 0 }).returning();
        const [stored] = await db.select().from(councilSessions).where(eq(councilSessions.id, f.session.id));
        const checkpoint = { ...stored.checkpoint!, simple: { ...stored.checkpoint!.simple!, commonMessageIds: [message.id] } };
        await db.update(councilSessions).set({ checkpoint }).where(eq(councilSessions.id, f.session.id));
        stored.checkpoint = checkpoint;
        const saved = [...f.tasks.values()].find(task => task.activityContext?.turn === 0)!;
        saved.text = JSON.stringify({ content: 'Retained reparse finding', evidenceIds: [evidence.id] });
        saved.prompt = agentAssignment({ ticker: 'PORTFOLIO', language: 'en', member: members[0], turn: { memberId: members[0].id, phase: 'opening' },
          thread: threadPromptContext(stored), candidate: null, messages: [message], evidence: [evidence] });
        if (legacy) {
          const assignment = JSON.parse(saved.prompt.split('\n').at(-1)!); assignment.evidence[0].content = evidence.content.slice(0, 1500);
          saved.prompt = saved.prompt.split('\n').slice(0, -1).join('\n') + '\n' + JSON.stringify(assignment);
        }
        await f.service.reparseSavedTask(f.owner, f.session.id, members[0].id, saved.id);
        assert.equal(f.calls.length, 0);
        const attempts = await client`SELECT input_snapshot FROM council_member_attempts WHERE session_id=${f.session.id}`;
        assert.equal(attempts[0].input_snapshot.legacyInputIncomplete === true, legacy);
      }
    });
    await t.test('remaining cumulative and automatic budgets fence the resume before any new provider dispatch', async () => {
      const f = await fixture();
      const [row] = await db.select().from(councilSessions).where(eq(councilSessions.id, f.session.id));
      await db.update(councilSessions).set({ checkpoint: { ...row.checkpoint!, simple: { ...row.checkpoint!.simple!, calls: 11 } } }).where(eq(councilSessions.id, f.session.id));
      await assert.rejects(f.service.resumeDailyReport(f.owner, f.session.id, { expectedRevision: 2, requestKey: 'no-remaining-calls' }), /AUTOMATIC_TASK_CALL_LIMIT/);
      assert.equal(f.calls.length, 0);
      const [automatic] = await db.insert(automaticResearchTasks).values({ owner: f.owner, key: 'fictional-daily', purpose: 'fictional', dateKey: '2026-11-07', calls: 12 }).returning();
      await db.update(councilSessions).set({ checkpoint: { ...row.checkpoint!, simple: { ...row.checkpoint!.simple!, automaticTaskId: automatic.id } } }).where(eq(councilSessions.id, f.session.id));
      await assert.rejects(f.service.resumeDailyReport(f.owner, f.session.id, { expectedRevision: 2, requestKey: 'automatic-exhausted' }), /AUTOMATIC_TASK_CALL_LIMIT/);
      assert.equal(f.calls.length, 0);
      const [after] = await db.select().from(councilSessions).where(eq(councilSessions.id, f.session.id));
      assert.equal(after.revision, 2); assert.equal(after.status, 'paused');
      assert.equal(after.checkpoint?.simple?.calls, 4);
    });
    await t.test('changed frozen context requires another full-context check before retrying the summary', async () => {
      const f = await fixture('failed', 'LOCAL_PROTOCOL_INCOMPLETE', true, true);
      await f.service.resumeDailyReport(f.owner, f.session.id, { expectedRevision: 2, requestKey: 'initial-correction' });
      let result = await f.service.getSession(f.owner, f.session.id);
      for (let i = 0; i < 200 && result.status === 'running'; i++) { await new Promise(resolve => setTimeout(resolve, 10)); result = await f.service.getSession(f.owner, f.session.id); }
      const [row] = await db.select().from(councilSessions).where(eq(councilSessions.id, f.session.id));
      const revised = { ...evidence, content: evidence.content.replace('"balance":100', '"balance":101') };
      await db.update(councilSessions).set({ evidenceSnapshot: [revised], checkpoint: { ...row.checkpoint!, simple: { ...row.checkpoint!.simple!, commonEvidence: [revised] } } }).where(eq(councilSessions.id, f.session.id));
      await f.service.resumeDailyReport(f.owner, f.session.id, { expectedRevision: result.revision, requestKey: 'context-changed' });
      result = await f.service.getSession(f.owner, f.session.id);
      for (let i = 0; i < 200 && result.status === 'running'; i++) { await new Promise(resolve => setTimeout(resolve, 10)); result = await f.service.getSession(f.owner, f.session.id); }
      assert.equal(result.status, 'completed', result.error ?? ''); assert.equal(f.calls.length, 4);
      assert.equal(result.messages.filter(message => message.phase === 'challenge').length, 3);
      assert.equal(result.reports.at(-1)?.coverage?.inputCorrection?.revision, 4);
    });
    await t.test('a completed saved challenge is reparsed locally with 21 citations and only the following summary calls the provider', async () => {
      const f = await completedResult();
      const original = { text: f.saved.text, prompt: f.saved.prompt, state: f.saved.state };
      const [view] = await db.insert(researchCurrentViews).values({ owner: f.owner, topicKey: 'portfolio', dateKey: '2026-11-07', state: 'failed',
        taskKind: 'daily_research', taskId: f.session.id, generationSequence: 9 }).returning();
      const input = { expectedRevision: 3, requestKey: 'parse-saved-complete-check' };
      await f.service.resumeDailyReport(f.owner, f.session.id, input); await f.service.resumeDailyReport(f.owner, f.session.id, input);
      let result = await f.service.getSession(f.owner, f.session.id);
      for (let i = 0; i < 250 && result.status === 'running'; i++) { await new Promise(resolve => setTimeout(resolve, 10)); result = await f.service.getSession(f.owner, f.session.id); }
      assert.equal(result.status, 'completed', result.error ?? ''); assert.equal(f.calls.length, 1);
      assert.equal(JSON.parse(f.calls[0].prompt.split('\n').at(-1)!).turn.phase, 'summary');
      const recovered = result.messages.find(message => message.taskId === f.saved.id)!;
      assert.equal(recovered.turn, 4); assert.equal(recovered.reverseCheck?.evidenceIds.length, 21);
      assert.equal(recovered.revision, 4);
      assert.equal(result.reports.at(-1)?.coverage?.inputCorrection?.revision, 4);
      assert.equal(result.reports.at(-1)?.coverage?.inputCorrection?.challengeTurn, 4);
      assert.equal(result.reports.at(-1)?.coverage?.inputCorrection?.revalidated, true);
      assert.equal(result.reports.at(-1)?.coverage?.reverseCheck?.evidenceIds.length, 21);
      assert.equal(result.reports.at(-1)?.evidence.filter(fact => fact.sourceUrl?.startsWith('https://issuer.example/')).length, 11);
      assert.deepEqual({ text: f.saved.text, prompt: f.saved.prompt, state: f.saved.state }, original);
      const [stored] = await db.select().from(councilSessions).where(eq(councilSessions.id, f.session.id));
      assert.equal(stored.checkpoint?.simple?.calls, f.startingCalls + 1);
      assert.equal(stored.checkpoint?.turns.length, 6, 'local reparse accepts the original turn without appending another gate');
      await new CurrentResearchService(db, new ResearchDocumentsService(db), {} as never, {} as never).reconcile();
      const [ready] = await db.select().from(researchCurrentViews).where(eq(researchCurrentViews.id, view.id));
      assert.equal(ready.state, 'ready'); assert.equal(ready.currentDocumentId, result.reports.at(-1)?.researchVersionId);
    });
    await t.test('a completed saved summary costs zero provider calls and preserves the original call budget', async () => {
      const f = await completedResult('summary');
      const [automatic] = await db.insert(automaticResearchTasks).values({ owner: f.owner, key: 'exhausted-local-acceptance', purpose: 'fictional',
        dateKey: '2026-11-07', calls: 12, state: 'failed' }).returning();
      await db.update(councilSessions).set({ checkpoint: { ...f.row.checkpoint!, simple: { ...f.row.checkpoint!.simple!, calls: 12,
        automaticTaskId: automatic.id } } }).where(eq(councilSessions.id, f.session.id));
      await f.service.resumeDailyReport(f.owner, f.session.id, { expectedRevision: 3, requestKey: 'parse-saved-summary' });
      let result = await f.service.getSession(f.owner, f.session.id);
      for (let i = 0; i < 200 && result.status === 'running'; i++) { await new Promise(resolve => setTimeout(resolve, 10)); result = await f.service.getSession(f.owner, f.session.id); }
      assert.equal(result.status, 'completed', result.error ?? ''); assert.equal(f.calls.length, 0);
      const [stored] = await db.select().from(councilSessions).where(eq(councilSessions.id, f.session.id));
      assert.equal(stored.checkpoint?.simple?.calls, 12);
      assert.equal((await db.select().from(automaticResearchTasks).where(eq(automaticResearchTasks.id, automatic.id)))[0].calls, 12);
      assert.equal(result.messages.filter(message => message.taskId === f.saved.id).length, 1);
    });
    await t.test('completed-result recovery rejects mismatched frozen input and changed result or prompt hashes without dispatch', async () => {
      const mismatch = await completedResult();
      const assignment = JSON.parse(mismatch.saved.prompt.split('\n').at(-1)!); assignment.evidence[0].content = 'Wrong owner context';
      mismatch.saved.prompt = JSON.stringify(assignment);
      await assert.rejects(mismatch.service.resumeDailyReport(mismatch.owner, mismatch.session.id, { expectedRevision: 3, requestKey: 'wrong-completed-context' }), /SAVED_TASK_CONTEXT_MISMATCH/);
      assert.equal(mismatch.calls.length, 0);
      for (const field of ['text', 'prompt'] as const) {
        const f = await completedResult(); let reads = 0;
        f.hooks.taskRead = task => { if (task.id === f.saved.id && ++reads > 1) task[field] += ' '; };
        await f.service.resumeDailyReport(f.owner, f.session.id, { expectedRevision: 3, requestKey: `changed-${field}` });
        let result = await f.service.getSession(f.owner, f.session.id);
        for (let i = 0; i < 200 && result.status === 'running'; i++) { await new Promise(resolve => setTimeout(resolve, 10)); result = await f.service.getSession(f.owner, f.session.id); }
        assert.equal(result.status, 'paused'); assert.equal(f.calls.length, 0);
        assert.equal(result.messages.some(message => message.taskId === f.saved.id), false);
        const [stored] = await db.select().from(councilSessions).where(eq(councilSessions.id, f.session.id));
        assert.equal(stored.checkpoint?.simple?.calls, f.startingCalls);
      }
    });
    await t.test('new owner steering prevents accepting a completed summary from the previous message context', async () => {
      const f = await completedResult('summary');
      const steered = await f.service.addMessage(f.owner, f.session.id, 'Reconsider the new cash requirement before publishing.');
      await assert.rejects(f.service.resumeDailyReport(f.owner, f.session.id, { expectedRevision: steered.revision, requestKey: 'reject-stale-summary' }), /SAVED_TASK_CONTEXT_MISMATCH/);
      assert.equal(f.calls.length, 0);
      const retained = await f.service.getSession(f.owner, f.session.id);
      assert.equal(retained.reports.length, 0); assert.equal(retained.status, 'paused');
    });
    await t.test('saved assignment validation uses the same normalized member customization as native dispatch', async () => {
      const f = await completedResult();
      const profileSnapshot = { ...f.row.profileSnapshot, council: { ...f.row.profileSnapshot.council!, members: f.row.profileSnapshot.council!.members.map(member =>
        member.id === 'last' ? { ...member, instructions: '\n  Retained research scope  ' } : member) } };
      const assignment = JSON.parse(f.saved.prompt.split('\n').at(-1)!); assignment.member.instructions = 'Retained research scope';
      f.saved.prompt = JSON.stringify(assignment);
      await db.update(councilSessions).set({ profileSnapshot }).where(eq(councilSessions.id, f.session.id));
      await f.service.resumeDailyReport(f.owner, f.session.id, { expectedRevision: 3, requestKey: 'normalized-member' });
      let result = await f.service.getSession(f.owner, f.session.id);
      for (let i = 0; i < 200 && result.status === 'running'; i++) { await new Promise(resolve => setTimeout(resolve, 10)); result = await f.service.getSession(f.owner, f.session.id); }
      assert.equal(result.status, 'completed', result.error ?? ''); assert.equal(f.calls.length, 1);
    });
  } finally { await client.end(); await admin`DROP SCHEMA IF EXISTS ${admin(namespace)} CASCADE`; await admin.end(); }
});
