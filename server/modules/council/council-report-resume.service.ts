import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from '../../common/platform';
import { councilMessages, councilSessions } from '../../database/council.schema';
import { councilIndependentSubmissions, simpleCouncilRequests } from '../../database/simple-council.schema';
import { experiencePreferences, researchCurrentViews } from '../../database/simple-experience.schema';
import { automaticResearchTasks } from '../../database/investment-policy.schema';
import { llmBudgetSettings } from '../../database/llm-budget.schema';
import { lockMemoryOwner } from '../research-memory/research-memory.fence';
import type { LocalAgentsService } from '../local-agents/local-agents.service';
import type { AgentTask } from '../local-agents/local-agents.store';
import type { ResumeDailyReportInput } from '../../../shared/simple-conversation.interface';
import type { CouncilCheckpoint, DialogueTurn } from './council.types';
import type { CouncilEvidence } from './council.rules';

type StoredSession = typeof councilSessions.$inferSelect;
function contextHash(evidence: CouncilEvidence[], row: StoredSession): string {
  return createHash('sha256').update(JSON.stringify({ evidence: evidence.map(({ id, content }) => ({ id, content })),
    references: row.references, resolvedReferences: row.resolvedReferences })).digest('hex');
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
      if (row.status !== 'paused' || row.scene !== 'portfolio_daily' || !simple?.researchOnly || simple.stopped || !checkpoint || !remote?.taskId) {
        throw new BadRequestException('SAVED_DAILY_REPORT_NOT_RESUMABLE');
      }
      const [preferences] = await tx.select().from(experiencePreferences).where(eq(experiencePreferences.owner, owner));
      if (preferences?.enabled === false) throw new BadRequestException('RESEARCH_PAUSED');
      if (checkpoint.inflight || remote.turn !== checkpoint.nextTurn || !this.agents) throw new ConflictException('ORIGINAL_TASK_NOT_TERMINATED');
      const terminal = await this.agents.store.task(owner, remote.taskId);
      if (!terminal || !['failed', 'cancelled'].includes(terminal.state)
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
      const digest = contextHash(frozen, row);
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
      if ((simple.calls ?? 0) + additions.length > 12) throw new BadRequestException('AUTOMATIC_TASK_CALL_LIMIT');
      const automaticTaskId = checkpoint.automaticTaskId ?? simple.automaticTaskId;
      if (automaticTaskId) {
        const [automatic] = await tx.select().from(automaticResearchTasks).where(and(eq(automaticResearchTasks.owner, owner), eq(automaticResearchTasks.id, automaticTaskId))).for('update');
        const [budget] = await tx.select().from(llmBudgetSettings).where(eq(llmBudgetSettings.owner, owner));
        if (!automatic || automatic.state !== 'claimed' || automatic.calls + additions.length > Math.min(12, budget?.enabled ? budget.maxCallsPerTask : 12)) {
          throw new BadRequestException('AUTOMATIC_TASK_CALL_LIMIT');
        }
      }
      const revision = row.revision + 1;
      const correction = incomplete.length ? revalidated ? { ...previous!, revalidated: true } : {
        originalIndependentContextComplete: false as const, contextHash: digest, sourceTaskIds: incomplete,
        revision, challengeTurn: checkpoint.turns.length, revalidated: false,
      } : previous;
      const next: CouncilCheckpoint = { ...checkpoint, turns: [...checkpoint.turns, ...additions], nextTurn: checkpoint.turns.length,
        remote: undefined, inflight: undefined, pendingResearch: [], simple: { ...simple, stage: 'discussion', inputCorrection: correction } };
      const [active] = await tx.update(councilSessions).set({ status: 'running', revision, checkpoint: next, error: null, updatedAt: new Date() })
        .where(and(eq(councilSessions.owner, owner), eq(councilSessions.id, id))).returning();
      // Only the receipt still pointing at this exact daily session may follow its recovery.
      // Keep prior readable material and the current generation identity intact.
      await tx.update(researchCurrentViews).set({ state: 'generating', error: null, updatedAt: new Date() }).where(and(
        eq(researchCurrentViews.owner, owner), eq(researchCurrentViews.taskId, id), eq(researchCurrentViews.taskKind, 'daily_research')));
      await tx.insert(simpleCouncilRequests).values({ owner, requestKey: input.requestKey, inputHash, sessionId: id });
      return { created: true, row: active };
    });
  }
}
