import { and, eq, isNotNull, sql } from 'drizzle-orm';
import type { AgentRosterDatabase } from './agent-roster-context';
import { councilSessions } from './council.schema';
import { councilMemberAttempts } from './simple-council.schema';
import { councilResearchTasks } from './research-workflow.schema';
import { agentRuntimeRuns, agentRuntimeSteps } from './agent-tooling.schema';

type Session = typeof councilSessions.$inferSelect;
export interface CouncilDispatchProofOptions {
  receiptId?: string;
  workKey?: string;
  /** Final publication consumes work from this frozen cycle; it never grants a later turn. */
  publication?: boolean;
}

/** Server-owned receipts only: an archived profile cannot turn caller-supplied raw text into send authority. */
export async function hasCouncilDispatchProof(tx: AgentRosterDatabase, row: Session, memberId: string, options: CouncilDispatchProofOptions = {}): Promise<boolean> {
  if ((row.status !== 'running' && !(options.publication && row.status === 'completed')) || !row.checkpoint) return false;
  const checkpoint = row.checkpoint;
  const turnMatches = (turn: number) => options.publication || turn === checkpoint.nextTurn;
  if (!options.receiptId && checkpoint.rosterDispatches?.some(proof => proof.cycleId === checkpoint.cycleId
    && proof.revision === row.revision && proof.memberId === memberId && turnMatches(proof.turn))) return true;
  const remote = checkpoint.remote;
  const member = row.profileSnapshot.council?.members.find(item => item.id === memberId);
  if (!options.receiptId && remote?.dispatchStarted && remote.revision === row.revision && turnMatches(remote.turn)
    && member?.executionMode === 'local' && remote.agentId === member.agentId) return true;
  const attempts = await tx.select({ id: councilMemberAttempts.id, turn: councilMemberAttempts.turn }).from(councilMemberAttempts).where(and(
    eq(councilMemberAttempts.owner, row.owner), eq(councilMemberAttempts.sessionId, row.id), eq(councilMemberAttempts.cycleId, checkpoint.cycleId),
    eq(councilMemberAttempts.revision, row.revision), eq(councilMemberAttempts.memberId, memberId), eq(councilMemberAttempts.dispatchStarted, true),
    options.receiptId ? eq(councilMemberAttempts.id, options.receiptId) : undefined));
  if (attempts.some(attempt => turnMatches(attempt.turn))) return true;
  if (checkpoint.workflow) {
    const tasks = await tx.select().from(councilResearchTasks).where(and(eq(councilResearchTasks.owner, row.owner),
      eq(councilResearchTasks.sessionId, row.id), eq(councilResearchTasks.cycleId, checkpoint.cycleId), eq(councilResearchTasks.revision, row.revision),
      options.workKey ? eq(councilResearchTasks.workKey, options.workKey) : undefined));
    if (tasks.some(task => task.attempts.some(attempt => attempt.dispatched && attempt.revision === row.revision
      && (!options.receiptId || attempt.id === options.receiptId)
      && (attempt.kind === 'review' ? task.reviewerMemberId : task.memberId) === memberId))) return true;
  }
  const runs = await tx.select({ id: agentRuntimeRuns.id }).from(agentRuntimeRuns).where(and(eq(agentRuntimeRuns.owner, row.owner),
    eq(agentRuntimeRuns.cancelRequested, false), sql`${agentRuntimeRuns.identity}->>'sessionId'=${row.id}`,
    sql`${agentRuntimeRuns.identity}->>'cycleId'=${checkpoint.cycleId}`, sql`${agentRuntimeRuns.identity}->>'memberId'=${memberId}`,
    sql`${agentRuntimeRuns.identity}->>'revision'=${String(row.revision)}`,
    options.publication ? undefined : sql`${agentRuntimeRuns.identity}->>'turn'=${String(checkpoint.nextTurn)}`,
    options.receiptId && /^[\da-f-]{36}$/iu.test(options.receiptId) ? eq(agentRuntimeRuns.id, options.receiptId) : undefined));
  for (const run of runs) {
    const [response] = await tx.select({ id: agentRuntimeSteps.id }).from(agentRuntimeSteps).where(and(eq(agentRuntimeSteps.owner, row.owner),
      eq(agentRuntimeSteps.runId, run.id), isNotNull(agentRuntimeSteps.budgetId), isNotNull(agentRuntimeSteps.responseEnc)));
    if (response) return true;
  }
  return false;
}
