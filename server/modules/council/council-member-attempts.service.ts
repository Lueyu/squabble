import { ConflictException, NotFoundException } from '@nestjs/common';
import { isNull, and, desc, eq, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from '../../common/platform';
import { councilSessions } from '../../database/council.schema';
import { councilMemberAttempts } from '../../database/simple-council.schema';
import type { ResearchMemberState, SafeFailure } from '../../../shared/research-execution.interface';
export type MemberAttempt = typeof councilMemberAttempts.$inferSelect;
export interface MemberClaim { owner: string; sessionId: string; cycleId: string; memberId: string; revision: number; turn: number;
  resourceKey: string; inputHash: string; inputSnapshot: Record<string, unknown>; retry?: boolean }

/** Every dispatch is preceded by an owner/session locked durable receipt. */
export class CouncilMemberAttemptsService {
  constructor(private readonly db: PostgresJsDatabase) {}
  async list(owner: string, sessionId: string, cycleId?: string): Promise<MemberAttempt[]> {
    return this.db.select().from(councilMemberAttempts).where(and(eq(councilMemberAttempts.owner, owner), eq(councilMemberAttempts.sessionId, sessionId),
      cycleId ? eq(councilMemberAttempts.cycleId, cycleId) : undefined)).orderBy(councilMemberAttempts.createdAt, councilMemberAttempts.attempt);
  }
  async get(owner: string, id: string): Promise<MemberAttempt> {
    const [row] = await this.db.select().from(councilMemberAttempts).where(and(eq(councilMemberAttempts.owner, owner), eq(councilMemberAttempts.id, id)));
    if (!row) throw new NotFoundException('Member attempt not found'); return row;
  }
  async claim(input: MemberClaim): Promise<MemberAttempt | null> {
    return this.db.transaction(async tx => {
      const [session] = await tx.select().from(councilSessions).where(and(isNull(councilSessions.deletedAt), eq(councilSessions.owner, input.owner), eq(councilSessions.id, input.sessionId))).for('update');
      if (!session || session.status !== 'running' || session.revision !== input.revision || session.checkpoint?.cycleId !== input.cycleId) return null;
      const previous = await tx.select().from(councilMemberAttempts).where(and(eq(councilMemberAttempts.owner, input.owner),
        eq(councilMemberAttempts.sessionId, input.sessionId), eq(councilMemberAttempts.cycleId, input.cycleId))).orderBy(desc(councilMemberAttempts.attempt));
      const active = previous.filter(row => row.status === 'queued' || row.status === 'running' || row.status === 'unknown');
      const prior = previous.find(row => row.memberId === input.memberId);
      if (active.length >= 2 || active.some(row => row.resourceKey === input.resourceKey && input.resourceKey.startsWith('local:')) || prior && !input.retry) return null;
      if (prior && (!['failed','cancelled','skipped'].includes(prior.status) || prior.failure?.recoveries.includes('check_existing'))) throw new ConflictException('ORIGINAL_TASK_NOT_TERMINATED');
      const { retry: _retry, ...values } = input;
      const [created] = await tx.insert(councilMemberAttempts).values({ ...values, attempt: (prior?.attempt ?? 0) + 1 }).returning(); return created;
    });
  }
  async update(owner: string, id: string, change: Partial<Pick<MemberAttempt, 'taskId'|'dispatchStarted'|'rawText'|'tokensUsed'|'status'|'resultAcceptance'|'failure'|'startedAt'|'completedAt'>>): Promise<boolean> {
    const rows = await this.db.update(councilMemberAttempts).set({ ...change, updatedAt: new Date() }).where(and(eq(councilMemberAttempts.owner, owner), eq(councilMemberAttempts.id, id),
      sql`exists(select 1 from council_sessions s where s.owner=${owner} and s.id=${councilMemberAttempts.sessionId} and s.deleted_at IS NULL and s.status='running' and s.revision=${councilMemberAttempts.revision} and s.checkpoint->>'cycleId'=${councilMemberAttempts.cycleId}::text)`,
      sql`${councilMemberAttempts.attempt}=(select max(a.attempt) from council_member_attempts a where a.owner=${owner} and a.session_id=${councilMemberAttempts.sessionId} and a.cycle_id=${councilMemberAttempts.cycleId} and a.member_id=${councilMemberAttempts.memberId})`)).returning({ id: councilMemberAttempts.id });
    return rows.length > 0;
  }
  settle(owner: string, id: string, change: { status: MemberAttempt['status']; resultAcceptance: MemberAttempt['resultAcceptance']; failure?: SafeFailure | null }) {
    return this.update(owner, id, { ...change, completedAt: new Date() });
  }
  /** A stop fences result acceptance immediately; termination may be acknowledged later. */
  async settleStopped(owner: string, id: string, uncertain: boolean): Promise<void> {
    await this.db.update(councilMemberAttempts).set({ status: uncertain ? 'unknown' : 'cancelled',
      failure: uncertain ? { code: 'LOCAL_DISPATCH_UNCERTAIN', stage: 'runtime', recoveries: ['check_existing'] }
        : { code: 'LOCAL_CANCELLED', stage: 'runtime', recoveries: ['retry_member'] },
      completedAt: uncertain ? null : new Date(), updatedAt: new Date() }).where(and(eq(councilMemberAttempts.owner, owner), eq(councilMemberAttempts.id, id),
      sql`${councilMemberAttempts.status} in ('queued','running','unknown')`,
      sql`exists(select 1 from council_sessions s where s.owner=${owner} and s.id=${councilMemberAttempts.sessionId} and s.deleted_at IS NULL and s.status='paused' and s.revision>${councilMemberAttempts.revision} and s.checkpoint->'simple'->>'stopped'='true')`));
  }
  publicState(row: MemberAttempt): ResearchMemberState {
    return { memberId: row.memberId, attempt: row.attempt, ...(row.taskId ? { taskId: row.taskId } : {}), status: row.status,
      resultAcceptance: row.resultAcceptance, ...(row.failure ? { failure: row.failure } : {}), recoveries: row.failure?.recoveries ?? [],
      ...(row.startedAt ? { startedAt: row.startedAt.toISOString() } : {}), lastActivityAt: row.updatedAt.toISOString(),
      ...(row.completedAt ? { completedAt: row.completedAt.toISOString() } : {}) };
  }
}
