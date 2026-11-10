import { BadRequestException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { and, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '../../common/platform';
import { councilMessages, councilReports, councilSessions } from '../../database/council.schema';
import { councilMemberAttempts } from '../../database/simple-council.schema';
import { councilResearchTasks } from '../../database/research-workflow.schema';
import { telemetryFeedback, telemetrySpans } from '../../database/telemetry.schema';
import { lockMemoryOwner } from '../research-memory/research-memory.fence';
import { buildTelemetry, effectiveAgentKey, knownSum, normalizeTelemetryFilters, p95, telemetryExecutions, validateFeedback, type NormalizedTelemetryFilters,
  type TelemetryFacts, type TelemetryProjection, type TelemetrySessionFact, type TelemetryMessageFact } from './telemetry.rules';
import { getTelemetryIntegration } from './telemetry-langfuse';
import { TelemetryCaptureService } from './telemetry-capture.service';
import type { TelemetryAgent, TelemetryFeedback, TelemetryRatio, TelemetryRunDetail, TelemetryWorkspace } from '../../../shared/telemetry.interface';

type ReadDatabase = Pick<PostgresJsDatabase, 'select' | 'execute'>;
const MAX_SESSIONS = 2000, MAX_FACTS = 20000;
const ALL_TIME: NormalizedTelemetryFilters = { from: '0001-01-01T00:00:00.000Z', to: '9999-12-31T23:59:59.999Z', offset: 0, limit: 100 };
const LIMITATIONS = [
  'Historical research is projected by revision and cycle. Missing legacy cycle/start timestamps remain unknown; conversations are not execution runs.',
  'Historical report and budget totals can span several cycles. They are not allocated to runs or agents. Zero legacy usage defaults are not measurements.',
  'Recorded new model/native spans supply measured usage. Totals sum known measurements only; token coverage identifies incomplete runs. Cost remains unknown without a recorded rate.',
  'Completion, local acceptance, report publication, adoption and user feedback are separate outcomes. Financial returns are not per-run accuracy.',
  'Quality ratios use only runs with the corresponding saved evidence. Source/version traceability, seven-day adoption and dataset/experiment scores are unavailable locally; configuring Langfuse does not establish an evaluation result.',
];

function bounded<T>(rows: T[], maximum: number): T[] {
  if (rows.length > maximum) throw new BadRequestException('TELEMETRY_QUERY_TOO_BROAD: narrow the date range');
  return rows;
}
function ratio(values: Array<boolean | null>): TelemetryRatio {
  const known = values.filter((value): value is boolean => value !== null), numerator = known.filter(Boolean).length;
  return { numerator, denominator: known.length, value: known.length ? numerator / known.length : null };
}

@Injectable()
export class TelemetryService {
  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase, @Optional() private readonly capture?: TelemetryCaptureService) {}

  private limitations(owner: string): string[] {
    const health = this.capture?.getCaptureHealth(owner);
    return [...LIMITATIONS, ...(health?.incomplete ? [
      `Capture is incomplete in the current server process: ${health.dropped} dropped, ${health.persistenceFailures} persistence failures, ${health.exportFailures} export failures. Counters reset at restart.`,
    ] : [])];
  }

  /** Snapshot reads never recover research, call a provider, initialize settings or mutate source records. */
  async workspace(owner: string, query: Record<string, unknown>): Promise<TelemetryWorkspace> {
    const filters = normalizeTelemetryFilters(query);
    return this.db.transaction(async tx => {
      const facts = await this.load(tx, owner, filters), projections = bounded(buildTelemetry(facts, filters), MAX_FACTS), runs = projections.map(item => item.run);
      const knownUsageRuns = runs.filter(run => run.usageKnown).length;
      const trends = new Map<string, { date: string; completed: number; failed: number; other: number }>();
      for (const run of runs) {
        const date = run.startedAt.slice(0, 10), point = trends.get(date) ?? { date, completed: 0, failed: 0, other: 0 };
        if (run.status === 'completed') point.completed++; else if (run.status === 'failed') point.failed++; else point.other++;
        trends.set(date, point);
      }
      const terminal = runs.filter(run => ['completed', 'failed'].includes(run.status));
      const feedback = runs.length ? await tx.select({ rating: telemetryFeedback.rating }).from(telemetryFeedback)
        .where(and(eq(telemetryFeedback.owner, owner), inArray(telemetryFeedback.runId, runs.map(run => run.id)))) : [];
      return { generatedAt: new Date().toISOString(), range: { from: filters.from, to: filters.to }, total: runs.length,
        overview: { totalRuns: runs.length, completedRuns: runs.filter(run => run.status === 'completed').length,
          failedRuns: runs.filter(run => run.status === 'failed').length, cancelledRuns: runs.filter(run => run.status === 'cancelled').length,
          runningRuns: runs.filter(run => ['running', 'queued'].includes(run.status)).length, unknownRuns: runs.filter(run => run.status === 'unknown').length,
          completionRate: terminal.length ? terminal.filter(run => run.status === 'completed').length / terminal.length : null,
          p95DurationMs: p95(runs.filter(run => run.status === 'completed').map(run => run.durationMs)), totalTokens: knownSum(runs.map(run => run.totalTokens)),
          estimatedCostUsd: knownSum(runs.map(run => run.estimatedCostUsd)), knownUsageRuns,
          tokenCoverageRate: runs.length ? knownUsageRuns / runs.length : null, trends: [...trends.values()].sort((a, b) => a.date.localeCompare(b.date)) },
        agents: this.agents(projections, facts), runs: runs.slice(filters.offset, filters.offset + filters.limit),
        quality: { completeDelivery: ratio(projections.map(item => item.quality.completeDelivery)),
          traceableEvidence: ratio(projections.map(item => item.quality.traceableEvidence)), reverseCheck: ratio(projections.map(item => item.quality.reverseCheck)),
          adoption: ratio(projections.map(item => item.quality.adoption)), evaluationAvailable: false,
          feedback: { positive: feedback.filter(item => item.rating === 'positive').length, negative: feedback.filter(item => item.rating === 'negative').length } },
        integration: getTelemetryIntegration(), limitations: this.limitations(owner) };
    }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
  }

  async detail(owner: string, id: string): Promise<TelemetryRunDetail> {
    this.validateId(id);
    return this.db.transaction(async tx => this.detailInSnapshot(tx, owner, id), { isolationLevel: 'repeatable read', accessMode: 'read only' });
  }

  async feedback(owner: string, id: string, input: unknown): Promise<TelemetryFeedback> {
    this.validateId(id); const values = validateFeedback(input);
    return this.db.transaction(async tx => {
      // Deletion and report/source mutation take the same owner lock. The visibility check and upsert are one transaction.
      await lockMemoryOwner(tx, owner);
      await this.detailInSnapshot(tx, owner, id);
      const [row] = await tx.insert(telemetryFeedback).values({ owner, runId: id, ...values, updatedAt: new Date() })
        .onConflictDoUpdate({ target: [telemetryFeedback.owner, telemetryFeedback.runId], set: { ...values, updatedAt: new Date() } }).returning();
      return { rating: row.rating, comment: row.comment, updatedAt: row.updatedAt.toISOString() };
    });
  }

  private validateId(id: string): void { if (!id || id.length > 500 || /[\u0000-\u001f]/u.test(id)) throw new NotFoundException('TELEMETRY_RUN_NOT_FOUND'); }

  private async detailInSnapshot(db: ReadDatabase, owner: string, id: string): Promise<TelemetryRunDetail> {
    const researchId = /^research:([0-9a-f-]{36}):/iu.exec(id)?.[1];
    const facts = await this.load(db, owner, ALL_TIME, researchId, id), projection = buildTelemetry(facts, ALL_TIME).find(item => item.run.id === id);
    if (!projection) throw new NotFoundException('TELEMETRY_RUN_NOT_FOUND');
    const [feedback] = await db.select().from(telemetryFeedback).where(and(eq(telemetryFeedback.owner, owner), eq(telemetryFeedback.runId, id))).limit(1);
    return { run: projection.run, spans: projection.spans.sort((a, b) => a.startedAt.localeCompare(b.startedAt)),
      feedback: feedback ? { rating: feedback.rating, comment: feedback.comment, updatedAt: feedback.updatedAt.toISOString() } : null,
      integration: getTelemetryIntegration(), limitations: this.limitations(owner) };
  }

  private async load(db: ReadDatabase, owner: string, filters: NormalizedTelemetryFilters, sessionId?: string, runId?: string): Promise<TelemetryFacts> {
    const sessions = bounded(await db.select({ id: councilSessions.id, title: councilSessions.title, scene: councilSessions.scene,
      status: councilSessions.status, revision: councilSessions.revision, cycleId: sql<string | null>`${councilSessions.checkpoint}->>'cycleId'`,
      members: sql<TelemetrySessionFact['members']>`(select coalesce(jsonb_agg(jsonb_build_object('id',m->>'id','name',m->>'name','role',m->>'role','executionMode',m->>'executionMode')),'[]'::jsonb)
        from jsonb_array_elements(coalesce(${councilSessions.profileSnapshot}->'council'->'members','[]'::jsonb)) m)`,
      createdAt: councilSessions.createdAt, updatedAt: councilSessions.updatedAt }).from(councilSessions).where(and(eq(councilSessions.owner, owner), isNull(councilSessions.deletedAt),
      sessionId ? eq(councilSessions.id, sessionId) : runId ? sql`false` : and(lte(councilSessions.createdAt, new Date(filters.to)), gte(councilSessions.updatedAt, new Date(filters.from)))))
      .limit(MAX_SESSIONS + 1), MAX_SESSIONS);
    const ids = sessions.map(session => session.id), facts: TelemetryFacts = { sessions, attempts: [], tasks: [], messages: [], reports: [], captured: [], feedback: [] };
    if (ids.length) {
      facts.attempts = bounded(await db.select({ id: councilMemberAttempts.id, sessionId: councilMemberAttempts.sessionId, cycleId: councilMemberAttempts.cycleId,
        revision: councilMemberAttempts.revision, taskId: councilMemberAttempts.taskId, memberId: councilMemberAttempts.memberId, attempt: councilMemberAttempts.attempt, status: councilMemberAttempts.status,
        resultAcceptance: councilMemberAttempts.resultAcceptance, resourceKey: councilMemberAttempts.resourceKey, tokensUsed: councilMemberAttempts.tokensUsed,
        failure: councilMemberAttempts.failure, startedAt: councilMemberAttempts.startedAt, completedAt: councilMemberAttempts.completedAt,
        createdAt: councilMemberAttempts.createdAt, updatedAt: councilMemberAttempts.updatedAt }).from(councilMemberAttempts)
        .where(and(eq(councilMemberAttempts.owner, owner), inArray(councilMemberAttempts.sessionId, ids))).limit(MAX_FACTS + 1), MAX_FACTS);
      facts.tasks = bounded(await db.select({ id: councilResearchTasks.id, sessionId: councilResearchTasks.sessionId, cycleId: councilResearchTasks.cycleId,
        revision: councilResearchTasks.revision, memberId: councilResearchTasks.memberId, key: councilResearchTasks.key, state: councilResearchTasks.state,
        acceptedAttemptId: councilResearchTasks.acceptedAttemptId,
        attempts: sql<TelemetryFacts['tasks'][number]['attempts']>`(select coalesce(jsonb_agg(jsonb_build_object('id',a->>'id','state',a->>'state','startedAt',a->>'startedAt',
          'kind',a->>'kind','revision',(a->>'revision')::integer,'reviewGroupId',a->>'reviewGroupId','finishedAt',a->>'finishedAt','remoteTaskId',coalesce(a->>'remoteTaskId',a->>'taskId'))),'[]'::jsonb)
          from jsonb_array_elements(${councilResearchTasks.attempts}) a)`, updatedAt: councilResearchTasks.updatedAt }).from(councilResearchTasks)
        .where(and(eq(councilResearchTasks.owner, owner), inArray(councilResearchTasks.sessionId, ids))).limit(MAX_FACTS + 1), MAX_FACTS);
      facts.messages = bounded(await db.select({ id: councilMessages.id, sessionId: councilMessages.sessionId, revision: councilMessages.revision,
        cycleId: sql<string | null>`${councilMessages.metadata}->>'cycleId'`, memberId: sql<string | null>`${councilMessages.metadata}->>'memberId'`,
        memberName: councilMessages.memberName, createdAt: councilMessages.createdAt,
        event: sql<TelemetryMessageFact['event']>`${councilMessages.metadata}->'researchEvent'` }).from(councilMessages)
        .where(and(eq(councilMessages.owner, owner), inArray(councilMessages.sessionId, ids))).limit(MAX_FACTS + 1), MAX_FACTS);
      facts.reports = bounded(await db.select({ id: councilReports.id, sessionId: councilReports.sessionId, revision: councilReports.revision,
        cycleId: sql<string | null>`${councilReports.coverage}->>'cycleId'`, createdAt: councilReports.createdAt,
        publicationOutcome: councilReports.publicationOutcome, complete: sql<boolean | null>`(${councilReports.coverage}->>'complete')::boolean`,
        evidenceCount: sql<number>`jsonb_array_length(${councilReports.evidence})`,
        reverseCheck: sql<boolean | null>`case when ${councilReports.coverage}->'reverseCheck' is null then null else (${councilReports.coverage}->'reverseCheck'->>'outcome') <> 'unable_to_verify' end`,
        reportVersionId: sql<string | null>`(select v.id::text from research_document_versions v where v.owner=${owner}
          and (v.id=council_reports.research_version_id or (v.change_reason is null and v.source->>'type'='council' and v.source->>'id'=council_reports.id::text)) order by v.created_at limit 1)`,
        adopted: sql<boolean | null>`(select coalesce(d.adopted_version_id=v.id,false) from research_document_versions v join research_documents d on d.id=v.report_id and d.owner=v.owner where v.owner=${owner}
          and (v.id=council_reports.research_version_id or (v.change_reason is null and v.source->>'type'='council' and v.source->>'id'=council_reports.id::text)) order by v.created_at limit 1)`,
        hidden: sql<boolean>`exists(select 1 from research_document_versions v where v.owner=${owner} and (v.deleted_at is not null or v.revoked_at is not null)
          and (v.id=council_reports.research_version_id or (v.change_reason is null and v.source->>'type'='council' and v.source->>'id'=council_reports.id::text)))` }).from(councilReports)
        .where(and(eq(councilReports.owner, owner), inArray(councilReports.sessionId, ids))).limit(MAX_FACTS + 1), MAX_FACTS);
    }
    const captured = bounded(await db.select().from(telemetrySpans).where(and(eq(telemetrySpans.owner, owner),
      runId ? eq(telemetrySpans.runId, runId) : sql`${telemetrySpans.runId} in (select candidate.run_id from telemetry_spans candidate where candidate.owner=${owner}
        and candidate.started_at >= ${filters.from}::timestamptz and candidate.started_at <= ${filters.to}::timestamptz group by candidate.run_id limit ${MAX_FACTS + 1})`,
      // Native/model task IDs can refer to a persistent council task even when sessionId was unavailable at capture time.
      sql`not exists(select 1 from council_sessions s where s.owner=${owner} and (s.id::text=${telemetrySpans.sourceId} or s.task_id::text=${telemetrySpans.sourceId} or s.id::text=${telemetrySpans.sessionId}) and s.deleted_at is not null)`,
      sql`(${telemetrySpans.sessionId} is null or exists(select 1 from council_sessions s where s.owner=${owner} and s.id::text=${telemetrySpans.sessionId} and s.deleted_at is null))`,
      sql`not exists(select 1 from research_document_versions v where v.owner=${owner} and (v.deleted_at is not null or v.revoked_at is not null)
        and (v.id::text=${telemetrySpans.sourceId} or (v.change_reason is null and v.source->>'type'='council' and v.source->>'id'=${telemetrySpans.sourceId})))`,
      sql`not exists(select 1 from council_reports r join research_document_versions v on v.owner=r.owner and (v.id=r.research_version_id or (v.change_reason is null and v.source->>'type'='council' and v.source->>'id'=r.id::text))
        where r.owner=${owner} and (v.deleted_at is not null or v.revoked_at is not null) and r.session_id::text=${telemetrySpans.sessionId}
          and (${telemetrySpans.revision} is null or r.revision=${telemetrySpans.revision})
          and (r.coverage->>'cycleId' is null or ${telemetrySpans.runId}=concat('research:',r.session_id::text,':',r.revision::text,':',r.coverage->>'cycleId')))`)).limit(MAX_FACTS + 1), MAX_FACTS);
    facts.captured = captured.map(row => ({ ...row, startedAt: row.startedAt.toISOString(), completedAt: row.completedAt?.toISOString() ?? null,
      estimatedCostUsd: row.estimatedCostUsd === null ? null : Number(row.estimatedCostUsd) }));
    return facts;
  }

  private agents(projections: TelemetryProjection[], facts: TelemetryFacts): TelemetryAgent[] {
    const groups = new Map<string, { agent: TelemetryAgent; durations: Array<number | null>; tokens: Array<number | null>; costs: Array<number | null> }>();
    for (const projection of projections) for (const execution of telemetryExecutions(projection, facts)) {
      const span = execution.span, id = effectiveAgentKey(span), mode = span.executionMode ?? 'unknown', key = id;
      if (!groups.has(key)) groups.set(key, { agent: { id, name: span.agentName ?? span.name, role: projection.roles.get(span.agentId ?? '') ?? span.kind,
        provider: span.provider, model: span.model, executionMode: mode, executions: 0, completed: 0, failed: 0, accepted: 0, acceptanceKnown: 0,
        completionRate: null, p95DurationMs: null, totalTokens: null, estimatedCostUsd: null, knownUsageExecutions: 0 }, durations: [], tokens: [], costs: [] });
      const group = groups.get(key)!, agent = group.agent; agent.executions++;
      if (span.status === 'completed') agent.completed++; if (span.status === 'failed') agent.failed++;
      if (span.status === 'completed') group.durations.push(span.durationMs);
      group.tokens.push(span.totalTokens); group.costs.push(span.estimatedCostUsd); if (execution.usageKnown) agent.knownUsageExecutions++;
      if (execution.acceptance !== null) { agent.acceptanceKnown++; if (execution.acceptance) agent.accepted++; }
    }
    return [...groups.values()].map(({ agent, durations, tokens, costs }) => ({ ...agent,
      completionRate: agent.completed + agent.failed ? agent.completed / (agent.completed + agent.failed) : null, p95DurationMs: p95(durations),
      totalTokens: knownSum(tokens), estimatedCostUsd: knownSum(costs) })).sort((a, b) => b.executions - a.executions || a.id.localeCompare(b.id));
  }
}
