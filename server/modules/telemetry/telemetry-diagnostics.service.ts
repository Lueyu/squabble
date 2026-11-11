import { Inject, Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '../../common/platform';
import { councilReports, councilSessions } from '../../database/council.schema';
import { councilMemberAttempts } from '../../database/simple-council.schema';
import { councilResearchTasks } from '../../database/research-workflow.schema';
import type { TelemetryDiagnostics } from '../../../shared/telemetry-diagnostics.interface';
import type { TelemetryRun } from '../../../shared/telemetry.interface';
import type { ResearchTaskAttempt } from '../../../shared/research-workflow.interface';
import type { LocalAgentsService } from '../local-agents/local-agents.service';
import { TelemetryService } from './telemetry.service';
import { diagnosticSnapshot, diagnosticTask, workflowDiagnosticAcceptance, type DiagnosticTaskReference } from './telemetry-diagnostics.rules';

const MAX_TASKS = 128;
type WorkflowAttempt = Pick<ResearchTaskAttempt, 'id' | 'revision' | 'kind' | 'state' | 'startedAt' | 'finishedAt' | 'remoteTaskId' | 'externalAgent' | 'reviewGroupId'>
  & { reviewAccepted: boolean | null };

/** Full, bounded persisted snapshots are safe to poll/reconnect; reading never dispatches or recovers work. */
@Injectable()
export class TelemetryDiagnosticsService {
  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly telemetry: TelemetryService, private readonly moduleRef: ModuleRef) {}

  private localAgents(): LocalAgentsService | undefined {
    try {
      // Resolve lazily, matching research-core, so telemetry capture never imports the local/tools module graph.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const token = (require('../local-agents/local-agents.service') as typeof import('../local-agents/local-agents.service')).LocalAgentsService;
      return this.moduleRef.get<LocalAgentsService>(token, { strict: false });
    } catch { return undefined; }
  }

  async read(owner: string, id: string): Promise<TelemetryDiagnostics> {
    // This check must precede even looking up a retained local task. It enforces owner and source tombstones.
    const detail = await this.telemetry.detail(owner, id);
    const source = await this.references(owner, detail.run);
    const references = source.references.slice(0, MAX_TASKS);
    await this.associations(owner, references);
    const agents = references.some(reference => reference.remoteTaskId && !reference.ambiguous) ? this.localAgents() : undefined;
    const tasks = await Promise.all(references.map(async reference => {
      const task = reference.remoteTaskId && !reference.ambiguous && agents ? await agents.getTaskDiagnostics(owner, reference.remoteTaskId).catch(() => undefined) : undefined;
      return diagnosticTask(reference, task);
    }));
    // A source can be revoked while an asynchronous journal read is in flight. Revalidate before returning it.
    await this.telemetry.detail(owner, id);
    return diagnosticSnapshot(tasks, source.publication, source.references.length > MAX_TASKS);
  }

  /** Exact task IDs may not silently bridge retry receipts, cycles or revisions, including legacy optional attempt metadata. */
  private async associations(owner: string, references: DiagnosticTaskReference[]): Promise<void> {
    const ids = [...new Set(references.flatMap(reference => reference.remoteTaskId ? [reference.remoteTaskId] : []))];
    if (!ids.length) return;
    const values = sql.join(ids.map(id => sql`${id}`), sql`, `);
    const rows = await this.db.execute(sql`select task_id, count(distinct receipt_id)::integer as receipts from (
      select a.task_id, concat('member:',a.id::text) as receipt_id from council_member_attempts a
        where a.owner=${owner} and a.task_id in (${values})
      union all
      select coalesce(a->>'remoteTaskId',a->>'taskId') as task_id,
        concat('workflow:',t.session_id::text,':',t.cycle_id::text,':',coalesce(a->>'revision',t.revision::text),':',coalesce(a->>'reviewGroupId',a->>'id')) as receipt_id
        from council_research_tasks t cross join lateral jsonb_array_elements(t.attempts) a
        where t.owner=${owner}
          and (a->'externalAgent'='true'::jsonb or (a->>'externalAgent' is distinct from 'false' and a->>'remoteTaskId' is not null))
          and coalesce(a->>'remoteTaskId',a->>'taskId') in (${values})
    ) receipts group by task_id`);
    const counts = new Map(rows.map(row => [String(row.task_id), Number(row.receipts)]));
    for (const reference of references) {
      const count = counts.get(reference.remoteTaskId ?? '') ?? 0;
      reference.ambiguous = count > 1;
      reference.allowUnnumberedAttempt = count === 1;
    }
  }

  private async references(owner: string, run: TelemetryRun): Promise<{ references: DiagnosticTaskReference[]; publication: TelemetryDiagnostics['publication'] }> {
    const prefix = run.sessionId !== null && run.revision !== null ? `research:${run.sessionId}:${run.revision}:` : null;
    const cycleId = prefix && run.id.startsWith(prefix) ? run.id.slice(prefix.length) : null;
    if (!run.sessionId || run.revision === null || !cycleId || !/^[0-9a-f-]{36}$/iu.test(cycleId)) {
      return { references: run.source === 'native' ? [{ id: run.sourceId, remoteTaskId: run.sourceId,
        sessionId: run.sessionId, revision: run.revision, cycleId: null, memberId: null, memberName: 'Local agent',
        attempt: 1, turn: null, createdAt: run.startedAt, updatedAt: run.lastActivityAt, acceptance: null, failure: null }] : [], publication: 'unknown' };
    }
    const [session] = await this.db.select({
      members: sql<Array<{ id: string; name: string; role: string }>>`(select coalesce(jsonb_agg(jsonb_build_object('id',m->>'id','name',m->>'name','role',m->>'role')),'[]'::jsonb)
        from jsonb_array_elements(coalesce(${councilSessions.profileSnapshot}->'council'->'members','[]'::jsonb)) m)`,
    }).from(councilSessions).where(and(eq(councilSessions.owner, owner), eq(councilSessions.id, run.sessionId), isNull(councilSessions.deletedAt))).limit(1);
    const attempts = await this.db.select({ id: councilMemberAttempts.id, remoteTaskId: councilMemberAttempts.taskId,
      memberId: councilMemberAttempts.memberId, attempt: councilMemberAttempts.attempt, turn: councilMemberAttempts.turn,
      createdAt: councilMemberAttempts.createdAt, updatedAt: councilMemberAttempts.updatedAt,
      acceptance: councilMemberAttempts.resultAcceptance, failure: councilMemberAttempts.failure,
    }).from(councilMemberAttempts).where(and(eq(councilMemberAttempts.owner, owner), eq(councilMemberAttempts.sessionId, run.sessionId),
      eq(councilMemberAttempts.revision, run.revision), eq(councilMemberAttempts.cycleId, cycleId), sql`${councilMemberAttempts.resourceKey} like 'local:%'`))
      .orderBy(councilMemberAttempts.createdAt, councilMemberAttempts.attempt, councilMemberAttempts.id).limit(MAX_TASKS + 1);
    const references: DiagnosticTaskReference[] = attempts.map(attempt => ({ ...attempt, sessionId: run.sessionId, revision: run.revision, cycleId,
      memberName: session?.members.find(member => member.id === attempt.memberId)?.name ?? attempt.memberId,
      createdAt: attempt.createdAt.toISOString(), updatedAt: attempt.updatedAt.toISOString() }));
    const workflow = await this.db.select({ id: councilResearchTasks.id, memberId: councilResearchTasks.memberId,
      position: councilResearchTasks.position, revision: councilResearchTasks.revision, state: councilResearchTasks.state,
      acceptedAttemptId: councilResearchTasks.acceptedAttemptId, updatedAt: councilResearchTasks.updatedAt,
      attempts: sql<WorkflowAttempt[]>`(select coalesce(jsonb_agg(jsonb_build_object('id',a->>'id','revision',(a->>'revision')::integer,
        'kind',a->>'kind','state',a->>'state','startedAt',a->>'startedAt','finishedAt',a->>'finishedAt','externalAgent',a->'externalAgent',
        'remoteTaskId',case when a->'externalAgent'='true'::jsonb then coalesce(a->>'remoteTaskId',a->>'taskId') else a->>'remoteTaskId' end,
        'reviewGroupId',a->>'reviewGroupId',
        'reviewAccepted',case when jsonb_typeof(a->'review'->'accepted')='boolean' then (a->'review'->>'accepted')::boolean else null end) order by entry.position),'[]'::jsonb)
        from jsonb_array_elements(${councilResearchTasks.attempts}) with ordinality as entry(a,position))`,
    }).from(councilResearchTasks).where(and(eq(councilResearchTasks.owner, owner), eq(councilResearchTasks.sessionId, run.sessionId),
      eq(councilResearchTasks.cycleId, cycleId))).orderBy(councilResearchTasks.position).limit(MAX_TASKS + 1);
    const seen = new Set(references.map(reference => reference.remoteTaskId).filter(Boolean));
    for (const task of workflow) for (const [index, attempt] of task.attempts.entries()) {
      if ((attempt.revision ?? task.revision) !== run.revision || attempt.externalAgent === false || !attempt.remoteTaskId && !attempt.externalAgent
        || attempt.remoteTaskId && seen.has(attempt.remoteTaskId)) continue;
      if (attempt.reviewGroupId) {
        const shared = workflow.flatMap(task => task.attempts).filter(entry => entry.reviewGroupId === attempt.reviewGroupId);
        const primary = shared.find(entry => entry.id === attempt.reviewGroupId) ?? shared.sort((a, b) => a.id.localeCompare(b.id))[0];
        if (primary?.id !== attempt.id) continue;
      }
      const member = attempt.kind === 'review' ? session?.members.find(member => member.role === 'manager') : session?.members.find(member => member.id === task.memberId);
      const verdict = workflowDiagnosticAcceptance(task.attempts, index, task.acceptedAttemptId);
      references.push({ id: attempt.id, remoteTaskId: attempt.remoteTaskId ?? null, sessionId: run.sessionId, revision: run.revision,
        cycleId, memberId: member?.id ?? (attempt.kind === 'review' ? null : task.memberId), memberName: member?.name ?? task.memberId,
        attempt: index + 1, turn: task.position, createdAt: attempt.startedAt, updatedAt: attempt.finishedAt ?? task.updatedAt.toISOString(), ...verdict, failure: null });
      if (attempt.remoteTaskId) seen.add(attempt.remoteTaskId);
      if (references.length > MAX_TASKS) break;
    }
    const [report] = await this.db.select({ outcome: councilReports.publicationOutcome }).from(councilReports).where(and(eq(councilReports.owner, owner),
      eq(councilReports.sessionId, run.sessionId), eq(councilReports.revision, run.revision), sql`${councilReports.coverage}->>'cycleId'=${cycleId}`))
      .orderBy(desc(councilReports.createdAt)).limit(1);
    return { references, publication: report?.outcome === 'succeeded' ? 'published' : report?.outcome === 'failed' ? 'failed' : 'unknown' };
  }
}
