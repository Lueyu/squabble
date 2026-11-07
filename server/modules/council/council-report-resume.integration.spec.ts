import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
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
      const local = { store: { task: async (who: string, id: string) => { const saved = tasks.get(id); assert.equal(saved?.owner, who); return saved!; },
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
      return { owner, session, calls, service, failed, tasks };
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
  } finally { await client.end(); await admin`DROP SCHEMA IF EXISTS ${admin(namespace)} CASCADE`; await admin.end(); }
});
