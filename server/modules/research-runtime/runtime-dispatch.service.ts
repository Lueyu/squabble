import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '../../common/platform';
import { LlmBudgetService } from '../llm-budget/llm-budget.service';
import { agentRuntimeRuns } from '../../database/agent-tooling.schema';
import { councilSessions } from '../../database/council.schema';
import { councilMemberAttempts } from '../../database/simple-council.schema';
import { automaticResearchTasks } from '../../database/investment-policy.schema';
import { llmBudgetSettings } from '../../database/llm-budget.schema';
import { lockMemoryOwner } from '../research-memory/research-memory.fence';

type Tx = Parameters<Parameters<PostgresJsDatabase['transaction']>[0]>[0];
export interface RuntimeDispatchRequest {
  owner: string; runId: string; dispatchKey: string; requestHash: string; model: string;
  request: { maxOutputTokens?: number };
}

/** Journal receipt and model reservation commit in the caller's dispatch transaction. */
@Injectable()
export class RuntimeDispatchService {
  constructor(private readonly budgets: LlmBudgetService, @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase) {}
  async reserve(tx: Tx, input: RuntimeDispatchRequest): Promise<{ budgetId: string }> {
    await lockMemoryOwner(tx, input.owner);
    const [run] = await tx.select().from(agentRuntimeRuns).where(and(eq(agentRuntimeRuns.owner, input.owner), eq(agentRuntimeRuns.id, input.runId)));
    if (!run || run.cancelRequested) throw new ConflictException('RUNTIME_DISPATCH_SCOPE_INVALID');
    if (run.policy.purpose === 'capability_probe') {
      if (run.policy.maxSteps !== 2) throw new ConflictException('RUNTIME_PROBE_LIMIT_INVALID');
      const reservation = await this.budgets.reserve(input.owner, { taskId: input.runId, purpose: 'explicit-tool-capability-probe',
        model: input.model, dispatchKey: input.dispatchKey, requestHash: input.requestHash,
        messages: [{ role: 'user', content: JSON.stringify(input.request) }], maxOutputTokens: 200 }, undefined, tx);
      return { budgetId: reservation.id };
    }
    const sessionId = String(run.identity.sessionId);
    const [session] = await tx.select().from(councilSessions).where(and(eq(councilSessions.owner, input.owner),
      eq(councilSessions.id, sessionId), isNull(councilSessions.deletedAt))).for('update');
    if (!session || session.status !== 'running' || session.revision !== run.identity.revision
      || session.checkpoint?.cycleId !== run.identity.cycleId) throw new ConflictException('RUNTIME_DISPATCH_SCOPE_INVALID');
    const reservation = await this.budgets.reserve(input.owner, {
      taskId: session.taskId ?? input.runId, purpose: 'controlled-research-step', model: input.model,
      dispatchKey: input.dispatchKey, requestHash: input.requestHash,
      // Count schemas, calls and results, including non-text message parts.
      messages: [{ role: 'user', content: JSON.stringify(input.request) }],
      maxOutputTokens: input.request.maxOutputTokens,
    }, undefined, tx);
    if (!reservation.replayed) {
      const attemptId = run.policy.memberAttemptId;
      if (typeof attemptId === 'string') {
        const recorded = await tx.update(councilMemberAttempts).set({ dispatchStarted: true, taskId: input.runId,
          status: 'running', startedAt: new Date(), updatedAt: new Date() }).where(and(
          eq(councilMemberAttempts.owner, input.owner), eq(councilMemberAttempts.id, attemptId),
          eq(councilMemberAttempts.sessionId, sessionId), eq(councilMemberAttempts.revision, session.revision),
          eq(councilMemberAttempts.cycleId, String(run.identity.cycleId)),
          eq(councilMemberAttempts.memberId, String(run.identity.memberId)), eq(councilMemberAttempts.status, 'running'),
        )).returning({ id: councilMemberAttempts.id });
        if (!recorded.length) throw new ConflictException('RUNTIME_MEMBER_ATTEMPT_CHANGED');
      }
      const automaticId = session.checkpoint?.automaticTaskId ?? session.checkpoint?.simple?.automaticTaskId;
      if (automaticId) {
        const [task] = await tx.select().from(automaticResearchTasks).where(and(eq(automaticResearchTasks.owner, input.owner), eq(automaticResearchTasks.id, automaticId))).for('update');
        const [settings] = await tx.select().from(llmBudgetSettings).where(eq(llmBudgetSettings.owner, input.owner));
        if (!task || task.state !== 'claimed' || task.calls >= Math.min(12, settings?.enabled ? settings.maxCallsPerTask : 12)) throw new Error('AUTOMATIC_TASK_CALL_LIMIT');
        await tx.update(automaticResearchTasks).set({ calls: task.calls + 1 }).where(and(eq(automaticResearchTasks.owner, input.owner), eq(automaticResearchTasks.id, automaticId)));
      }
      if (session.checkpoint?.simple) {
        const calls = session.checkpoint.simple.calls ?? 0;
        if (calls >= 12) throw new Error('AUTOMATIC_TASK_CALL_LIMIT');
        await tx.update(councilSessions).set({ checkpoint: sql`jsonb_set(${councilSessions.checkpoint},'{simple,calls}',${JSON.stringify(calls + 1)}::jsonb)` })
          .where(and(eq(councilSessions.owner, input.owner), eq(councilSessions.id, sessionId)));
      }
    }
    return { budgetId: reservation.id };
  }
  async settle(owner: string, budgetId: string, usage: { inputTokens: number | null; outputTokens: number | null; totalTokens?: number | null } | null, failed = false): Promise<void> {
    const known = usage && usage.inputTokens !== null && Number.isSafeInteger(usage.inputTokens) && usage.inputTokens > 0
      && usage.outputTokens !== null && Number.isSafeInteger(usage.outputTokens) && usage.outputTokens >= 0
      && (usage.totalTokens === null || usage.totalTokens === undefined
        || Number.isSafeInteger(usage.totalTokens) && usage.totalTokens >= usage.inputTokens + usage.outputTokens);
    await this.budgets.settle(owner, budgetId, known
      ? { prompt_tokens: usage.inputTokens, completion_tokens: usage.outputTokens,
        ...(usage.totalTokens !== null && usage.totalTokens !== undefined ? { total_tokens: usage.totalTokens } : {}) } : undefined, failed);
  }
}
