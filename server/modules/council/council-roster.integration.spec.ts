import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { CouncilService } from './council.service';
import { SimpleCouncilService } from './simple-council.service';
import { AgentRosterService } from '../agent-roster/agent-roster.service';
import { councilMessages, councilSessions, councilReports } from '../../database/council.schema';
import { modelConnections } from '../../database/model-connections.schema';
import { newCheckpoint } from './council.dialogue';
import { normalizeBuilderConfig } from '../paper-trading/agent-builder.rules';
import { assertCouncilRosterMember, markCouncilRosterDispatch, readCouncilRosterMemory } from './council.roster';
import type { PostgresJsDatabase } from '../../common/platform';
import { ResearchToolsService } from '../research-tools/research-tools.service';
import { councilIndependentSubmissions } from '../../database/simple-council.schema';
import { dataLibrarySources, dataLibraryVersions } from '../../database/data-library.schema';
import { CouncilWorkflowStore } from './council.workflow-store';
import { councilResearchTasks } from '../../database/research-workflow.schema';

test('persistent research participants survive followups and revoked friends cannot dispatch or publish', async t => {
  assert.ok(process.env.COUNCIL_TEST_DATABASE_URL, 'Disposable Council test database required');
  const namespace = `council_roster_${randomUUID().replaceAll('-', '')}`;
  const admin = postgres(process.env.COUNCIL_TEST_DATABASE_URL!, { max: 1, onnotice: () => {} });
  const client = postgres(process.env.COUNCIL_TEST_DATABASE_URL!, { max: 5, onnotice: () => {}, connection: { search_path: namespace } });
  try {
    await admin.unsafe(`CREATE SCHEMA ${namespace}`);
    for (const file of readdirSync('scripts/db').filter(name => /^\d\d_.*\.sql$/u.test(name) && !name.startsWith('02_')).sort()) await client.unsafe(readFileSync(`scripts/db/${file}`, 'utf8'));
    const db = drizzle(client) as unknown as PostgresJsDatabase;
    const owner = randomUUID();
    await client`INSERT INTO users(id,username,password_hash) VALUES(${owner},${owner.slice(0,24)},'fictional')`;
    const [connection] = await db.insert(modelConnections).values({ owner, name: 'Fictional connection', baseUrl: 'https://fixture.invalid', fastModel: 'fictional', slowModel: 'fictional', apiKeyEnc: 'unused' }).returning();
    const roster = new AgentRosterService(db);
    const friend = await roster.create(owner, { requestKey: 'friend', name: 'Saved friend', instructions: 'ORIGINAL_PERSONALITY', allowedToolIds: ['get_discussion_context'], executor: { executionMode: 'model', connectionId: connection.id, model: 'fast' } });
    const selection = [{ agentId: friend.id, agentVersionId: friend.currentVersionId }];
    const members = await roster.resolveMembers(owner, selection);
    const config = normalizeBuilderConfig({ name: 'Fictional', template: 'guard', tickers: ['FIXTURE'], minimumRating: 'Buy', customPrompt: '', maxOrderPct: 5, dailyLossLimitPct: 3, maxOrdersPerDay: 1, notifyOnProposal: false });
    config.council = { enabled: true, members, webResearch: false };
    const checkpoint = newCheckpoint(members, { independent: true });
    checkpoint.simple!.agentSelections = selection;
    const [session] = await db.insert(councilSessions).values({ owner, profileVersion: 1, profileSnapshot: config, ticker: 'FIXTURE', status: 'completed', checkpoint }).returning();
    await t.test('runtime recalls personal notes only for this exact private participant', async () => {
      await roster.writeMemory(owner, friend.id, { requestKey: 'private-note', expectedRevision: friend.revision,
        scope: { kind: 'personal' }, content: 'PRIVATE_NOTE_SENTINEL', origin: 'user_note', sourceRefs: [] });
      const recalled = await db.transaction(tx => readCouncilRosterMemory(tx, session, members[0]));
      assert.equal(recalled.length, 1);
      assert.equal(recalled[0].content, 'PRIVATE_NOTE_SENTINEL');
      const [running] = await db.update(councilSessions).set({ status: 'running' }).where(eq(councilSessions.id, session.id)).returning();
      const council = Object.assign(Object.create(CouncilService.prototype), { db, llm: { chatFastJSON: async (prompt: Array<{content:string}>, _owner: string, options: {shouldContinue():Promise<boolean>}) => {
        assert.equal(await options.shouldContinue(), true);
        const context = JSON.parse(prompt[1].content);
        assert.ok(context.evidence.some((item: {content:string}) => item.content === 'PRIVATE_NOTE_SENTINEL'), 'real API prompt must include scoped friend memory');
        return { data: { response: { thesis: 'Fictional answer', evidencePoints: [], risks: [], nextChecks: [] }, evidenceIds: [], researchRequests: [], questions: [] }, tokens: 1 };
      } } });
      await council.runMember(owner, running, members[0], { memberId: members[0].id, phase: 'opening' });
      await db.update(councilSessions).set({ status: 'completed' }).where(eq(councilSessions.id, session.id));
      const second = await roster.create(owner, { requestKey: 'second', executor: { executionMode: 'model', connectionId: connection.id, model: 'fast' } });
      const [peer] = await roster.resolveMembers(owner, [{ agentId: second.id, agentVersionId: second.currentVersionId }]);
      const [group] = await db.insert(councilSessions).values({ owner, profileVersion: 1, profileSnapshot: { ...config, council: { enabled: true, members: [members[0], peer] } }, ticker: 'FIXTURE', status: 'running', checkpoint }).returning();
      assert.deepEqual(await db.transaction(tx => readCouncilRosterMemory(tx, group, members[0])), []);
    });
    await t.test('real research tool reads honor the exact friend tool ceiling before provider access', async () => {
      await db.update(councilSessions).set({ status: 'running' }).where(eq(councilSessions.id, session.id));
      let providerCalls = 0;
      const tools = new ResearchToolsService(db, { getQuote: async () => { providerCalls++; return { symbol: 'FIXTURE', price: 10, timestamp: new Date().toISOString(), currency: 'USD' }; } } as never, {} as never, {} as never);
      const result = await tools.call(owner, { sessionId: session.id, revision: 1, memberId: members[0].id, memberName: members[0].name,
        ticker: 'FIXTURE', language: session.language, turn: 0, webResearch: false, expiresAt: Date.now() + 60000 }, { callId: 'denied', name: 'get_quotes', arguments: {} });
      assert.equal(providerCalls, 0);
      assert.equal(result.errorCode, 'AGENT_SCOPE_DENIED');
      await db.update(councilSessions).set({ status: 'completed' }).where(eq(councilSessions.id, session.id));
    });
    await t.test('one friend answers directly without a second hidden synthesis request', async () => {
      const [running] = await db.update(councilSessions).set({ status: 'running', checkpoint: { ...checkpoint, nextTurn: 1 } }).where(eq(councilSessions.id, session.id)).returning();
      await db.insert(councilIndependentSubmissions).values({ owner, sessionId: session.id, cycleId: checkpoint.cycleId,
        memberId: members[0].id, executorIdentity: { memberId: members[0].id, connection: connection.id, identity: 'fictional', provider: 'fixture', model: 'fixture' },
        contribution: { content: 'Direct answer', response: { thesis: 'Direct answer', evidencePoints: [], risks: [], nextChecks: [] }, questions: [], evidenceIds: [], reasoningSummary: [], researchRequests: [], researchStance: 'balanced', opinion: null }, tokensUsed: 1, evidence: [] });
      let published = 0;
      const council = Object.assign(Object.create(CouncilService.prototype), { db, publish: async () => { published++; return true; } });
      await council.releaseIndependent(owner, running);
      const [saved] = await db.select().from(councilSessions).where(eq(councilSessions.id, session.id));
      assert.equal(saved.checkpoint!.turns.length, 1, 'single-person answer must not enqueue another model request');
      assert.equal(published, 1);
      await db.update(councilSessions).set({ status: 'completed' }).where(eq(councilSessions.id, session.id));
    });
    await t.test('enabling a private read tool grants no owner-wide library, report, dataset or memory access', async () => {
      const privateTools = ['get_discussion_context', 'get_research_memory', 'get_research_report', 'search_data_library', 'read_browser_source', 'read_dataset_summary'];
      const isolated = await roster.create(owner, { requestKey: 'isolated', executor: { executionMode: 'model', connectionId: connection.id, model: 'fast' }, allowedToolIds: privateTools, allowedSources: [] });
      const isolatedMembers = await roster.resolveMembers(owner, [{ agentId: isolated.id, agentVersionId: isolated.currentVersionId }]);
      const [privateSession] = await db.insert(councilSessions).values({ owner, profileVersion: 1, profileSnapshot: { ...config, council: { enabled: true, members: isolatedMembers } }, ticker: 'FIXTURE', language: 'en', status: 'running', checkpoint: newCheckpoint(isolatedMembers, { independent: true }) }).returning();
      await db.insert(councilReports).values({ owner, sessionId: session.id, version: 1, revision: 1, decision: 'wait', summary: 'OWNER_REPORT_SECRET', dissent: [], nextReviewCondition: '', evidence: [], engine: 'llm' });
      let libraryReads = 0, memoryReads = 0, datasetReads = 0;
      const tools = new ResearchToolsService(db, {} as never, {} as never, { recall: async () => { memoryReads++; return { items: [], context: '', preferences: {} }; } } as never,
        { search: async () => { libraryReads++; return { items: [], asOf: new Date().toISOString(), truncated: false }; }, detail: async () => { libraryReads++; throw new Error('not permitted'); } } as never,
        undefined, undefined, { read: async () => { datasetReads++; throw new Error('not permitted'); } } as never);
      for (const name of privateTools.filter(name => name !== 'get_discussion_context')) {
        const args = name === 'search_data_library' ? { query: 'secret' } : name === 'read_browser_source' ? { sourceId: randomUUID() }
          : name === 'read_dataset_summary' ? { datasetVersionId: randomUUID() } : {};
        const result = await tools.call(owner, { sessionId: privateSession.id, revision: 1, memberId: isolatedMembers[0].id, memberName: isolatedMembers[0].name,
          ticker: 'FIXTURE', language: 'en', turn: 0, webResearch: false, expiresAt: Date.now() + 60000 }, { callId: name, name, arguments: args });
        assert.equal(JSON.stringify(result).includes('OWNER_REPORT_SECRET'), false, name);
      }
      assert.equal(libraryReads, 0, 'library access must be selected before any private source read');
      assert.equal(memoryReads, 0, 'owner-wide recall is never a persistent-friend runtime API');
      assert.equal(datasetReads, 0, 'dataset contents must be selected before a private read');
    });
    await t.test('explicit private source versions are usable and revocation during a provider call prevents publication', async () => {
      const [source] = await db.insert(dataLibrarySources).values({ owner, kind: 'upload', title: 'Fictional exact source', format: 'text', enabled: true }).returning();
      const [version] = await db.insert(dataLibraryVersions).values({ owner, sourceId: source.id, version: 1, contentHash: 'fictional-source-hash', rawContent: 'EXACT_SELECTED_SOURCE', extractedText: 'EXACT_SELECTED_SOURCE', sections: [], byteLength: 21, extractionState: 'ready' }).returning();
      const ref = { kind: 'document_version' as const, id: version.id, revision: '1', availability: 'available' as const };
      const person = await roster.create(owner, { requestKey: 'source-bounded', executor: { executionMode: 'model', connectionId: connection.id, model: 'fast' }, allowedToolIds: ['get_discussion_context', 'search_data_library', 'get_quotes'], allowedSources: [ref] });
      const people = await roster.resolveMembers(owner, [{ agentId: person.id, agentVersionId: person.currentVersionId }]);
      const [saved] = await db.insert(councilSessions).values({ owner, profileVersion: 1, profileSnapshot: { ...config, council: { enabled: true, members: people } }, ticker: 'FIXTURE', language: 'en', status: 'running', checkpoint: newCheckpoint(people, { independent: true }),
        evidenceSnapshot: [{ id: 'selected-source', title: source.title, content: 'EXACT_SELECTED_SOURCE', role: 'fundamental', evidenceType: 'other', sourceName: 'Selected source', sourceUrl: null, fetchedAt: new Date().toISOString(), relevanceScore: 1, libraryReferences: [{ sourceId: source.id, versionId: version.id }] }] }).returning();
      const scope = { sessionId: saved.id, revision: 1, memberId: people[0].id, memberName: people[0].name, ticker: 'FIXTURE', language: 'en' as const, turn: 0, webResearch: false, expiresAt: Date.now() + 60000 };
      const tools = new ResearchToolsService(db, { getQuote: async () => {
        await roster.archive(owner, person.id, { requestKey: 'archive-before-revoke', expectedRevision: person.revision });
        await db.update(dataLibrarySources).set({ enabled: false }).where(eq(dataLibrarySources.id, source.id));
        return { symbol: 'FIXTURE', price: 10, timestamp: new Date().toISOString(), currency: 'USD' };
      } } as never, {} as never, {} as never, { validateReferences: async () => true } as never);
      const read = await tools.call(owner, scope, { callId: 'selected', name: 'search_data_library', arguments: { query: 'EXACT_SELECTED' } });
      assert.equal(read.status, 'succeeded');
      assert.match(JSON.stringify(read), /EXACT_SELECTED_SOURCE/u);
      await db.transaction(tx => markCouncilRosterDispatch(tx, saved, people[0]));
      const before = (await db.select().from(councilSessions).where(eq(councilSessions.id, saved.id)))[0].checkpoint!.simple!.privateEvidence?.[people[0].id]?.length ?? 0;
      const late = await tools.call(owner, scope, { callId: 'late-source', name: 'get_quotes', arguments: {} });
      assert.equal(late.errorCode, 'AGENT_SOURCE_UNAVAILABLE');
      const after = (await db.select().from(councilSessions).where(eq(councilSessions.id, saved.id)))[0].checkpoint!.simple!.privateEvidence?.[people[0].id]?.length ?? 0;
      assert.equal(after, before, 'late provider output cannot become private or public session evidence');
    });
    await t.test('archive between real model dispatch and response preserves that answer and publication but blocks the next paid step', async () => {
      const person = await roster.create(owner, { requestKey: 'archive-inflight', allowedToolIds: ['get_discussion_context', 'get_quotes'], executor: { executionMode: 'model', connectionId: connection.id, model: 'fast' } });
      const people = await roster.resolveMembers(owner, [{ agentId: person.id, agentVersionId: person.currentVersionId }]);
      const [running] = await db.insert(councilSessions).values({ owner, profileVersion: 1, profileSnapshot: { ...config, council: { enabled: true, members: people } }, ticker: 'FIXTURE', language: 'en', status: 'running', checkpoint: newCheckpoint(people, { independent: true }) }).returning();
      let calls = 0;
      const council = Object.assign(Object.create(CouncilService.prototype), { db, llm: { chatFastJSON: async (_prompt: unknown, _owner: string, options: {onDispatch():Promise<void>}) => {
        await options.onDispatch(); calls++;
        const tools = new ResearchToolsService(db, { getQuote: async () => {
          await roster.archive(owner, person.id, { requestKey: 'archive-after-send', expectedRevision: person.revision });
          return { symbol: 'FIXTURE', price: 10, timestamp: new Date().toISOString(), currency: 'USD' };
        } } as never, {} as never, {} as never);
        const read = await tools.call(owner, { sessionId: running.id, revision: running.revision, memberId: people[0].id, memberName: people[0].name,
          ticker: running.ticker, language: running.language, turn: 0, webResearch: false, expiresAt: Date.now() + 60000 }, { callId: 'already-running-quote', name: 'get_quotes', arguments: {} });
        assert.equal(read.status, 'succeeded', 'a tool already dispatched under the original work receipt may settle after archive');
        return { data: { response: { thesis: 'Original dispatched answer', evidencePoints: [], risks: [], nextChecks: [] }, evidenceIds: [], researchRequests: [], questions: [] }, tokens: 5 };
      } } });
      const claimId = await council.claimTurn(owner, running);
      assert.ok(claimId);
      const output = await council.runMember(owner, running, people[0], { memberId: people[0].id, phase: 'opening' });
      assert.equal(await council.recordTurn(owner, running, { memberId: people[0].id, phase: 'opening' }, claimId, output), true);
      await council.releaseIndependent(owner, running);
      const [finished] = await db.select().from(councilSessions).where(eq(councilSessions.id, running.id));
      assert.equal(finished.status, 'completed');
      assert.match((await db.select().from(councilReports).where(eq(councilReports.sessionId, running.id)))[0].summary, /Original dispatched answer/u);
      await assert.rejects(council.runMember(owner, finished, people[0], { memberId: people[0].id, phase: 'summary' }));
      assert.equal(calls, 1);
      const [paused] = await db.update(councilSessions).set({ status: 'paused' }).where(eq(councilSessions.id, running.id)).returning();
      assert.equal(await council.publish(owner, paused, { decision: 'wait', summary: 'Paused late publication', dissent: [], nextReviewCondition: '', evidenceIds: [] }, 'llm', null), false);
      assert.equal((await db.select().from(councilReports).where(eq(councilReports.sessionId, running.id))).length, 1, 'pause still revokes publication despite a prior dispatch receipt');
    });
    let starts = 0;
    const service = Object.assign(Object.create(SimpleCouncilService.prototype), { db, roster,
      start: async () => { starts++; }, get: async () => ({}),
      resolveMembers: async (_owner: string, selected?: typeof selection) => {
        assert.deepEqual(selected, selection, 'followups must never discover current global participants');
        return { members: await roster.resolveMembers(owner, selected!), executors: [] };
      } }) as SimpleCouncilService;
    await t.test('completed followup keeps saved versions after profile changes', async () => {
      await roster.update(owner, friend.id, { requestKey: 'new-version', expectedRevision: friend.revision, instructions: 'NEW_PERSONALITY' });
      await service.addMessage(owner, session.id, { message: 'Continue this saved question', requestKey: 'followup' });
      const [saved] = await db.select().from(councilSessions).where(eq(councilSessions.id, session.id));
      assert.deepEqual(saved.checkpoint!.simple!.agentSelections, selection);
      assert.deepEqual(saved.profileSnapshot.council!.members, members);
      assert.equal(starts, 1);
    });
    await t.test('archive blocks followup before user message or new dispatch', async () => {
      const current = await roster.detail(owner, friend.id);
      await roster.archive(owner, friend.id, { requestKey: 'archive', expectedRevision: current.revision });
      const before = (await db.select().from(councilMessages)).length;
      await assert.rejects(service.addMessage(owner, session.id, { message: 'Do not replace my friend', requestKey: 'archived-followup' }));
      assert.equal((await db.select().from(councilMessages)).length, before);
      assert.equal(starts, 1);
    });
    await t.test('a dispatched workflow attempt accepts and publishes its saved artifact after archive', async () => {
      const person = await roster.create(owner, { requestKey: 'workflow-archive', executor: { executionMode: 'model', connectionId: connection.id, model: 'fast' } });
      const people = await roster.resolveMembers(owner, [{ agentId: person.id, agentVersionId: person.currentVersionId }]);
      const workflowCheckpoint = { cycleId: randomUUID(), turns: [], nextTurn: 0, toolKindsUsed: [], pendingResearch: [], workflow: { goal: 'comprehensive' as const, peers: [], parallelism: 1 as const, recallEnabled: false } };
      const [running] = await db.insert(councilSessions).values({ owner, profileVersion: 1, profileSnapshot: { ...config, council: { enabled: true, members: people } }, ticker: 'FIXTURE', language: 'en', status: 'running', checkpoint: workflowCheckpoint }).returning();
      const store = new CouncilWorkflowStore(db);
      await store.initialize(running, [{ key: 'summary', dependencies: [], memberId: people[0].id, position: 0 }], () => []);
      const [task] = await store.list(owner, running.id, workflowCheckpoint.cycleId), attempt = await store.claim(running, task, 'work');
      assert.ok(attempt);
      await store.markRemote(running, task, attempt.id, { dispatched: true }, true);
      await roster.archive(owner, person.id, { requestKey: 'archive-workflow-after-send', expectedRevision: person.revision });
      await store.markRemote(running, task, attempt.id, { savedResponse: { text: 'Saved dispatched workflow answer' }, tokens: 17 });
      assert.equal(await store.finish(running, task, attempt, people[0], { tokens: 17, delivery: { conclusion: 'Saved dispatched workflow answer', evidenceIds: [], asOf: '2026-11-12', currency: null, units: '', assumptions: [], gaps: [], skillVersions: [], response: { thesis: 'Saved dispatched workflow answer', evidencePoints: [], risks: [], nextChecks: [] } } }), true);
      const council = Object.assign(Object.create(CouncilService.prototype), { db });
      assert.equal(await council.publish(owner, running, { decision: 'wait', summary: 'Saved dispatched workflow answer', dissent: [], nextReviewCondition: '', evidenceIds: [] }, 'llm', null), true);
      assert.equal((await db.select().from(councilReports).where(eq(councilReports.sessionId, running.id))).length, 1);
    });
    await t.test('dispatch and final publication fences recheck the selected identity', async () => {
      await assert.rejects(db.transaction(tx => assertCouncilRosterMember(tx, session, members[0])));
      const [running] = await db.update(councilSessions).set({ status: 'running' }).where(eq(councilSessions.id, session.id)).returning();
      const service = Object.assign(Object.create(CouncilService.prototype), { db }) as unknown as { publish(...args: unknown[]): Promise<boolean> };
      await assert.rejects(service.publish(owner, running, { decision: 'wait', summary: 'Late response', dissent: [], nextReviewCondition: '', evidenceIds: [] }, 'llm', null));
    });
    await t.test('a raw response without durable dispatch proof cannot become new accepted work for an archived friend', async () => {
      const workflowCheckpoint = { cycleId: randomUUID(), turns: [], nextTurn: 0, toolKindsUsed: [], pendingResearch: [], workflow: { goal: 'comprehensive' as const, peers: [], parallelism: 1 as const, recallEnabled: false } };
      const [workflowSession] = await db.insert(councilSessions).values({ owner, profileVersion: 1, profileSnapshot: config, ticker: 'FIXTURE', language: 'en', status: 'running', checkpoint: workflowCheckpoint }).returning();
      const store = new CouncilWorkflowStore(db);
      await store.initialize(workflowSession, [{ key: 'summary', dependencies: [], memberId: members[0].id, position: 0 }], () => []);
      const [task] = await store.list(owner, workflowSession.id, workflowCheckpoint.cycleId);
      const attempt = await store.claim(workflowSession, task, 'work');
      assert.ok(attempt);
      await store.markRemote(workflowSession, task, attempt.id, { savedResponse: { text: 'Already dispatched raw response' }, tokens: 17 });
      const accepted = await store.finish(workflowSession, task, attempt, members[0], { tokens: 17, delivery: { conclusion: 'Late answer', evidenceIds: [], asOf: '2026-11-12', currency: null, units: '', assumptions: [], gaps: [], skillVersions: [], response: { thesis: 'Late answer', evidencePoints: [], risks: [], nextChecks: [] } } });
      assert.equal(accepted, false);
      const [saved] = await db.select().from(councilResearchTasks).where(eq(councilResearchTasks.sessionId, workflowSession.id));
      assert.equal(saved.attempts[0].tokens, 17);
      assert.equal(saved.attempts[0].savedResponse?.text, 'Already dispatched raw response');
      assert.equal(saved.state, 'cancelled');
      assert.equal((await db.select().from(councilMessages).where(eq(councilMessages.sessionId, workflowSession.id))).length, 0);
    });
  } finally {
    await client.end(); await admin.unsafe(`DROP SCHEMA ${namespace} CASCADE`); await admin.end();
  }
});
