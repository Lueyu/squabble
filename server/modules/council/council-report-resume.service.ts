import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { and, eq, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from '../../common/platform';
import { councilMessages, councilSessions } from '../../database/council.schema';
import { councilIndependentSubmissions, councilMemberAttempts, simpleCouncilRequests } from '../../database/simple-council.schema';
import { experiencePreferences, researchCurrentViews } from '../../database/simple-experience.schema';
import { automaticResearchTasks } from '../../database/investment-policy.schema';
import { llmBudgetSettings } from '../../database/llm-budget.schema';
import { lockMemoryOwner } from '../research-memory/research-memory.fence';
import type { LocalAgentsService } from '../local-agents/local-agents.service';
import type { AgentTask } from '../local-agents/local-agents.store';
import type { ResumeDailyReportInput } from '../../../shared/simple-conversation.interface';
import type { CouncilCheckpoint, DialogueTurn } from './council.types';
import type { CouncilEvidence } from './council.rules';
import { agentAssignment } from './council.native';
import { threadPromptContext } from './council.thread';
import { normalizeCouncil } from '../paper-trading/agent-builder.rules';

type StoredSession = typeof councilSessions.$inferSelect;
export function dailyReportContextHash(evidence: CouncilEvidence[], row: StoredSession): string {
  return createHash('sha256').update(JSON.stringify({ evidence: evidence.map(({ id, content }) => ({ id, content })),
    references: row.references, resolvedReferences: row.resolvedReferences })).digest('hex');
}
export function savedResultHash(value: string): string { return createHash('sha256').update(value).digest('hex'); }

/** Accept only a completed task for this exact frozen member/turn/evidence assignment. */
export function assertSavedDailyResult(task: AgentTask, row: StoredSession, history: Array<typeof councilMessages.$inferSelect>): void {
  const checkpoint = row.checkpoint, remote = checkpoint?.remote, turn = checkpoint?.turns[checkpoint.nextTurn];
  const council = row.profileSnapshot.council;
  const members = council && council.members.length < 2 ? council.members : normalizeCouncil(council).members;
  const member = members.find(item => item.id === turn?.memberId);
  if (!checkpoint || !remote || !turn || !member || !task.text?.trim() || task.state !== 'completed' || task.error
    || task.owner !== row.owner || task.id !== remote.taskId || task.agentId !== remote.agentId || task.agentId !== member.agentId
    || task.messageId !== remote.messageId || task.activityContext?.sessionId !== row.id || task.activityContext.cycleId !== checkpoint.cycleId
    || task.activityContext.turn !== checkpoint.nextTurn || task.activityContext.revision !== remote.revision
    || task.activityContext.memberId !== member.id || task.activityContext.language !== row.language) throw new ConflictException('SAVED_TASK_CONTEXT_MISMATCH');
  let assignment: Record<string, unknown>;
  try { assignment = JSON.parse(task.prompt.split('\n').at(-1)!); } catch { throw new BadRequestException('SAVED_TASK_CONTEXT_UNAVAILABLE'); }
  const expected: Record<string, unknown> = JSON.parse(agentAssignment({ ticker: row.ticker, language: row.language, member, turn,
    thread: threadPromptContext(row), candidate: row.candidate, messages: history.filter(message => message.role !== 'system').map(message => ({ ...message,
      ...(row.checkpoint?.simple && message.metadata?.claims ? { content: `${message.content}\nPublic claims: ${JSON.stringify(message.metadata.claims)}` } : {}) })),
    evidence: row.evidenceSnapshot }).split('\n').at(-1)!);
  if (!assignment || typeof assignment !== 'object' || ['ticker', 'language', 'member', 'turn', 'thread', 'candidate', 'evidence', 'messages']
    .some(key => !isDeepStrictEqual(assignment[key], expected[key]))) throw new ConflictException('SAVED_TASK_CONTEXT_MISMATCH');
}

/** Compare the actual retained wire assignment, never the intended input snapshot alone. */
function hasCompleteOwnerContext(task: AgentTask, frozen: CouncilEvidence[]): boolean {
  let assignment: unknown;
  try { assignment = JSON.parse(task.prompt.split('\n').at(-1)!); } catch { return false; }
  if (!assignment || typeof assignment !== 'object' || !('evidence' in assignment) || !Array.isArray(assignment.evidence)) return false;
  const provided = assignment.evidence;
  return frozen.every(fact => provided.some((raw: unknown) => !!raw && typeof raw === 'object'
    && 'id' in raw && raw.id === fact.id && 'content' in raw && raw.content === fact.content));
}

/** The command owns a durable receipt; reads and startup never schedule this continuation. */
export class CouncilReportResumeService {
  constructor(private readonly db: PostgresJsDatabase, private readonly agents?: LocalAgentsService,
    private readonly refreshReferences?: (row: StoredSession) => Promise<void>) {}

  async reserve(owner: string, id: string, input: ResumeDailyReportInput) {
    const inputHash = createHash('sha256').update(JSON.stringify({ operation: 'resume-report', id,
      requestKey: input.requestKey, expectedRevision: input.expectedRevision })).digest('hex');
    return this.db.transaction(async tx => {
      await lockMemoryOwner(tx, owner);
      const [row] = await tx.select().from(councilSessions).where(and(eq(councilSessions.owner, owner), eq(councilSessions.id, id))).for('update');
      if (!row) throw new NotFoundException('Research conversation not found');
      const [prior] = await tx.select().from(simpleCouncilRequests).where(and(eq(simpleCouncilRequests.owner, owner), eq(simpleCouncilRequests.requestKey, input.requestKey)));
      if (prior) {
        if (prior.inputHash !== inputHash || prior.sessionId !== id) throw new ConflictException('REQUEST_KEY_CONFLICT');
        return { created: false, row };
      }
      if (row.revision !== input.expectedRevision) throw new ConflictException('RESEARCH_REVISION_CHANGED');
      const checkpoint = row.checkpoint, simple = checkpoint?.simple, remote = checkpoint?.remote;
      // The create receipt and frozen context can commit before the first dispatch. Only an explicit command starts it.
      if (simple?.overallDaily && simple.researchOnly && !simple.stopped && !simple.initializing
        && ['idle', 'paused', 'failed'].includes(row.status) && checkpoint && !checkpoint.inflight && !remote
        && simple.stage === 'independent' && checkpoint.nextTurn === 0 && (simple.calls ?? 0) === 0
        && checkpoint.turns.length > 0 && checkpoint.turns.every(turn => turn.phase === 'opening')) {
        const [preferences] = await tx.select().from(experiencePreferences).where(eq(experiencePreferences.owner, owner));
        if (preferences?.enabled === false) throw new BadRequestException('RESEARCH_PAUSED');
        const attempts = await tx.select({ id: councilMemberAttempts.id }).from(councilMemberAttempts).where(and(
          eq(councilMemberAttempts.owner, owner), eq(councilMemberAttempts.sessionId, id), eq(councilMemberAttempts.cycleId, checkpoint.cycleId)));
        const submissions = await tx.select({ id: councilIndependentSubmissions.id }).from(councilIndependentSubmissions).where(and(
          eq(councilIndependentSubmissions.owner, owner), eq(councilIndependentSubmissions.sessionId, id), eq(councilIndependentSubmissions.cycleId, checkpoint.cycleId)));
        if (attempts.length || submissions.length) throw new ConflictException('ORIGINAL_TASK_NOT_TERMINATED');
        if (!(simple.commonEvidence ?? row.evidenceSnapshot).some(fact => fact.sourceName === 'Frozen owner context')) throw new BadRequestException('SAVED_OWNER_CONTEXT_UNAVAILABLE');
        await this.refreshReferences?.(row);
        const [active] = await tx.update(councilSessions).set({ status: 'running', revision: row.revision + 1, checkpoint, error: null, updatedAt: new Date() })
          .where(and(eq(councilSessions.owner, owner), eq(councilSessions.id, id))).returning();
        await tx.insert(simpleCouncilRequests).values({ owner, requestKey: input.requestKey, inputHash, sessionId: id });
        return { created: true, row: active };
      }
      // After all openings initially fail, explicit per-member recovery can fill the original sealed barrier.
      // Releasing that completed barrier is bookkeeping; it must not dispatch the openings a second time.
      if (simple?.overallDaily && simple.researchOnly && !simple.stopped && ['failed', 'paused'].includes(row.status)
        && simple.stage === 'waiting' && checkpoint && !checkpoint.inflight && !remote?.taskId
        && checkpoint.turns.length > 0 && checkpoint.turns.every(turn => turn.phase === 'opening')
        && checkpoint.nextTurn >= checkpoint.turns.length) {
        const [preferences] = await tx.select().from(experiencePreferences).where(eq(experiencePreferences.owner, owner));
        if (preferences?.enabled === false) throw new BadRequestException('RESEARCH_PAUSED');
        const outstanding = await tx.select({ id: councilMemberAttempts.id }).from(councilMemberAttempts).where(and(
          eq(councilMemberAttempts.owner, owner), eq(councilMemberAttempts.sessionId, id), eq(councilMemberAttempts.cycleId, checkpoint.cycleId),
          sql`${councilMemberAttempts.status} IN ('queued','running','unknown')`));
        if (outstanding.length) throw new ConflictException('ORIGINAL_TASK_NOT_TERMINATED');
        const accepted = await tx.select({ memberId: councilIndependentSubmissions.memberId }).from(councilIndependentSubmissions).where(and(
          eq(councilIndependentSubmissions.owner, owner), eq(councilIndependentSubmissions.sessionId, id), eq(councilIndependentSubmissions.cycleId, checkpoint.cycleId)));
        const members = row.profileSnapshot.council?.members ?? [];
        if (!accepted.length || members.some(member => !accepted.some(item => item.memberId === member.id) && !simple.unavailable.some(item => item.memberId === member.id))) {
          throw new BadRequestException('SAVED_DAILY_REPORT_NOT_RESUMABLE');
        }
        if ((simple.calls ?? 0) + 2 > 12) throw new BadRequestException('AUTOMATIC_TASK_CALL_LIMIT');
        if (!(simple.commonEvidence ?? row.evidenceSnapshot).some(fact => fact.sourceName === 'Frozen owner context')) throw new BadRequestException('SAVED_OWNER_CONTEXT_UNAVAILABLE');
        await this.refreshReferences?.(row);
        const next: CouncilCheckpoint = { ...checkpoint, simple: { ...simple, stage: 'independent' } };
        const [active] = await tx.update(councilSessions).set({ status: 'running', revision: row.revision + 1, checkpoint: next, error: null, updatedAt: new Date() })
          .where(and(eq(councilSessions.owner, owner), eq(councilSessions.id, id))).returning();
        await tx.insert(simpleCouncilRequests).values({ owner, requestKey: input.requestKey, inputHash, sessionId: id });
        return { created: true, row: active };
      }
      const pendingApi = checkpoint?.turns[checkpoint.nextTurn];
      const apiMember = row.profileSnapshot.council?.members.find(member => member.id === pendingApi?.memberId);
      // An explicitly retried API gate resumes only its retained turn, never the independent barrier or a new cycle.
      if (simple?.overallDaily && simple.researchOnly && !simple.stopped && ['failed', 'paused'].includes(row.status)
        && checkpoint && !checkpoint.inflight && !remote?.taskId && pendingApi && ['challenge', 'summary'].includes(pendingApi.phase)
        && apiMember && apiMember.executionMode !== 'local') {
        const [preferences] = await tx.select().from(experiencePreferences).where(eq(experiencePreferences.owner, owner));
        if (preferences?.enabled === false) throw new BadRequestException('RESEARCH_PAUSED');
        if ((simple.calls ?? 0) >= 12) throw new BadRequestException('AUTOMATIC_TASK_CALL_LIMIT');
        if (!(simple.commonEvidence ?? row.evidenceSnapshot).some(fact => fact.sourceName === 'Frozen owner context')) throw new BadRequestException('SAVED_OWNER_CONTEXT_UNAVAILABLE');
        await this.refreshReferences?.(row);
        const [active] = await tx.update(councilSessions).set({ status: 'running', revision: row.revision + 1, checkpoint, error: null, updatedAt: new Date() })
          .where(and(eq(councilSessions.owner, owner), eq(councilSessions.id, id))).returning();
        await tx.insert(simpleCouncilRequests).values({ owner, requestKey: input.requestKey, inputHash, sessionId: id });
        return { created: true, row: active };
      }
      if (row.status !== 'paused' || row.scene !== 'portfolio_daily' || !simple?.researchOnly || simple.stopped || !checkpoint || !remote?.taskId) {
        throw new BadRequestException('SAVED_DAILY_REPORT_NOT_RESUMABLE');
      }
      const [preferences] = await tx.select().from(experiencePreferences).where(eq(experiencePreferences.owner, owner));
      if (preferences?.enabled === false) throw new BadRequestException('RESEARCH_PAUSED');
      if (checkpoint.inflight || remote.turn !== checkpoint.nextTurn || !this.agents) throw new ConflictException('ORIGINAL_TASK_NOT_TERMINATED');
      const terminal = await this.agents.store.task(owner, remote.taskId);
      if (!terminal || !['failed', 'cancelled', 'completed'].includes(terminal.state)
        || ['LOCAL_INTERRUPTED', 'LOCAL_DISPATCH_UNCERTAIN', 'LOCAL_PAUSED'].includes(terminal.error ?? '')
        || terminal.messageId !== remote.messageId || terminal.agentId !== remote.agentId
        || terminal.activityContext?.sessionId !== id || terminal.activityContext?.cycleId !== checkpoint.cycleId
        || terminal.activityContext?.turn !== remote.turn || terminal.activityContext?.revision !== remote.revision
        || terminal.activityContext?.memberId !== checkpoint.turns[checkpoint.nextTurn]?.memberId) throw new ConflictException('ORIGINAL_TASK_NOT_TERMINATED');
      const pending = checkpoint.turns[checkpoint.nextTurn];
      if (!pending || !['summary', 'challenge'].includes(pending.phase)) throw new BadRequestException('SAVED_DAILY_REPORT_NOT_RESUMABLE');
      const frozen = (simple.commonEvidence ?? row.evidenceSnapshot).filter(fact => fact.sourceName === 'Frozen owner context');
      if (!frozen.length) throw new BadRequestException('SAVED_OWNER_CONTEXT_UNAVAILABLE');
      await this.refreshReferences?.(row);
      const digest = dailyReportContextHash(frozen, row);
      const activate = async (next: CouncilCheckpoint) => {
        const [active] = await tx.update(councilSessions).set({ status: 'running', revision: row.revision + 1, checkpoint: next, error: null, updatedAt: new Date() })
          .where(and(eq(councilSessions.owner, owner), eq(councilSessions.id, id))).returning();
        await tx.update(researchCurrentViews).set({ state: 'generating', error: null, updatedAt: new Date() }).where(and(
          eq(researchCurrentViews.owner, owner), eq(researchCurrentViews.taskId, id), eq(researchCurrentViews.taskKind, 'daily_research')));
        await tx.insert(simpleCouncilRequests).values({ owner, requestKey: input.requestKey, inputHash, sessionId: id });
        return { created: true, row: active };
      };
      const budgetFor = async (additionalCalls: number) => {
        if ((simple.calls ?? 0) + additionalCalls > 12) throw new BadRequestException('AUTOMATIC_TASK_CALL_LIMIT');
        const automaticTaskId = checkpoint.automaticTaskId ?? simple.automaticTaskId;
        if (!automaticTaskId || additionalCalls === 0) return;
        const [automatic] = await tx.select().from(automaticResearchTasks).where(and(eq(automaticResearchTasks.owner, owner), eq(automaticResearchTasks.id, automaticTaskId))).for('update');
        const [budget] = await tx.select().from(llmBudgetSettings).where(eq(llmBudgetSettings.owner, owner));
        if (!automatic || automatic.state !== 'claimed' || automatic.calls + additionalCalls > Math.min(12, budget?.enabled ? budget.maxCallsPerTask : 12)) {
          throw new BadRequestException('AUTOMATIC_TASK_CALL_LIMIT');
        }
      };
      if (terminal.state === 'completed') {
        const history = await tx.select().from(councilMessages).where(and(eq(councilMessages.owner, owner), eq(councilMessages.sessionId, id))).orderBy(councilMessages.createdAt);
        assertSavedDailyResult(terminal, row, history);
        if (history.some(message => message.metadata?.taskId === terminal.id)) throw new ConflictException('SAVED_RESULT_ALREADY_ACCEPTED');
        const correction = simple.inputCorrection;
        if (correction && (correction.contextHash !== digest || pending.phase === 'challenge' && correction.challengeTurn !== checkpoint.nextTurn)) {
          throw new ConflictException('SAVED_TASK_CONTEXT_MISMATCH');
        }
        await budgetFor(pending.phase === 'challenge' ? 1 : 0);
        return activate({ ...checkpoint, inflight: undefined, remote: { ...remote, reparseExisting: {
          promptHash: savedResultHash(terminal.prompt), resultHash: savedResultHash(terminal.text!), contextHash: digest } },
          simple: { ...simple, ...(correction && pending.phase === 'challenge' ? {
            inputCorrection: { ...correction, revision: row.revision + 1, revalidated: false },
          } : {}) } });
      }
      const submissions = await tx.select().from(councilIndependentSubmissions).where(and(eq(councilIndependentSubmissions.owner, owner),
        eq(councilIndependentSubmissions.sessionId, id), eq(councilIndependentSubmissions.cycleId, checkpoint.cycleId)));
      const incomplete: string[] = [];
      for (const submission of submissions) {
        if (!submission.taskId) throw new BadRequestException('SAVED_TASK_CONTEXT_UNAVAILABLE');
        const task = await this.agents.store.task(owner, submission.taskId);
        if (!task || task.activityContext?.sessionId !== id || task.activityContext?.cycleId !== checkpoint.cycleId
          || task.activityContext?.memberId !== submission.memberId) throw new BadRequestException('SAVED_TASK_CONTEXT_MISMATCH');
        if (!hasCompleteOwnerContext(task, frozen)) incomplete.push(task.id);
      }
      const previous = simple.inputCorrection;
      const checks = previous ? await tx.select({ revision: councilMessages.revision, metadata: councilMessages.metadata }).from(councilMessages)
        .where(and(eq(councilMessages.owner, owner), eq(councilMessages.sessionId, id))) : [];
      const revalidated = previous?.contextHash === digest && checks.some(message => message.revision === previous.revision
        && message.metadata?.cycleId === checkpoint.cycleId && message.metadata.turn === previous.challengeTurn && message.metadata.reverseCheck);
      const needsCheck = pending.phase === 'challenge' || incomplete.length > 0 && !revalidated;
      const members = row.profileSnapshot.council?.members ?? [];
      const checker = members.find(member => member.role === 'challenger') ?? members.at(-1);
      const manager = members.find(member => member.role === 'manager') ?? members.at(-1);
      if (!checker || !manager) throw new BadRequestException('MEMBER_NOT_IN_CONVERSATION');
      const additions: DialogueTurn[] = [...(needsCheck ? [{ memberId: checker.id, phase: 'challenge' as const }] : []), { memberId: manager.id, phase: 'summary' }];
      await budgetFor(additions.length);
      const revision = row.revision + 1;
      const correction = incomplete.length ? revalidated ? { ...previous!, revalidated: true } : {
        originalIndependentContextComplete: false as const, contextHash: digest, sourceTaskIds: incomplete,
        revision, challengeTurn: checkpoint.turns.length, revalidated: false,
      } : previous;
      const next: CouncilCheckpoint = { ...checkpoint, turns: [...checkpoint.turns, ...additions], nextTurn: checkpoint.turns.length,
        remote: undefined, inflight: undefined, pendingResearch: [], simple: { ...simple, stage: 'discussion', inputCorrection: correction } };
      return activate(next);
    });
  }
}
