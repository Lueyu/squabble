import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { eq } from 'drizzle-orm';
import { councilMessages, councilSessions } from '../../database/council.schema';
import { councilResearchTasks } from '../../database/research-workflow.schema';
import { ResearchToolsService } from '../research-tools/research-tools.service';
import { DataLibraryService } from '../data-library/data-library.service';
import { CouncilWorkflowStore } from '../council/council.workflow-store';
import { CouncilWorkflowExecutor } from '../council/council.workflow-executor';
import type { CouncilEvidence } from '../council/council.rules';
import type { ResearchToolScope } from '../../../shared/research-tools.interface';
import type { TeamMemberSnapshot, TeamWorkItem } from '../../../shared/team-workspace.interface';
import { makeSourceScopeFixture } from './team-source-scope.fixture';

test('published member ceilings govern previews, real tool context, executor citations and assigned non-manager review', async () => {
  const f = await makeSourceScopeFixture();
  try {
    const denied = (error: unknown): boolean => {
      const body = (error as { getResponse?: () => unknown })?.getResponse?.() as Record<string, unknown> | undefined;
      return body?.code === 'TEAM_SCOPE_REVOKED' && body.roleId === f.b && body.field === 'sourceGrantIds';
    };
    for (const mutate of [
      (work: TeamWorkItem[]) => { work[0].roleId = f.b; work[0].reviewerRoleId = f.b; },
      (work: TeamWorkItem[]) => { work[0].reviewerRoleId = f.b; work[0].reviewMode = 'independent'; },
      (work: TeamWorkItem[]) => { work[1].dependencyWorkKeys = ['X']; },
    ]) {
      const work = structuredClone(f.work); mutate(work);
      await assert.rejects(f.preview(work), denied);
    }
    await assert.rejects(f.preview(f.work, [f.refs[0]]), denied);
    const preview = await f.preview();
    const members = preview.result.members as TeamMemberSnapshot[];
    assert.deepEqual(new Set(members.find(member => member.roleId === f.a)!.sourceGrantIds), new Set(f.grantIds.slice(0, 2)));
    assert.deepEqual(members.find(member => member.roleId === f.b)!.sourceGrantIds, [f.grantIds[1]]);
    assert.ok(members.every(member => !member.sourceGrantIds.includes(f.grantIds[2])), 'Unused published Z permission is not frozen into the commission');

    async function running() {
      const created = await f.create();
      const row = created.session;
      const xWork = created.commission.plan.work.find(work => work.objective === 'Handle X')!;
      const yWork = created.commission.plan.work.find(work => work.objective === 'Handle Y')!;
      const xAttempt = { id: randomUUID(), revision: row.revision, kind: 'work' as const, startedAt: new Date().toISOString(),
        state: 'succeeded' as const, messageId: randomUUID(), dispatched: true };
      await f.db.insert(councilResearchTasks).values(created.commission.plan.work.map((work, position) => ({
        owner: f.owner, sessionId: row.id, cycleId: row.checkpoint!.cycleId, revision: row.revision,
        key: work.taskKind, position, memberId: created.context.members.find(member => member.roleId === work.roleId)!.memberId,
        reviewerMemberId: created.context.members.find(member => member.roleId === work.reviewerRoleId)!.memberId,
        dependencies: [], dependencyWorkKeys: work.dependencyWorkKeys, workKey: work.workKey, assignment: work,
        state: work.workKey === xWork.workKey ? 'accepted' as const : 'queued' as const, skills: [],
        attempts: work.workKey === xWork.workKey ? [xAttempt] : [],
        acceptedAttemptId: work.workKey === xWork.workKey ? xAttempt.id : null,
      })));
      const store = new CouncilWorkflowStore(f.db);
      const tasks = await store.list(f.owner, row.id, row.checkpoint!.cycleId);
      const yTask = tasks.find(task => task.workKey === yWork.workKey)!;
      const attempt = await store.claim(row, yTask, 'work');
      assert.ok(attempt);
      const evidence: CouncilEvidence[] = [
        ...f.refs.map((ref, index) => ({ id: ref.id, title: `Fictional ${index}`, content: `PRIVATE_${['X', 'Y', 'Z'][index]}_CONTENT`,
          role: 'news', evidenceType: 'other', sourceUrl: null, sourceName: 'Explicit team source', fetchedAt: '2020-01-01T00:00:00.000Z',
          relevanceScore: 1, libraryReferences: [{ sourceId: f.sourceRows[index].id, versionId: ref.id }] })),
        { id: `native:${xAttempt.id}:0`, title: 'A native X fact', content: 'PRIVATE_X_NATIVE', role: 'news', evidenceType: 'other',
          sourceUrl: null, sourceName: 'Native fixture', fetchedAt: '2020-01-01T00:00:00.000Z', relevanceScore: 1, teamWorkKey: xWork.workKey },
      ];
      const [session] = await f.db.update(councilSessions).set({ evidenceSnapshot: evidence }).where(eq(councilSessions.id, row.id)).returning();
      await f.db.insert(councilMessages).values([
        { id: xAttempt.messageId, owner: f.owner, sessionId: row.id, role: 'researcher', memberName: 'Role A', revision: row.revision,
          content: 'PRIVATE_X_MESSAGE', metadata: { phase: 'summary', taskId: xAttempt.id } },
        { id: attempt.messageId, owner: f.owner, sessionId: row.id, role: 'researcher', memberName: 'Role B', revision: row.revision,
          content: 'PRIVATE_Y_MESSAGE', metadata: { phase: 'summary', taskId: attempt.id } },
      ]);
      const member = session.profileSnapshot.council!.members.find(member => member.id === yTask.memberId)!;
      const scope: ResearchToolScope = { teamId: f.teamId, sessionId: session.id, revision: session.revision,
        memberId: member.id, memberName: member.name, turn: yTask.position, ticker: session.ticker,
        language: session.language, webResearch: false, expiresAt: Date.now() + 60000, memoryReferences: [] };
      return { ...created, session, store, task: yTask, tasks: await store.list(f.owner, row.id, row.checkpoint!.cycleId), attempt, member, scope };
    }

    const tools = new ResearchToolsService(f.db, {} as never, {} as never,
      { getPreferences: async () => ({ autoArchive: false, recallEnabled: false }) } as never,
      new DataLibraryService(f.db, (async () => assert.fail('No external provider may be called by this fixture')) as never));
    const first = await running();
    assert.equal(await tools.isCurrent(f.owner, first.scope), true);
    const context = await tools.call(f.owner, first.scope, { callId: 'fixture-context', name: 'get_discussion_context', arguments: { limit: 12 } });
    assert.equal(context.status, 'succeeded');
    const serialized = JSON.stringify(context.data);
    assert.match(serialized, /PRIVATE_Y_CONTENT/); assert.match(serialized, /PRIVATE_Y_MESSAGE/);
    assert.doesNotMatch(serialized, /PRIVATE_X_|PRIVATE_Z_/);
    assert.equal(serialized.includes(f.refs[0].id), false);

    const execute = async (run: Awaited<ReturnType<typeof running>>, evidenceId: string) => {
      let captured = '';
      const reply = async (messages: Array<{ content: string }>, _owner: string, options: { onDispatch?: () => Promise<void> }) => {
        await options.onDispatch?.(); captured = messages[1].content;
        const input = JSON.parse(captured) as { skills: unknown[] };
        return { data: { conclusion: 'Fictional Y conclusion', evidenceIds: [evidenceId], asOf: '2020-01-01T00:00:00.000Z',
          currency: 'USD', units: 'USD', assumptions: [], gaps: [], skillVersions: input.skills,
          response: { thesis: 'Fictional Y thesis', evidencePoints: ['Fictional Y fact'], risks: ['Uncertainty'], nextChecks: ['Next filing'] } },
          tokens: 10, tokensKnown: true };
      };
      const executor = new CouncilWorkflowExecutor({ db: f.db, store: run.store,
        llm: { getInputLimit: async () => 20000, chatFastJSON: reply, chatSlowJSON: reply } as never,
        activity: async () => undefined });
      const promise = executor.execute(run.session, run.task, run.attempt, run.member, run.tasks);
      return { promise, prompt: () => captured };
    };
    const rejected = await execute(first, f.refs[0].id);
    await assert.rejects(rejected.promise, /DELIVERY_CITATION_INVALID/);
    assert.doesNotMatch(rejected.prompt(), /PRIVATE_X_|PRIVATE_Z_/);
    assert.match(rejected.prompt(), /PRIVATE_Y_CONTENT/);
    await first.store.finish(first.session, first.task, first.attempt, first.member, { error: 'DELIVERY_CITATION_INVALID', tokens: 10 });

    const second = await running();
    const accepted = await execute(second, f.refs[1].id);
    const delivery = await accepted.promise;
    assert.deepEqual(delivery.delivery!.evidenceIds, [f.refs[1].id]);
    assert.doesNotMatch(accepted.prompt(), /PRIVATE_X_|PRIVATE_Z_/);
    assert.match(accepted.prompt(), /PRIVATE_Y_CONTENT/);
    await second.store.finish(second.session, second.task, second.attempt, second.member, delivery);
    const submitted = (await second.store.list(f.owner, second.session.id, second.session.checkpoint!.cycleId)).find(task => task.id === second.task.id)!;
    assert.equal(submitted.state, 'submitted');
    const review = await second.store.claim(second.session, submitted, 'review');
    assert.ok(review); assert.notEqual(second.member.role, 'manager');
    assert.equal(await tools.isCurrent(f.owner, second.scope), true, 'The explicitly assigned non-manager reviewer retains real tool authority');
  } finally { await f.dispose(); }
});
