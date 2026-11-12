import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { councilSessions, councilReports, councilMessages } from '../../database/council.schema';
import { libraryEvidenceAvailability, libraryEvidenceAvailable } from '../../database/data-library-visibility';
import { councilMemberAttempts } from '../../database/simple-council.schema';
import { councilResearchTasks } from '../../database/research-workflow.schema';
import { CouncilService } from './council.service';
import { SimpleCouncilService } from './simple-council.service';
import { ResearchToolsService } from '../research-tools/research-tools.service';
import { DataLibraryService } from '../data-library/data-library.service';
import { ResearchDocumentsService } from '../research-documents/research-documents.service';
import type { ResearchToolScope } from '@shared/research-tools.interface';

test('chat skill choice is pinned, idempotent, submitted to real execution and library references remain owner/deletion scoped', async () => {
  const url = process.env.COUNCIL_TEST_DATABASE_URL;
  assert.ok(url, 'A disposable COUNCIL_TEST_DATABASE_URL is required');
  const namespace = `chat_skills_${randomUUID().replaceAll('-', '')}`;
  const admin = postgres(url, { max: 1, onnotice: () => {} });
  const client = postgres(url, { max: 8, onnotice: () => {}, connection: { search_path: namespace } });
  try {
    await admin`CREATE SCHEMA ${admin(namespace)}`;
    for (const file of readdirSync('scripts/db').filter(name => /^\d+.*\.sql$/u.test(name) && !name.startsWith('02_')).sort()) {
      await client.unsafe(readFileSync(`scripts/db/${file}`, 'utf8'));
    }
    const db = drizzle(client);
    const owner = randomUUID();
    const other = randomUUID();
    await client`INSERT INTO users(id,username,password_hash) VALUES(${owner},'skills-alice','fixture'),(${other},'skills-bob','fixture')`;
    let configured = false;
    const prompts: string[] = [];
    const llm = { validateConnectionIds: async () => {}, isConfigured: async () => configured,
      getExecutionInfo: async () => ({ provider: 'fixture', modelFast: 'fixture', modelSlow: 'fixture' }),
      chatFastJSON: async (prompt: unknown) => { prompts.push(JSON.stringify(prompt)); return {
        data: { content: 'Verified fixture response with explicit missing data.', evidenceIds: [], researchStance: 'balanced' }, tokens: 1,
      }; } };
    const library = new DataLibraryService(db);
    const documents = new ResearchDocumentsService(db);
    const tools = new ResearchToolsService(db, {} as never, {} as never, {
      getPreferences: async () => ({ recallEnabled: false, autoArchive: false }),
      recall: async () => ({ items: [], context: '', preferences: { recallEnabled: false, autoArchive: false } }),
    } as never, library);
    const council = new CouncilService(db, llm as never, { collectEvidence: async () => [] } as never,
      { getPortfolioContext: async () => ({ totalValue: 0, cash: 0, holdings: [] }) } as never,
      { listRuns: async () => ({ items: [] }) } as never, undefined, undefined, undefined, tools, documents);
    const service = new SimpleCouncilService(db, council, llm as never, undefined, undefined, documents, library);
    const request = { message: '/financials Verify reporting periods', skillId: 'financial-verification', requestKey: 'skill-create' };
    const first = await service.create(owner, request);
    assert.ok('id' in first);
    if (!('id' in first)) throw new Error('Unexpected clarification');
    let conversationId = first.id;
    const stored = async () => (await db.select().from(councilSessions).where(eq(councilSessions.id, conversationId)))[0];
    const frozen = JSON.stringify((await stored()).checkpoint?.simple?.skills);
    assert.equal(first.skills?.[0].id, request.skillId);
    assert.equal((await service.create(owner, request) as { id: string }).id, first.id);
    await assert.rejects(service.create(owner, { ...request, skillId: 'portfolio-review' }), /REQUEST_KEY_CONFLICT/u);
    await assert.rejects(service.create(owner, { ...request, requestKey: 'invalid', skillId: 'arbitrary-local-code' }), /RESEARCH_SKILL_UNAVAILABLE/u);
    await service.addMessage(owner, first.id, { message: 'Continue with the same evidence', requestKey: 'followup' });
    assert.equal(JSON.stringify((await stored()).checkpoint?.simple?.skills), frozen);
    await db.update(councilSessions).set({ status: 'running' }).where(eq(councilSessions.id, first.id));
    await assert.rejects(service.addMessage(owner, first.id, { message: 'Switch procedure', skillId: 'portfolio-review', requestKey: 'switch-running' }), /RESEARCH_SKILL_CHANGE_REQUIRES_SETTLEMENT/u);
    assert.equal(JSON.stringify((await stored()).checkpoint?.simple?.skills), frozen);
    await db.update(councilSessions).set({ status: 'paused' }).where(eq(councilSessions.id, first.id));
    configured = true;
    await service.addMessage(owner, first.id, { message: 'Now use the pinned procedure', requestKey: 'execute-pinned' });
    assert.equal(prompts.length, 0, 'an empty historical conversation never discovers newly connected people');
    const explicit = await service.create(owner, { ...request, message: 'Use the pinned procedure with the connected member', requestKey: 'explicit-connected-discussion' });
    if (!('id' in explicit)) throw new Error('Unexpected clarification');
    conversationId = explicit.id;
    assert.equal(JSON.stringify((await stored()).checkpoint?.simple?.skills), frozen);
    for (let count = 0; count < 300 && (await service.get(owner, conversationId)).status === 'running'; count++) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const finished = await service.get(owner, conversationId);
    assert.ok(prompts.length > 0);
    assert.ok(prompts.every(prompt => prompt.includes('financial-verification@1.0.0')));
    assert.ok(finished.researchEvents?.some(event => event.kind === 'skill' && event.skill?.id === 'financial-verification'));
    const attempts = await db.select().from(councilMemberAttempts).where(eq(councilMemberAttempts.sessionId, conversationId));
    assert.ok(attempts.some(attempt => JSON.stringify(attempt.inputSnapshot.skills) === frozen));
    configured = false;
    const source = await library.create(owner, { kind: 'page', title: 'Fixture annual disclosure', text: 'Revenue grew from 90 to 100. This is source evidence, not an adopted thesis.' });
    assert.ok(source.latestVersionId);
    const context = { kind: 'library' as const, sourceId: source.id, versionId: source.latestVersionId };
    const based = await service.create(owner, { message: 'Read the source', context, skillId: 'source-reading', requestKey: 'library-create' });
    assert.ok('id' in based);
    if (!('id' in based)) throw new Error('Unexpected clarification');
    const [libraryRow] = await db.select().from(councilSessions).where(eq(councilSessions.id, based.id));
    assert.match(JSON.stringify(libraryRow.evidenceSnapshot), /Revenue grew/u);
    assert.deepEqual(libraryRow.evidenceSnapshot[0].libraryReferences, [{ sourceId: source.id, versionId: source.latestVersionId }]);
    assert.equal(await tools.validateLibraryEvidence(owner, Array(50).fill(libraryRow.evidenceSnapshot[0])), true,
      'repeated current/common/private snapshots must validate unique references only');
    const manyReferences = [{ sourceId: source.id, versionId: source.latestVersionId }];
    for (let index = 1; index < 40; index++) {
      const extra = await library.create(owner, { kind: 'page', title: `Fixture evidence ${index}`, text: `Only fixture source ${index}.` });
      manyReferences.push({ sourceId: extra.id, versionId: extra.latestVersionId! });
    }
    const accumulated = [{ ...libraryRow.evidenceSnapshot[0], libraryReferences: manyReferences }];
    assert.equal(await library.validateReferences(owner, manyReferences), false, 'single public validation stays bounded');
    assert.equal(await tools.validateLibraryEvidence(owner, accumulated), true, 'several valid tool calls can accumulate more than 30 distinct references');
    assert.equal(await libraryEvidenceAvailable(db, owner, accumulated), true);
    assert.equal((await libraryEvidenceAvailability(db, owner, [{ id: 'forty', evidence: accumulated }, { id: 'old', evidence: [] },
      { id: 'broken', evidence: [{ libraryReferences: 'invalid' }] }])).get('forty'), true);
    assert.equal(await libraryEvidenceAvailable(db, owner, [{ libraryReferences: 'invalid' }]), false);
    await db.update(councilSessions).set({ status: 'running' }).where(eq(councilSessions.id, based.id));
    const [publishing] = await db.select().from(councilSessions).where(eq(councilSessions.id, based.id));
    const publish = council as unknown as { publish: (...args: unknown[]) => Promise<boolean> };
    assert.equal(await publish.publish(owner, publishing, { decision: 'wait', summary: 'Fixture source-based report.', dissent: [], nextReviewCondition: 'Verify the next filing' }, 'llm', null), true);
    const [published] = await db.select().from(councilReports).where(eq(councilReports.sessionId, based.id));
    assert.deepEqual(published.evidence[0].libraryReferences, [{ sourceId: source.id, versionId: source.latestVersionId }]);
    assert.ok(published.researchVersionId);
    const fromReport = await service.create(owner, { message: 'Recheck the report', context: { kind: 'report', documentId: published.researchVersionId! }, requestKey: 'valid-report-child' });
    assert.ok('id' in fromReport);
    if (!('id' in fromReport)) throw new Error('Unexpected report clarification');
    const [child] = await db.select().from(councilSessions).where(eq(councilSessions.id, fromReport.id));
    assert.deepEqual(child.evidenceSnapshot[0].libraryReferences, [{ sourceId: source.id, versionId: source.latestVersionId }]);
    await db.update(councilSessions).set({ ticker: 'AAPL' }).where(eq(councilSessions.id, based.id));
    const reportReader = async () => {
      const id = randomUUID();
      await db.insert(councilSessions).values({ ...libraryRow, id, ticker: 'AAPL', status: 'running', evidenceSnapshot: [], references: [], resolvedReferences: [],
        profileSnapshot: { ...libraryRow.profileSnapshot, council: { ...libraryRow.profileSnapshot.council!, members: [{ id: 'reader', name: 'Reader', role: 'manager', model: 'fast', instructions: '' }] } },
        checkpoint: { ...libraryRow.checkpoint!, simple: undefined, nextTurn: 0, turns: [{ memberId: 'reader', phase: 'opening' }] } });
      return { sessionId: id, revision: libraryRow.revision, memberId: 'reader', memberName: 'Reader', turn: 0,
        ticker: 'AAPL', language: 'zh-CN', webResearch: false, expiresAt: Date.now() + 60_000 } as ResearchToolScope;
    };
    const savedReader = await reportReader();
    const [beforeReportTool] = await db.select().from(councilSessions).where(eq(councilSessions.id, savedReader.sessionId));
    const readReport = () => tools.call(owner, savedReader, { callId: randomUUID(), name: 'get_research_report', arguments: {} });
    const validReportTool = await readReport();
    assert.equal(validReportTool.status, 'succeeded');
    assert.match(JSON.stringify(validReportTool), /Fixture source-based report/u);
    const [savedReaderRow] = await db.select().from(councilSessions).where(eq(councilSessions.id, savedReader.sessionId));
    assert.deepEqual(savedReaderRow.evidenceSnapshot[0].libraryReferences, [{ sourceId: source.id, versionId: source.latestVersionId }]);
    assert.doesNotMatch(savedReaderRow.evidenceSnapshot[0].content, /Fixture source-based report/u, 'historical interpretations are not copied into verified tool facts');
    assert.equal(await publish.publish(owner, beforeReportTool, { decision: 'wait', summary: 'Derived source report', dissent: [], nextReviewCondition: 'Verify' }, 'llm', null), true,
      'publication can receive the stale pre-tool row');
    const [derivedReport] = await db.select().from(councilReports).where(eq(councilReports.sessionId, savedReader.sessionId));
    assert.deepEqual(derivedReport.evidence[0].libraryReferences, [{ sourceId: source.id, versionId: source.latestVersionId }],
      'publication must preserve dependencies appended to the current locked row during the final response');
    await db.update(councilSessions).set({ status: 'running' }).where(eq(councilSessions.id, savedReader.sessionId));
    const workflowScope = await reportReader();
    const [workflowReader] = await db.select().from(councilSessions).where(eq(councilSessions.id, workflowScope.sessionId));
    const workflowCheckpoint = { ...workflowReader.checkpoint!, workflow: { goal: 'financials' as const, peers: [], parallelism: 1 as const, recallEnabled: true } };
    await db.update(councilSessions).set({ checkpoint: workflowCheckpoint }).where(eq(councilSessions.id, workflowScope.sessionId));
    await db.insert(councilResearchTasks).values({ owner, sessionId: workflowScope.sessionId, cycleId: workflowCheckpoint.cycleId,
      revision: workflowScope.revision, position: 0, key: 'financials', memberId: 'reader', state: 'accepted', dependencies: [], skills: [],
      attempts: [{ id: randomUUID(), revision: workflowScope.revision, kind: 'work', state: 'succeeded', startedAt: new Date().toISOString(),
        messageId: randomUUID(), dispatched: true, libraryReferences: [{ sourceId: source.id, versionId: source.latestVersionId }] }] });
    const frozenWorkflowRow = { ...workflowReader, checkpoint: workflowCheckpoint };
    await library.update(owner, source.id, { enabled: false });
    const pausedTool = await tools.call(owner, await reportReader(), { callId: 'paused-report', name: 'get_research_report', arguments: {} });
    assert.equal(pausedTool.status, 'unavailable');
    assert.doesNotMatch(JSON.stringify(pausedTool), /Fixture source-based report/u);
    await library.update(owner, source.id, { enabled: true });
    await assert.rejects(service.create(other, { message: 'Foreign source', context, requestKey: 'foreign' }), /DATA_SOURCE_NOT_FOUND/u);
    await library.remove(owner, source.id);
    assert.equal(await tools.validateLibraryEvidence(owner, libraryRow.evidenceSnapshot), false);
    assert.equal(await tools.validateLibraryEvidence(owner, child.evidenceSnapshot), false);
    assert.equal((await readReport()).status, 'cancelled', 'a prior read retains its source dependency');
    const deletedTool = await tools.call(owner, await reportReader(), { callId: 'deleted-report', name: 'get_research_report', arguments: {} });
    assert.equal(deletedTool.status, 'unavailable');
    assert.doesNotMatch(JSON.stringify(deletedTool), /Fixture source-based report/u);
    await assert.rejects(publish.publish(owner, savedReaderRow, { decision: 'wait', summary: 'Must not publish', dissent: [], nextReviewCondition: 'Verify' }, 'llm', null), /RESEARCH_SOURCE_UNAVAILABLE/u);
    await assert.rejects(publish.publish(owner, frozenWorkflowRow, { decision: 'wait', summary: 'Must not publish submitted memory', dissent: [], nextReviewCondition: 'Verify' }, 'llm', null), /RESEARCH_SOURCE_UNAVAILABLE/u);
    await assert.rejects(service.create(owner, { message: 'Derived deleted source', context: { kind: 'report', documentId: derivedReport.researchVersionId! }, requestKey: 'deleted-derived-report' }), /REPORT_LIBRARY_SOURCE_UNAVAILABLE/u);
    const historical = await documents.getVersion(owner, published.researchVersionId!);
    assert.equal(historical.sourceStatus, 'missing');
    assert.match(historical.content, /Fixture source-based report/u, 'historical reading remains available');
    await assert.rejects(service.create(owner, { message: 'Deleted report source', context: { kind: 'report', documentId: published.researchVersionId! }, requestKey: 'deleted-report' }), /REPORT_LIBRARY_SOURCE_UNAVAILABLE/u);
    await assert.rejects(service.create(owner, { message: 'Deleted source', context, requestKey: 'deleted' }), /DATA_SOURCE_NOT_FOUND/u);
    await assert.rejects(council.runSession(owner, fromReport.id), /RESEARCH_SOURCE_UNAVAILABLE/u);

    // A portfolio tool scope can read owner context but never query a fabricated PORTFOLIO quote.
    const scope: ResearchToolScope = { sessionId: conversationId, revision: finished.revision, memberId: 'model-default', memberName: 'AI',
      turn: 0, ticker: 'PORTFOLIO', language: 'zh-CN', webResearch: false, expiresAt: Date.now() + 60_000 };
    assert.equal((await tools.call(owner, scope, { callId: 'scope-quote', name: 'get_quotes', arguments: {} })).status, 'unavailable');
    assert.equal((await tools.call(owner, scope, { callId: 'scope-provider', name: 'get_financial_source_data', arguments: { provider: 'alpha-vantage', operation: 'quote' } })).status, 'unavailable');
    const row = await stored();
    const secondMember = { id: 'parallel-reader', name: 'Reader', role: 'researcher' as const, model: 'fast' as const, instructions: '' };
    await db.update(councilSessions).set({ status: 'running',
      profileSnapshot: { ...row.profileSnapshot, council: { ...row.profileSnapshot.council!, members: [...row.profileSnapshot.council!.members, secondMember] } },
      checkpoint: { ...row.checkpoint!, nextTurn: 0, turns: [{ memberId: 'model-default', phase: 'opening' }, { memberId: secondMember.id, phase: 'opening' }] },
    }).where(eq(councilSessions.id, conversationId));
    const [attempt] = await db.insert(councilMemberAttempts).values({ owner, sessionId: conversationId,
      cycleId: row.checkpoint!.cycleId, memberId: secondMember.id, attempt: 1, revision: row.revision, turn: 1,
      resourceKey: 'local:fixture', inputHash: 'fixture-hash', inputSnapshot: {}, status: 'running' }).returning();
    const parallelScope = { ...scope, revision: row.revision, memberId: secondMember.id, turn: 1, attemptId: attempt.id };
    const available = await tools.bundle(owner, parallelScope);
    assert.deepEqual(available.descriptors.map(tool => tool.name).sort(), ['search_data_library', 'read_browser_source',
      'get_discussion_context', 'get_research_memory', 'get_portfolio_quotes', 'get_portfolio_financials'].sort());
    assert.equal((await tools.call(other, parallelScope, { callId: 'foreign-attempt', name: 'get_discussion_context', arguments: {} })).status, 'cancelled');
    await db.update(councilMemberAttempts).set({ status: 'completed' }).where(eq(councilMemberAttempts.id, attempt.id));
    assert.equal((await tools.call(owner, parallelScope, { callId: 'closed-attempt', name: 'get_discussion_context', arguments: {} })).status, 'cancelled');
    const [queuedAttempt] = await db.update(councilMemberAttempts).set({ status: 'queued', dispatchStarted: false }).where(eq(councilMemberAttempts.id, attempt.id)).returning();
    const [nativeRow] = await db.select().from(councilSessions).where(eq(councilSessions.id, conversationId));
    const nativeCheckpoint = { ...nativeRow.checkpoint!, nextTurn: 1, simple: { ...nativeRow.checkpoint!.simple!, stage: 'independent' as const } };
    await db.update(councilSessions).set({ checkpoint: nativeCheckpoint }).where(eq(councilSessions.id, conversationId));
    let nativePreflightTools: string[] = [];
    const native = { execute: async (nativeOwner: string, input: { researchScope?: ResearchToolScope; prompt: string;
      onDispatch: () => Promise<void>; onTask: (ref: { taskId: string }) => Promise<void> }) => {
      assert.ok(input.researchScope);
      nativePreflightTools = (await tools.bundle(nativeOwner, input.researchScope)).descriptors.map(tool => tool.name);
      assert.match(input.prompt, /financial-verification@1\.0\.0/u);
      await input.onDispatch();
      await input.onTask({ taskId: 'fixture-native-skill' });
      return { text: JSON.stringify({ content: 'Native fixture reviewed the frozen context.', evidenceIds: [], questions: [], researchRequests: [] }), taskId: 'fixture-native-skill', usageTokens: 0 };
    } };
    const nativeCouncil = new CouncilService(db, llm as never, {} as never, {} as never, {} as never, native as never,
      undefined, undefined, tools, documents);
    const runNative = nativeCouncil as unknown as { runAgentMember: (...args: unknown[]) => Promise<unknown> };
    await runNative.runAgentMember(owner, { ...nativeRow, checkpoint: nativeCheckpoint, memberAttempt: queuedAttempt },
      { ...secondMember, executionMode: 'local', agentId: 'fixture-native' }, { memberId: secondMember.id, phase: 'opening' });
    assert.ok(nativePreflightTools.includes('search_data_library'), 'queued member becomes authorized before native preflight builds tools');
    const nativeMessages = await db.select().from(councilMessages).where(eq(councilMessages.sessionId, conversationId));
    assert.ok(nativeMessages.some(message => message.metadata?.researchEvent?.kind === 'skill' && message.metadata.researchEvent.taskId === 'fixture-native-skill'));
  } finally {
    await client.end();
    await admin`DROP SCHEMA IF EXISTS ${admin(namespace)} CASCADE`;
    await admin.end();
  }
});
