import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { councilSessions } from '../../database/council.schema';
import { councilResearchTasks } from '../../database/research-workflow.schema';
import { teamCommissions } from '../../database/teams.schema';
import { makeTeamFixture } from '../teams/team-test.fixture';
import { TeamCommissionWorker } from '../teams/team-commission.worker';
import { CouncilService } from './council.service';
import type { AgentTask } from '../local-agents/local-agents.store';
import type { ResearchTaskAttempt } from '../../../shared/research-workflow.interface';

test('passive native receipt checks require exact identity and confirmed process termination without replay or free usage',
  { skip: !process.env.TEAM_TEST_DATABASE_URL }, async () => {
    const f = await makeTeamFixture();
    try {
      const prepared = await f.commission();
      const worker = new TeamCommissionWorker(f.store, f.runtime, f.commissions);
      await worker.runOnce();
      const detail = await f.commissions.detail(f.owner, prepared.team.id, prepared.created.commissionId);
      const [session] = await f.db.select().from(councilSessions).where(eq(councilSessions.id, detail.sessionId!));
      const profile = structuredClone(session.profileSnapshot);
      const member = profile.council!.members[0];
      member.executionMode = 'local'; member.agentId = 'native-codex';
      await f.db.update(councilSessions).set({ profileSnapshot: profile, status: 'paused', revision: 2 }).where(eq(councilSessions.id, session.id));
      let receipt: AgentTask | undefined, settled = true, executionCalls = 0, settleChecks = 0;
      const native = {
        store: { task: async () => { if (!receipt) throw new Error('LOCAL_TASK_NOT_FOUND'); return structuredClone(receipt); } },
        waitForTaskSettlement: async () => { settleChecks++; return settled; },
        execute: async () => { executionCalls++; throw new Error('No provider execution authorized'); },
      };
      const council = new CouncilService(f.db, {} as never, {} as never, {} as never, {} as never, native as never);
      const before = await f.db.select().from(teamCommissions).where(eq(teamCommissions.id, detail.id));
      const scenarios = ['proved_failed', 'proved_cancelled', 'missing', 'active', 'foreign', 'companion', 'unsettled_runner',
        'restart_interrupted', 'dispatch_unknown', 'fallback_close', 'missing_exit', 'later_process_running', 'command_emitted', 'doubao_ack_exit_only',
        'wrong_message', 'wrong_session', 'wrong_member', 'wrong_cycle', 'wrong_revision', 'wrong_agent', 'unsupported_provider', 'completed_result', 'accepted'] as const;
      for (const [position, scenario] of scenarios.entries()) {
        member.agentId = scenario === 'doubao_ack_exit_only' ? 'native-doubao' : scenario === 'unsupported_provider' ? 'native-claude' : 'native-codex';
        await f.db.update(councilSessions).set({ profileSnapshot: profile }).where(eq(councilSessions.id, session.id));
        const attempt: ResearchTaskAttempt = { id: randomUUID(), revision: 1, kind: 'work', startedAt: new Date().toISOString(),
          state: 'uncertain', messageId: randomUUID(), dispatched: true, remoteTaskId: randomUUID(), externalUsageUnknown: true };
        const workKey = randomUUID();
        const [task] = await f.db.insert(councilResearchTasks).values({ owner: f.owner, sessionId: session.id,
          cycleId: detail.cycleId!, revision: 1, key: 'financials', workKey, position, memberId: member.id,
          dependencies: [], skills: [], state: scenario === 'accepted' ? 'accepted' : 'uncertain', attempts: [attempt],
          ...(scenario === 'accepted' ? { acceptedAttemptId: attempt.id } : {}) }).returning();
        receipt = { id: attempt.remoteTaskId!, owner: f.owner, agentId: 'native-codex', provider: 'codex', kind: 'run',
          messageId: attempt.messageId, prompt: 'Fictional private prompt', state: 'failed', error: 'LOCAL_INTERRUPTED',
          createdAt: Date.now(), updatedAt: Date.now(), runtimeEntered: true,
          activityContext: { sessionId: session.id, revision: 1, cycleId: detail.cycleId!, memberId: member.id,
            memberName: 'Fictional native', language: 'en', turn: position },
          diagnostics: [{ id: randomUUID(), stage: 'process', status: 'failed', at: new Date().toISOString(), exitCode: 1 }] };
        settled = scenario !== 'unsettled_runner';
        if (scenario === 'proved_cancelled') receipt.state = 'cancelled';
        if (scenario === 'active') receipt.state = 'running';
        if (scenario === 'foreign') receipt.owner = f.stranger;
        if (scenario === 'companion') receipt.deviceId = randomUUID();
        if (scenario === 'restart_interrupted') receipt.diagnostics = [{ id: randomUUID(), stage: 'process', status: 'running', at: new Date().toISOString() }];
        if (scenario === 'dispatch_unknown') receipt.error = 'LOCAL_DISPATCH_UNCERTAIN';
        if (scenario === 'fallback_close') receipt.diagnostics![0].exitCode = -1;
        if (scenario === 'missing_exit') delete receipt.diagnostics![0].exitCode;
        if (scenario === 'later_process_running') receipt.diagnostics!.push({ id: randomUUID(), stage: 'process', status: 'running', at: new Date().toISOString() });
        if (scenario === 'command_emitted') receipt.commandEmitted = true;
        if (scenario === 'doubao_ack_exit_only') { receipt.agentId = 'native-doubao'; receipt.provider = 'doubao'; }
        if (scenario === 'unsupported_provider') { receipt.agentId = 'native-claude'; receipt.provider = 'claude'; }
        if (scenario === 'wrong_message') receipt.messageId = randomUUID();
        if (scenario === 'wrong_session') receipt.activityContext!.sessionId = randomUUID();
        if (scenario === 'wrong_member') receipt.activityContext!.memberId = 'other-member';
        if (scenario === 'wrong_cycle') receipt.activityContext!.cycleId = randomUUID();
        if (scenario === 'wrong_revision') receipt.activityContext!.revision = 2;
        if (scenario === 'wrong_agent') receipt.agentId = 'native-claude';
        if (scenario === 'completed_result') { receipt.state = 'completed'; receipt.text = 'Retained output needs separate validation'; }
        if (scenario === 'missing') receipt = undefined;
        const request = { action: 'check_existing' as const, requestKey: randomUUID(), expectedCommissionRevision: detail.commissionRevision,
          workKey, attemptId: attempt.id };
        await council.recoverTeamSession(f.owner, session.id, request);
        await council.recoverTeamSession(f.owner, session.id, request);
        const [saved] = await f.db.select().from(councilResearchTasks).where(eq(councilResearchTasks.id, task.id));
        const terminal = scenario === 'proved_failed' ? 'failed' : scenario === 'proved_cancelled' ? 'cancelled' : null;
        assert.equal(saved.state, terminal ?? task.state, scenario);
        assert.equal(saved.attempts[0].state, terminal ?? attempt.state, scenario);
        assert.equal(saved.attempts[0].id, attempt.id);
        assert.equal(saved.attempts[0].remoteTaskId, attempt.remoteTaskId);
        assert.equal(saved.attempts[0].externalUsageUnknown, true);
        assert.equal(saved.attempts[0].tokens, undefined, 'Unknown monetary usage is not fabricated as zero');
      }
      assert.ok(settleChecks > 0);
      assert.equal(executionCalls, 0);
      assert.deepEqual(await f.db.select().from(teamCommissions).where(eq(teamCommissions.id, detail.id)), before, 'Original budget reservation and commission identity stay unchanged');
      assert.equal((await f.db.select().from(councilSessions).where(eq(councilSessions.id, session.id)))[0].status, 'paused');
    } finally { await f.dispose(); }
  });
