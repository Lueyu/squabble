import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AgentRosterService } from './agent-roster.service';
import { makeTeamFixture } from '../teams/team-test.fixture';
import { TeamCommissionWorker } from '../teams/team-commission.worker';
import { TeamRuntimeAdapter } from '../teams/team-runtime-adapter';
import { CouncilService } from '../council/council.service';
import type { TeamDetail } from '../../../shared/team-workspace.interface';

test('commissions and their runtime freeze the selected person independently of subsequent identity edits', {
  skip: !process.env.TEAM_TEST_DATABASE_URL,
}, async () => {
  const f = await makeTeamFixture();
  try {
    const roster = new AgentRosterService(f.db);
    const agent = await roster.create(f.owner, {
      requestKey: 'team-person', name: 'Fictional fox', avatar: 'news',
      executor: { executionMode: 'model', connectionId: f.connection.id, model: 'slow' },
      instructions: 'Verify cash flow.', preferences: { language: 'en', userPreferences: 'Be concise.' },
      allowedToolIds: [], allowedSources: [],
    });
    const initial = await f.team();
    const detail = await f.service.detail(f.owner, initial.team.id);
    const config = {
      ...detail.draft.config,
      roles: detail.draft.config.roles.map(role => ({ ...role, agentId: agent.id, agentVersionId: agent.currentVersionId })),
    };
    const saved = await f.service.save(f.owner, initial.team.id, 'draft', {
      requestKey: randomUUID(), expectedSemanticRevision: detail.semanticRevision, config,
    }) as TeamDetail;
    const publishPreview = await f.versions.publishPreview(f.owner, saved.id, {
      requestKey: randomUUID(), expectedSemanticRevision: saved.semanticRevision,
    });
    const published = await f.versions.publish(f.owner, saved.id, {
      requestKey: randomUUID(), previewId: publishPreview.previewId, previewHash: publishPreview.previewHash,
    });
    const account = await f.account();
    const bindingPreview = await f.versions.bindingPreview(f.owner, saved.id, {
      requestKey: randomUUID(), action: 'assign', accountId: account.id, teamVersionId: published.version.id,
      expectedBindingRevision: 0, expectedAccountBindingId: null,
      executionChoice: 'keep_confirmed_rules', acknowledgePendingReapproval: true,
    });
    const bound = await f.versions.binding(f.owner, saved.id, {
      requestKey: randomUUID(), previewId: bindingPreview.previewId, previewHash: bindingPreview.previewHash,
    });
    const plan = {
      teamVersionId: published.version.id, bindingId: bound.binding!.id, expectedBindingRevision: bound.team.bindingRevision,
      leadRoleId: initial.role, participantRoleIds: [initial.role], supervisorRoleIds: [],
      objective: 'Fictional cash flow research', expectedOutput: 'Evidence', dataCutoffAt: null,
      deadlineAt: new Date(Date.now() + 3600000).toISOString(), parallelism: 1, inputRefs: [], conflictResolutions: [],
      work: [{ workKey: 'summary', roleId: initial.role, taskKind: 'summary', objective: 'Summarize fixture',
        expectedOutput: 'Report', dependencyWorkKeys: [], reviewerRoleId: initial.role, reviewMode: 'self_check', inputRefs: [], requestedByRoleIds: [] }],
      budget: { budgetMode: 'cost_and_calls', ceiling: { amount: '1', currency: 'USD' }, callLimit: 2, paidRevisionLimit: 0 },
    };
    async function commission() {
      const preview = await f.commissions.preview(f.owner, saved.id, { ...plan, requestKey: randomUUID() });
      const request = { requestKey: randomUUID(), previewId: preview.previewId, previewHash: preview.previewHash };
      const created = await f.commissions.create(f.owner, saved.id, request);
      assert.deepEqual(await f.commissions.create(f.owner, saved.id, request), created);
      return f.commissions.detail(f.owner, saved.id, created.commissionId);
    }
    const old = await commission();
    assert.equal(old.members[0].avatar, 'news');
    assert.equal(old.members[0].agentName, 'Fictional fox');
    assert.match(old.members[0].agentInstructions!, /Be concise/u);
    await roster.update(f.owner, agent.id, {
      requestKey: 'animal-and-name', expectedRevision: agent.revision, avatar: 'growth', name: 'Fictional rabbit',
    });
    const next = await commission();
    assert.equal(next.members[0].avatar, 'growth');
    assert.equal(next.members[0].agentName, 'Fictional rabbit');
    // Prepare through the real Council method; stopping after this job sends no model request.
    const council = new CouncilService(f.db, undefined!, undefined!, undefined!, undefined!);
    const runtime = new TeamRuntimeAdapter(council);
    const worker = new TeamCommissionWorker(f.store, runtime, f.commissions);
    await worker.runOnce();
    const [session] = await f.client`SELECT profile_snapshot FROM council_sessions WHERE team_commission_id=${old.id}`;
    assert.equal(session.profile_snapshot.council.members[0].avatar, 'news');
    assert.equal(session.profile_snapshot.council.members[0].name, 'Fictional fox');
    assert.equal(session.profile_snapshot.council.members[0].rosterAgentId, agent.id);
    assert.match(session.profile_snapshot.council.members[0].instructions, /Be concise/u);
    assert.equal((await roster.history(f.owner, agent.id)).items.length, 1);
  } finally { await f.dispose(); }
});
