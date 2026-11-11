import { randomUUID } from 'node:crypto';
import { isNull, and, eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from '../../common/platform';
import { councilSessions } from '../../database/council.schema';
import type { CouncilMember } from '../../../shared/council.interface';
import type { ThesisCandidateInput } from '../../../shared/research-memory.interface';
import type { ResearchCoverage, ResearchSkillPin, ResearchTask, ResearchTaskKind } from '../../../shared/research-workflow.interface';
import { analysisErrorCode, safeAnalysisError } from '../research-core/research-errors';
import { agentErrorMessage } from './council.native';
import { planResearchTasks } from './council.tasks';
import { teamTaskPlan } from './council.team';
import { CouncilScheduler } from './council.scheduler';
import { CouncilWorkflowExecutor, type WorkflowExecutorDependencies } from './council.workflow-executor';
import { CouncilWorkflowStore } from './council.workflow-store';
import type { CouncilEvidence, CouncilOpinion } from './council.rules';

type Session = typeof councilSessions.$inferSelect;
const terminal = new Set(['accepted', 'failed', 'blocked', 'cancelled', 'uncertain']);
export interface WorkflowCallbacks {
  get(owner: string, id: string): Promise<Session>;
  members(row: Session): CouncilMember[];
  snapshot(row: Session): Promise<{ evidence: CouncilEvidence[]; sourceRunId: string | null }>;
  publish(row: Session, opinion: CouncilOpinion, coverage: ResearchCoverage, stance?: 'positive' | 'balanced' | 'cautious', theses?: ThesisCandidateInput[]): Promise<boolean>;
  pin(key: ResearchTaskKind): ResearchSkillPin[];
}

export class CouncilWorkflow {
  readonly store: CouncilWorkflowStore;
  private readonly executor: CouncilWorkflowExecutor;
  private readonly scheduler = new CouncilScheduler();
  constructor(private readonly db: PostgresJsDatabase,
    deps: Omit<WorkflowExecutorDependencies, 'store' | 'db'>, private readonly callbacks: WorkflowCallbacks) {
    this.store = new CouncilWorkflowStore(db);
    this.executor = new CouncilWorkflowExecutor({ ...deps, db, store: this.store });
  }
  async execute(owner: string, id: string): Promise<void> {
    let row = await this.callbacks.get(owner, id);
    if (!row.checkpoint?.workflow || row.status !== 'running') return;
    const revision = row.revision;
    const members = this.callbacks.members(row);
    const manager = members.find(m => m.role === 'manager')!;
    const blockedConnections = new Map<string, string>();
    let budgetBlocked: string | undefined;
    if (!row.checkpoint?.teamContext && !row.evidenceSnapshot.length && members.some(m => m.executionMode !== 'local')) {
      const snapshot = await this.callbacks.snapshot(row);
      await this.db.update(councilSessions).set({ evidenceSnapshot: snapshot.evidence, sourceRunId: snapshot.sourceRunId }).where(and(
        isNull(councilSessions.deletedAt), eq(councilSessions.owner, owner), eq(councilSessions.id, id), eq(councilSessions.revision, revision), eq(councilSessions.status, 'running')));
      row = await this.callbacks.get(owner, id);
    }
    if (row.revision !== revision || row.status !== 'running') return;
    await this.store.initialize(row, row.checkpoint?.teamContext ? teamTaskPlan(row.checkpoint.teamContext)
      : planResearchTasks(row.checkpoint!.workflow!.goal, members), this.callbacks.pin);
    const connection = (m: CouncilMember) => m.executionMode === 'local' ? `native:${m.agentId}` : `api:${m.connectionId ?? 'default'}`;
    const run = async (task: ResearchTask, currentTasks: ResearchTask[], batch: ResearchTask[] = []) => {
      const kind = task.state === 'submitted' ? 'review' : 'work';
      const member = kind === 'review' ? members.find(m => m.id === task.reviewerMemberId) ?? manager : members.find(m => m.id === task.memberId)!;
      const key = connection(member);
      const release = await this.scheduler.acquire(owner, id, member.executionMode === 'local' ? key : undefined,
        row.checkpoint!.workflow!.parallelism, () => this.executor.active(row));
      if (!release) return;
      try {
        const reason = blockedConnections.get(key) ?? (member.executionMode !== 'local' ? budgetBlocked : undefined);
        if (reason) {
          // A submitted task keeps its delivery but needs an explicit retry of its review.
          const attempt = await this.store.claim(row, task, kind);
          if (attempt) await this.store.finish(row, task, attempt, member, { error: reason });
          return;
        }
        const attempt = await this.store.claim(row, task, kind);
        if (!attempt) return;
        const secondary = batch.find(t => t.id !== task.id);
        const secondaryAttempt = secondary ? await this.store.claim(row, secondary, 'review') : null;
        if (secondary && !secondaryAttempt) { await this.store.finish(row, task, attempt, member, { error: 'REVISION_CHANGED' }); return; }
        if (secondary && secondaryAttempt) {
          await this.store.markRemote(row, task, attempt.id, { reviewGroupId: attempt.id });
          await this.store.markRemote(row, secondary, secondaryAttempt.id, { reviewGroupId: attempt.id });
        }
        const copyBatchInventory = async () => {
          if (!secondary || !secondaryAttempt) return;
          const primary = (await this.store.list(owner, id, task.cycleId)).find(item => item.id === task.id)
            ?.attempts.find(item => item.id === attempt.id);
          if (primary?.memory) await this.store.markRemote(row, secondary, secondaryAttempt.id, {
            memory: { ...primary.memory, sharedRequestAttemptId: attempt.id }, libraryReferences: primary.libraryReferences, dispatched: primary.dispatched });
        };
        const latest = await this.callbacks.get(owner, id);
        try {
          if (latest.revision !== attempt.revision || latest.status !== 'running' || latest.checkpoint?.cycleId !== task.cycleId) {
            await this.store.finish(row, task, attempt, member, { error: 'REVISION_CHANGED' });
            if (secondary && secondaryAttempt) await this.store.finish(row, secondary, secondaryAttempt, member, { error: 'REVISION_CHANGED' });
            return;
          }
          const output = await this.executor.execute(latest, task, attempt, member, currentTasks, batch);
          await copyBatchInventory();
          await this.store.finish(row, task, attempt, member, output);
          if (secondary && secondaryAttempt) await this.store.finish(row, secondary, secondaryAttempt, member, {
            review: output.batchReviews!.find(r => r.taskId === secondary.id), tokens: 0,
            externalUsageUnknown: false, taskId: attempt.id,
          });
        } catch (error) {
          await copyBatchInventory();
          const code = error instanceof Error ? error.message : '';
          const reason = code === 'RESEARCH_CONTEXT_LIMIT' ? row.language === 'en'
            ? 'The complete instructions or deliverable exceed the research context limit. Shorten the request or split the task, then retry. Nothing was submitted.'
            : '完整指令或交付内容超过研究上下文上限。请缩短请求或拆分任务后重试，本次未提交。'
            : code === 'MEMORY_CONTEXT_CHANGED' ? row.language === 'en'
              ? 'Memory changed before submission. Start a new research cycle to refresh its versions.'
              : '记忆在提交前发生变化。请开始新一轮研究以刷新版本。'
            : code.startsWith('LOCAL_') ? agentErrorMessage(code, row.language)
            : /^(DELIVERY_|REVIEW_)/.test(code) ? (row.language === 'en'
              ? 'The deliverable did not meet the required structure or citation checks. No result was accepted. Retry explicitly after checking the model.'
              : '交付内容未通过结构或引用校验，未采纳为结论。请检查模型后手动重试。') : safeAnalysisError(error, row.language);
          if (['LOCAL_USAGE_LIMIT', 'LOCAL_RATE_LIMIT', 'LOCAL_LOGIN_REQUIRED', 'LOCAL_DISPATCH_UNCERTAIN'].includes(code)
            || /HTTP 429/.test(code)) blockedConnections.set(key, reason);
          if (analysisErrorCode(error) === 'LLM_BUDGET_EXCEEDED') budgetBlocked = reason;
          await this.store.finish(row, task, attempt, member, { error: reason });
          if (secondary && secondaryAttempt) await this.store.finish(row, secondary, secondaryAttempt, member, { error: reason });
          await this.executor.activity(row, { id: randomUUID(), taskId: attempt.id, sessionId: id, revision,
            turn: task.position, memberId: member.id, memberName: member.name, kind: 'task', status: 'failed',
            sequence: 0, at: new Date().toISOString(), summary: reason });
        }
      } finally { release(); }
    };
    // Five nodes, one business rework each and their reviews: bounded regardless of model output.
    for (let step = 0; step < (row.checkpoint?.teamContext ? Math.min(512, row.checkpoint.teamContext.plan.work.length * 8 + 8) : 32); step++) {
      row = await this.callbacks.get(owner, id);
      if (row.revision !== revision || row.status !== 'running') return;
      const tasks = await this.store.list(owner, id, row.checkpoint!.cycleId);
      const summary = tasks.find(t => t.key === 'summary');
      if (summary?.state === 'accepted' && summary.delivery) {
        const coverage: ResearchCoverage = { goal: row.checkpoint!.workflow!.goal, cycleId: row.checkpoint!.cycleId, revision,
          complete: tasks.every(t => t.state === 'accepted' && t.delivery && !t.delivery.gaps.length),
          tasks: tasks.map(({ id: taskId, key, state, acceptedAttemptId }) => ({ id: taskId, key, state, acceptedAttemptId })) };
        const partial = !coverage.complete ? row.language === 'en' ? 'Incomplete research: unresolved tasks or evidence gaps remain.\n\n' : '研究尚不完整：仍有未完成任务或关键资料缺口。\n\n' : '';
        const response = summary.delivery.response;
        await this.callbacks.publish(row, { decision: 'wait', summary: partial + [response.thesis,
          ...response.evidencePoints, ...response.risks, ...response.nextChecks, response.details].filter(Boolean).join('\n\n'),
          dissent: tasks.flatMap(t => t.delivery?.gaps ?? (t.reason ? [t.reason] : [])).slice(0, 12),
          nextReviewCondition: response.nextChecks.join('\n'), evidenceIds: summary.delivery.evidenceIds }, coverage, summary.delivery.researchStance,
        summary.delivery.thesisCandidates?.map(candidate => ({ ...candidate, provenance: { origin: 'agent',
          workflow: { cycleId: summary.cycleId, taskId: summary.id, attemptId: summary.acceptedAttemptId! } } })));
        return;
      }
      const runnable: ResearchTask[] = [];
      let changed = false;
      for (const task of tasks) {
        // Resume can leave one opening draft ready before the other. Keep their
        // reviews together; a terminal counterpart releases the surviving draft.
        if (!row.checkpoint?.teamContext && task.state === 'submitted' && ['financials', 'business'].includes(task.key)
          && tasks.some(other => other.id !== task.id && ['financials', 'business'].includes(other.key)
            && ['queued', 'running', 'needs_revision'].includes(other.state))) continue;
        if (task.state === 'submitted' || task.state === 'needs_revision') { runnable.push(task); continue; }
        if (task.state !== 'queued') continue;
        const deps = task.workKey ? (task.dependencyWorkKeys ?? []).map(key => tasks.find(t => t.workKey === key)!)
          : task.dependencies.map(key => tasks.find(t => t.key === key)!);
        if (deps.some(dep => !dep)) { await this.store.block(row, task, 'TEAM_PLAN_INVALID'); changed = true; continue; }
        if (task.key === 'summary') {
          if (deps.every(d => terminal.has(d.state))) runnable.push(task);
        } else if (deps.every(d => d.state === 'accepted')) runnable.push(task);
        else if (deps.some(d => terminal.has(d.state) && d.state !== 'accepted')) {
          await this.store.block(row, task, row.language === 'en' ? 'Waiting for an accepted prerequisite' : '前置任务尚未通过验收'); changed = true;
        }
      }
      if (runnable.length) {
        const batch = row.checkpoint?.teamContext ? [] : runnable.filter(t => ['financials', 'business'].includes(t.key) && t.state === 'submitted');
        await Promise.all(batch.length === 2 ? [run(batch[0], tasks, batch),
          ...runnable.filter(t => !batch.includes(t)).map(task => run(task, tasks))] : runnable.map(task => run(task, tasks)));
        continue;
      }
      if (changed) continue;
      const reason = tasks.find(t => t.state === 'failed')?.reason ?? (row.language === 'en'
        ? 'Research is paused. Completed deliverables are retained; review the tasks and retry explicitly. No automatic retry was started.'
        : '研究已暂停，已完成的交付会保留。请检查任务后手动重试，系统没有自动重发。');
      await this.db.update(councilSessions).set({ status: 'paused', error: reason, updatedAt: new Date() }).where(and(
        isNull(councilSessions.deletedAt), eq(councilSessions.owner, owner), eq(councilSessions.id, id), eq(councilSessions.revision, revision), eq(councilSessions.status, 'running')));
      return;
    }
    await this.db.update(councilSessions).set({ status: 'paused', error: 'WORKFLOW_STEP_LIMIT', updatedAt: new Date() }).where(and(
      isNull(councilSessions.deletedAt), eq(councilSessions.owner, owner), eq(councilSessions.id, id), eq(councilSessions.revision, revision), eq(councilSessions.status, 'running')));
  }
}
