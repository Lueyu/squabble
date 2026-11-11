import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { makeSourceScopeFixture } from './team-source-scope.fixture';
import { filterTeamMemory } from '../research-memory/research-memory.team';
import { councilReports, councilSessions } from '../../database/council.schema';
import { researchDocuments, researchDocumentVersions } from '../../database/research-documents.schema';
import { researchMemories } from '../../database/research-memory.schema';
import { CouncilWorkflowStore } from '../council/council.workflow-store';
import { CouncilWorkflowExecutor } from '../council/council.workflow-executor';
import { teamTaskPlan } from '../council/council.team';
import { ResearchMemoryService } from '../research-memory/research-memory.service';
import { ResearchToolsService } from '../research-tools/research-tools.service';
import { readTeamSourceContents } from '../../database/team-source-context';
import type { ResearchMemoryRecallItem } from '../../../shared/research-memory.interface';

test('real team recall shares only authorized lineage and explicit output grants across an account handoff', async () => {
  const f = await makeSourceScopeFixture();
  try {
    const onlyX = [{ ...f.work[2], roleId: f.a, reviewerRoleId: f.a, inputRefs: [f.refs[0]], dependencyWorkKeys: [] }];
    const original = await f.create(onlyX, [], [f.a]);
    const past = new Date('2020-01-02');
    const [report] = await f.db.insert(councilReports).values({ owner: f.owner, sessionId: original.session.id, version: 1,
      revision: 1, decision: 'wait', summary: 'PRIVATE_X_THESIS', dissent: [], nextReviewCondition: 'Review X',
      evidence: [{ id: 'original-X', title: 'Original X evidence', content: 'PRIVATE_X_CONTENT',
        sourceUrl: 'https://fixture.invalid/X', fetchedAt: past.toISOString(),
        libraryReferences: [{ sourceId: f.sourceRows[0].id, versionId: f.refs[0].id }] }], engine: 'llm', publicationOutcome: 'succeeded', createdAt: past }).returning();
    const [document] = await f.db.insert(researchDocuments).values({ owner: f.owner, title: 'Fictional team history', kind: 'council' }).returning();
    const [output] = await f.db.insert(researchDocumentVersions).values({ owner: f.owner, reportId: document.id, version: 1,
      idempotencyKey: randomUUID(), contentHash: 'f'.repeat(64), title: document.title, kind: 'council', content: report.summary, sections: [],
      source: { type: 'council', id: report.id }, availableAt: past, dataAsOf: past, createdAt: past,
      snapshot: { teamExecutionContext: original.context, inputRefs: [] } }).returning();
    await f.client`UPDATE council_reports SET research_version_id=${output.id} WHERE id=${report.id}`;
    const item: ResearchMemoryRecallItem = { kind: 'history', id: randomUUID(), version: 1, memoryId: randomUUID(),
      summary: 'PRIVATE_X_THESIS', flags: [], citations: [], libraryReferences: [{ sourceId: f.sourceRows[0].id, versionId: f.refs[0].id }],
      source: { sessionId: original.session.id, reportId: report.id, reportVersion: 1, reportRevision: 1,
        reportCreatedAt: past.toISOString(), url: '/fixture' } };
    const mixed = await f.create();
    assert.deepEqual(await filterTeamMemory(f.db, f.owner, [item], mixed.context), [], 'B lacks X; common memory cannot reveal A’s restricted interpretation');
    const authorized = await f.create(onlyX, [], [f.a]);
    assert.deepEqual((await filterTeamMemory(f.db, f.owner, [item], authorized.context)).map(value => value.id), [item.id]);

    const ref = { kind: 'report_version' as const, id: output.id, revision: '1', availability: 'available' as const };
    const detail = await f.service.detail(f.owner, f.teamId);
    const grant = await f.sources.grant(f.owner, f.teamId, { requestKey: randomUUID(), expectedScopeRevision: detail.scopeRevision, sourceRef: ref });
    await f.publish({ ...f.config, roles: f.config.roles.map(role => role.id === f.a ? { ...role, sourceGrantIds: [...role.sourceGrantIds, grant.grant.id] } : role) });
    const before = await f.service.detail(f.owner, f.teamId);
    const release = await f.versions.bindingPreview(f.owner, f.teamId, { requestKey: randomUUID(), action: 'release', accountId: f.account.id,
      teamVersionId: f.published.version.id, expectedBindingRevision: before.bindingRevision, expectedAccountBindingId: before.binding!.id,
      executionChoice: 'keep_confirmed_rules', acknowledgePendingReapproval: true });
    await f.versions.binding(f.owner, f.teamId, { requestKey: randomUUID(), previewId: release.previewId, previewHash: release.previewHash });
    const account = await f.newAccount('Fictional next account');
    const unbound = await f.service.detail(f.owner, f.teamId);
    const assign = await f.versions.bindingPreview(f.owner, f.teamId, { requestKey: randomUUID(), action: 'assign', accountId: account.id,
      teamVersionId: f.published.version.id, expectedBindingRevision: unbound.bindingRevision, expectedAccountBindingId: null,
      executionChoice: 'keep_confirmed_rules', acknowledgePendingReapproval: true });
    await f.versions.binding(f.owner, f.teamId, { requestKey: randomUUID(), previewId: assign.previewId, previewHash: assign.previewHash });
    const noInput = [{ ...onlyX[0], inputRefs: [] }];
    const moved = await f.create(noInput, [], [f.a]);
    assert.deepEqual(await filterTeamMemory(f.db, f.owner, [item], moved.context), [], 'A current account does not inherit another account’s private memory');
    const explicitlyShared = await f.create([{ ...onlyX[0], inputRefs: [ref] }], [], [f.a]);
    assert.deepEqual((await filterTeamMemory(f.db, f.owner, [item], explicitlyShared.context)).map(value => value.id), [item.id]);

    const [storedMemory] = await f.db.insert(researchMemories).values({ owner: f.owner, ticker: 'PORTFOLIO', market: 'US', topic: 'Fictional shared report',
      language: 'zh-CN', sessionId: original.session.id, reportId: report.id, reportVersion: 1, reportRevision: 1,
      reportCreatedAt: past, summary: report.summary, decision: 'wait', createdAt: past }).returning();
    const memory = new ResearchMemoryService(f.db, { detectMarket: (ticker: string) => ({ market: 'US', displaySymbol: ticker, symbolNative: ticker }) } as never);
    const recall = await memory.recall(f.owner, { ticker: 'PORTFOLIO', asOf: explicitlyShared.context.dataCutoffAt }, explicitlyShared.context);
    assert.ok(recall.items.some(value => value.id === storedMemory.id), 'An explicit R grant permits its retained interpretation');
    const [session] = await f.db.update(councilSessions).set({ checkpoint: { ...explicitlyShared.session.checkpoint!,
      workflow: { ...explicitlyShared.session.checkpoint!.workflow!, memory: recall, recallEnabled: true } } })
      .where(eq(councilSessions.id, explicitlyShared.session.id)).returning();
    const store = new CouncilWorkflowStore(f.db);
    await store.initialize(session, teamTaskPlan(explicitlyShared.context), () => []);
    const [task] = await store.list(f.owner, session.id, session.checkpoint!.cycleId);
    const attempt = await store.claim(session, task, 'work');
    assert.ok(attempt);
    const member = session.profileSnapshot.council!.members[0];
    const tools = new ResearchToolsService(f.db, {} as never, {} as never, memory);
    const blocked = await tools.call(f.owner, { teamId: f.teamId, sessionId: session.id, revision: session.revision, memberId: member.id,
      memberName: member.name, turn: task.position, ticker: session.ticker, language: session.language, webResearch: false, expiresAt: Date.now() + 60000 },
    { callId: 'no-direct-X', name: 'read_browser_source', arguments: { sourceId: f.sourceRows[0].id } });
    assert.equal(blocked.status, 'unavailable', 'Reading R does not grant direct access to X');
    const reply = async (messages: Array<{ content: string }>, _owner: string, options: { onDispatch?: () => Promise<void> }) => {
      await options.onDispatch?.();
      const input = JSON.parse(messages[1].content) as { skills: unknown[] };
      assert.match(messages[1].content, /PRIVATE_X_THESIS/);
      return { tokens: 10, tokensKnown: true, data: { conclusion: 'Fictional conclusion from R', evidenceIds: [ref.id],
        asOf: '2020-01-02T00:00:00.000Z', currency: 'USD', units: 'USD', assumptions: [], gaps: [], skillVersions: input.skills,
        response: { thesis: 'Fictional conclusion from R', evidencePoints: ['R preserves original interpretation'], risks: ['Uncertainty'], nextChecks: ['Review X'] } } };
    };
    const executor = new CouncilWorkflowExecutor({ db: f.db, store, memory, activity: async () => undefined,
      llm: { getInputLimit: async () => 20000, chatSlowJSON: reply, chatFastJSON: reply } as never });
    const result = await executor.execute(session, task, attempt, member, await store.list(f.owner, session.id, session.checkpoint!.cycleId));
    await store.finish(session, task, attempt, member, result);
    const [accepted] = await store.list(f.owner, session.id, session.checkpoint!.cycleId);
    assert.equal(accepted.state, 'accepted');
    assert.ok(accepted.attempts[0].libraryReferences?.some(value => value.versionId === f.refs[0].id), 'Indirect X provenance remains in the submitted attempt');
    const adopted = await f.decisions.create(f.owner, f.teamId, { requestKey: randomUUID(), expectedProposalRevision: 0,
      commissionId: explicitlyShared.commission.id, event: 'adopt', reason: 'Adopt the exact R-based accepted work',
      basis: { teamVersionId: explicitlyShared.context.teamVersionId, bindingId: explicitlyShared.context.bindingId,
        bindingRevision: explicitlyShared.context.bindingRevision, commissionId: explicitlyShared.commission.id, sessionId: session.id,
        cycleId: session.checkpoint!.cycleId, workKey: task.workKey!, acceptedAttemptId: accepted.acceptedAttemptId!, reportVersionId: null,
        thesisVersions: [], sourceRefs: [] } });
    assert.deepEqual(adopted.basis.sourceRefs, [ref], 'R carries live indirect provenance without pretending X is a direct grant');
    const current = await f.service.detail(f.owner, f.teamId);
    await f.sources.revoke(f.owner, f.teamId, f.grantIds[0], { requestKey: randomUUID(), expectedScopeRevision: current.scopeRevision, reason: 'Revoke X ancestor' });
    await assert.rejects(readTeamSourceContents(f.db, f.owner, f.teamId, [ref], new Date().toISOString()), /Report dependency chain|TEAM_SOURCE_UNAVAILABLE/);
  } finally { await f.dispose(); }
});
