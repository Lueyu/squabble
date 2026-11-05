import { lockMemoryOwner } from '../research-memory/research-memory.fence';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from '../../common/platform';
import { councilMessages, councilSessions } from '../../database/council.schema';
import { councilResearchTasks } from '../../database/research-workflow.schema';
import type { CouncilMember } from '../../../shared/council.interface';
import type { ResearchDelivery, ResearchSkillPin, ResearchTask, ResearchTaskAttempt, ResearchTaskKind, ResearchTaskState } from '../../../shared/research-workflow.interface';
import type { TaskPlan } from './council.tasks';
import type { CouncilEvidence } from './council.rules';
import { packMemoryContext } from '../research-memory/research-memory.context';

type Session = typeof councilSessions.$inferSelect;
type TaskRow = typeof councilResearchTasks.$inferSelect;
const mapTask = (row: TaskRow): ResearchTask => ({ ...row, updatedAt: row.updatedAt.toISOString() });
export class CouncilWorkflowStore {
  constructor(private readonly db: PostgresJsDatabase) {}
  async list(owner: string, sessionId: string, cycleId: string): Promise<ResearchTask[]> {
    const rows = await this.db.select().from(councilResearchTasks).where(and(eq(councilResearchTasks.owner, owner),
      eq(councilResearchTasks.sessionId, sessionId), eq(councilResearchTasks.cycleId, cycleId))).orderBy(councilResearchTasks.position);
    return rows.map(mapTask);
  }
  async initialize(row: Session, plans: TaskPlan[], skills: (key: ResearchTaskKind) => ResearchSkillPin[]): Promise<void> {
    await this.db.transaction(async tx => {
      await lockMemoryOwner(tx, row.owner);
      const [current] = await tx.select().from(councilSessions).where(and(eq(councilSessions.owner, row.owner), eq(councilSessions.id, row.id))).for('update');
      if (current?.revision !== row.revision || current.status !== 'running' || current.checkpoint?.cycleId !== row.checkpoint?.cycleId) return;
      await tx.insert(councilResearchTasks).values(plans.map(plan => ({ ...plan, owner: row.owner, sessionId: row.id,
        cycleId: row.checkpoint!.cycleId, revision: row.revision, skills: skills(plan.key) }))).onConflictDoNothing();
    });
  }
  async recover(): Promise<void> {
    // Unknown outcomes require an explicit user restart; provider side effects may already be billable.
    await this.db.update(councilResearchTasks).set({ state: 'uncertain', reason: 'SERVER_RESTARTED', updatedAt: new Date(),
      attempts: sql`(SELECT coalesce(jsonb_agg(CASE WHEN a->>'state' = 'running' THEN a || '{"state":"uncertain"}'::jsonb ELSE a END), '[]'::jsonb) FROM jsonb_array_elements(${councilResearchTasks.attempts}) a)` })
      .where(eq(councilResearchTasks.state, 'running'));
  }
  async rebase(owner: string, row: Session, selected?: ResearchTaskKind[]): Promise<void> {
    await this.db.transaction(async tx => {
      await lockMemoryOwner(tx, row.owner);
      const [session] = await tx.select().from(councilSessions).where(and(eq(councilSessions.owner, owner), eq(councilSessions.id, row.id))).for('update');
      if (session?.revision !== row.revision || session.status !== 'running') return;
      const tasks = await tx.select().from(councilResearchTasks).where(and(eq(councilResearchTasks.owner, owner),
        eq(councilResearchTasks.sessionId, row.id), eq(councilResearchTasks.cycleId, row.checkpoint!.cycleId))).for('update');
      for (const task of tasks) {
        const reset = selected ? selected.includes(task.key) : task.state !== 'accepted';
        const attempts = task.attempts.map(a => a.state === 'running' ? { ...a, state: 'cancelled' as const, finishedAt: new Date().toISOString() } : a);
        await tx.update(councilResearchTasks).set({ revision: row.revision, attempts, updatedAt: new Date(),
          ...(reset ? { state: task.delivery && task.attempts.at(-1)?.kind === 'review' ? 'submitted' as const : 'queued' as const,
            reason: null, acceptedAttemptId: null, ...(task.attempts.at(-1)?.kind === 'review' ? {} : { delivery: null }) } : {}) })
          .where(and(eq(councilResearchTasks.owner, owner), eq(councilResearchTasks.id, task.id)));
      }
    });
  }
  async claim(row: Session, task: ResearchTask, kind: 'work' | 'review'): Promise<ResearchTaskAttempt | null> {
    return this.db.transaction(async tx => {
      await lockMemoryOwner(tx, row.owner);
      const [session] = await tx.select().from(councilSessions).where(and(eq(councilSessions.owner, row.owner), eq(councilSessions.id, row.id))).for('update');
      if (session?.status !== 'running' || session.revision !== row.revision || session.checkpoint?.cycleId !== task.cycleId) return null;
      const [current] = await tx.select().from(councilResearchTasks).where(and(eq(councilResearchTasks.owner, row.owner), eq(councilResearchTasks.id, task.id))).for('update');
      if (!current || current.revision !== row.revision || !(kind === 'review' ? ['submitted'] : ['queued', 'needs_revision']).includes(current.state)) return null;
      // Bound explicit retries too. Every paid attempt continues to consume the root budget.
      if (current.attempts.length >= 12) {
        await tx.update(councilResearchTasks).set({ state: 'failed', reason: 'ATTEMPT_LIMIT' }).where(eq(councilResearchTasks.id, task.id)); return null;
      }
      const attempt: ResearchTaskAttempt = { id: randomUUID(), messageId: randomUUID(), kind, revision: row.revision, startedAt: new Date().toISOString(), state: 'running',
        memory: packMemoryContext([], 0, undefined, { requested: kind === 'review' ? [] : row.checkpoint?.workflow?.memory?.items }).inventory };
      await tx.update(councilResearchTasks).set({ state: 'running', attempts: [...current.attempts, attempt], updatedAt: new Date() }).where(eq(councilResearchTasks.id, task.id));
      return attempt;
    });
  }
  async markRemote(row: Session, task: ResearchTask, attemptId: string, patch: Partial<ResearchTaskAttempt>, dispatch = false): Promise<void> {
    await this.db.transaction(async tx => {
      await lockMemoryOwner(tx, row.owner);
      const [session] = await tx.select().from(councilSessions).where(and(eq(councilSessions.owner, row.owner), eq(councilSessions.id, row.id))).for('update');
      const [current] = await tx.select().from(councilResearchTasks).where(and(eq(councilResearchTasks.owner, row.owner), eq(councilResearchTasks.id, task.id))).for('update');
      if (!current || !current.attempts.some(a => a.id === attemptId)) throw new Error('LOCAL_PAUSED');
      if (dispatch && (session?.revision !== row.revision || session.status !== 'running' || session.checkpoint?.cycleId !== task.cycleId
        || current.revision !== row.revision || current.state !== 'running' || current.attempts.at(-1)?.id !== attemptId
        || current.attempts.at(-1)?.state !== 'running')) throw new Error('LOCAL_PAUSED');
      await tx.update(councilResearchTasks).set({ attempts: current.attempts.map(a => a.id === attemptId ? { ...a, ...patch } : a), updatedAt: new Date() }).where(eq(councilResearchTasks.id, task.id));
    });
  }
  async finish(row: Session, task: ResearchTask, attempt: ResearchTaskAttempt, member: CouncilMember, result: {
    delivery?: ResearchDelivery; review?: { accepted: boolean; feedback: string }; error?: string;
    tokens?: number; taskId?: string; externalUsageUnknown?: boolean; sources?: CouncilEvidence[];
  }): Promise<boolean> {
    return this.db.transaction(async tx => {
      await lockMemoryOwner(tx, row.owner);
      const [session] = await tx.select().from(councilSessions).where(and(eq(councilSessions.owner, row.owner), eq(councilSessions.id, row.id))).for('update');
      const [current] = await tx.select().from(councilResearchTasks).where(and(eq(councilResearchTasks.owner, row.owner), eq(councilResearchTasks.id, task.id))).for('update');
      if (!current) return false;
      const fresh = session?.status === 'running' && session.revision === row.revision && session.checkpoint?.cycleId === task.cycleId
        && current.revision === row.revision && current.attempts.at(-1)?.id === attempt.id;
      const attempts = current.attempts.map(a => a.id === attempt.id ? { ...a, ...result, externalAgent: member.executionMode === 'local',
        state: !fresh ? 'cancelled' as const : result.error ? 'failed' as const : 'succeeded' as const, finishedAt: new Date().toISOString() } : a);
      if (!fresh) {
        await tx.update(councilResearchTasks).set({ attempts,
          ...(current.revision === row.revision && current.attempts.at(-1)?.id === attempt.id ? { state: 'cancelled' as const, reason: 'REVISION_CHANGED' } : {}) }).where(eq(councilResearchTasks.id, task.id)); return false;
      }
      const accepted = result.review?.accepted === true || (task.key === 'summary' && !!result.delivery);
      const needsRevision = result.review?.accepted === false && current.reworks < 1;
      const state: ResearchTaskState = result.error ? 'failed' : accepted ? 'accepted' : result.review
        ? needsRevision ? 'needs_revision' : 'failed' : 'submitted';
      const delivery = result.delivery ?? current.delivery;
      const memory = attempts.find(item => item.id === attempt.id)?.memory;
      await tx.update(councilResearchTasks).set({ attempts, state, delivery, reason: result.error ?? result.review?.feedback ?? null,
        reworks: current.reworks + (needsRevision ? 1 : 0), acceptedAttemptId: accepted ? (result.delivery ? attempt.id
          : [...current.attempts].reverse().find(a => a.kind === 'work' && a.state === 'succeeded')?.id ?? null) : null,
        updatedAt: new Date() }).where(eq(councilResearchTasks.id, task.id));
      if (result.delivery) {
        const response = result.delivery.response;
        await tx.insert(councilMessages).values({ owner: row.owner, sessionId: row.id, role: member.role, memberName: member.name,
          content: result.delivery.conclusion, revision: row.revision, tokensUsed: result.tokens ?? 0,
          metadata: { memory, referenceSnapshot: row.references, cycleId: task.cycleId, turn: task.position, memberId: member.id, taskId: attempt.id,
            phase: task.key === 'summary' ? 'summary' : task.key === 'challenge' ? 'challenge' : 'opening', response,
            evidenceIds: result.delivery.evidenceIds, externalAgent: member.executionMode === 'local', externalUsageUnknown: result.externalUsageUnknown } });
      }
      if (result.review) await tx.insert(councilMessages).values({ owner: row.owner, sessionId: row.id, role: member.role,
        memberName: member.name, content: result.review.feedback, revision: row.revision, tokensUsed: result.tokens ?? 0,
        metadata: { memory, referenceSnapshot: row.references, cycleId: task.cycleId, turn: task.position, memberId: member.id, taskId: attempt.id, phase: 'response',
          response: { thesis: `${row.language === 'en' ? result.review.accepted ? 'Accepted. ' : 'Revision required. '
            : result.review.accepted ? '验收通过。' : '需要修订。'}${result.review.feedback}`, evidencePoints: [], risks: [], nextChecks: [] },
          evidenceIds: current.delivery?.evidenceIds ?? [], externalAgent: member.executionMode === 'local', externalUsageUnknown: result.externalUsageUnknown } });
      if (result.sources?.length) await tx.update(councilSessions).set({
        evidenceSnapshot: [...session.evidenceSnapshot, ...result.sources].slice(-120), updatedAt: new Date(),
      }).where(eq(councilSessions.id, row.id));
      return true;
    });
  }
  async block(row: Session, task: ResearchTask, reason: string): Promise<void> {
    await this.db.update(councilResearchTasks).set({ state: 'blocked', reason, updatedAt: new Date() }).where(and(
      eq(councilResearchTasks.owner, row.owner), eq(councilResearchTasks.id, task.id), eq(councilResearchTasks.revision, row.revision),
      eq(councilResearchTasks.state, 'queued')));
  }
}
