import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { ResearchTaskAttempt } from '../../../shared/research-workflow.interface';
import type { TelemetryFeedbackInput, TelemetryFilters, TelemetryRun, TelemetrySpan, TelemetrySpanRecord, TelemetryStatus } from '../../../shared/telemetry.interface';
import { enrichTelemetryDimensions, matchesExecutionFilters, TELEMETRY_DIMENSION_KEYS, telemetryDimensions } from './telemetry-identity.rules';

export interface TelemetrySessionFact {
  id: string; title: string; scene: string; status: string; revision: number; cycleId: string | null;
  createdAt: Date; updatedAt: Date; members: Array<{ id: string; name: string; role: string; executionMode?: string;
    rosterAgentId?: string; rosterAgentVersionId?: string; configuredModel?: string }>;
  team?: { teamId: string; teamVersionId: string; commissionId: string; cycleId: string | null;
    members: Array<{ memberId: string; label?: string; rosterAgentId?: string; rosterAgentVersionId?: string; configuredModel?: string }> } | null;
}
export interface TelemetryAttemptFact {
  id: string; taskId?: string | null; sessionId: string; cycleId: string; revision: number; memberId: string; attempt: number;
  status: string; resultAcceptance: string; resourceKey: string; createdAt: Date; updatedAt: Date;
  startedAt: Date | null; completedAt: Date | null; tokensUsed: number; failure: { code: string } | null;
}
export interface TelemetryTaskFact {
  id: string; sessionId: string; cycleId: string; revision: number; memberId: string; key: string;
  state: string; acceptedAttemptId?: string | null;
  attempts: Array<Pick<ResearchTaskAttempt, 'id' | 'state' | 'startedAt' | 'finishedAt' | 'remoteTaskId'> & Partial<Pick<ResearchTaskAttempt, 'kind' | 'reviewGroupId' | 'revision'>>>; updatedAt: Date;
}
export interface TelemetryMessageFact {
  id: string; sessionId: string; revision: number; cycleId: string | null; memberId: string | null; memberName: string;
  createdAt: Date; event: { id: string; kind: string; status: string; at: string; toolName?: string; durationMs?: number; attempt?: number } | null;
}
export interface TelemetryReportFact {
  id: string; sessionId: string; revision: number; cycleId: string | null; createdAt: Date; publicationOutcome: string | null;
  complete: boolean | null; evidenceCount: number; reverseCheck: boolean | null; reportVersionId: string | null;
  adopted: boolean | null; hidden: boolean;
}
export interface TelemetryFacts {
  sessions: TelemetrySessionFact[]; attempts: TelemetryAttemptFact[]; tasks: TelemetryTaskFact[];
  messages: TelemetryMessageFact[]; reports: TelemetryReportFact[]; captured: TelemetrySpanRecord[];
  feedback: Array<{ runId: string; rating: 'positive' | 'negative' }>;
}
export interface TelemetryProjection {
  run: TelemetryRun; spans: TelemetrySpan[];
  quality: { completeDelivery: boolean | null; traceableEvidence: boolean | null; reverseCheck: boolean | null; adoption: boolean | null };
  roles: Map<string, string>;
}
export interface NormalizedTelemetryFilters extends TelemetryFilters { from: string; to: string; offset: number; limit: number }
const DAY = 86400000;
const statuses: TelemetryStatus[] = ['queued', 'running', 'completed', 'failed', 'cancelled', 'unknown'];

export function normalizeTelemetryFilters(input: Record<string, unknown>, now = new Date()): NormalizedTelemetryFilters {
  const date = (value: unknown, fallback: Date, end: boolean) => {
    if (value === undefined || value === '') return fallback;
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T.*)?$/u.test(value)) throw new BadRequestException('TELEMETRY_DATE_INVALID');
    const parsed = new Date(value.length === 10 ? `${value}T${end ? '23:59:59.999' : '00:00:00.000'}Z` : value);
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value.slice(0, 10)) throw new BadRequestException('TELEMETRY_DATE_INVALID');
    return parsed;
  };
  const to = date(input.to, now, true), from = date(input.from, new Date(to.getTime() - 7 * DAY), false);
  if (from > to || to.getTime() - from.getTime() > 366 * DAY) throw new BadRequestException('TELEMETRY_RANGE_INVALID');
  if (input.status !== undefined && !statuses.includes(input.status as TelemetryStatus)) throw new BadRequestException('TELEMETRY_STATUS_INVALID');
  const number = (value: unknown, fallback: number, max: number) => {
    if (value === undefined) return fallback;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 0) throw new BadRequestException('TELEMETRY_PAGE_INVALID');
    return Math.min(parsed, max);
  };
  const result: NormalizedTelemetryFilters = { from: from.toISOString(), to: to.toISOString(), offset: number(input.offset, 0, 1000000), limit: Math.max(1, number(input.limit, 25, 100)) };
  for (const key of ['scene', 'agentId', 'executionMode', 'status', 'search', 'rosterAgentId', 'rosterAgentVersionId', 'memberId',
    'teamId', 'teamVersionId', 'commissionId', 'workKey', 'attemptId'] as const) {
    const value = input[key];
    if (value === undefined || value === '') continue;
    if (typeof value !== 'string' || value.length > (key === 'search' ? 200 : 120)) throw new BadRequestException('TELEMETRY_FILTER_INVALID');
    Object.assign(result, { [key]: value.trim() });
  }
  return result;
}

export function validateFeedback(input: unknown): Required<TelemetryFeedbackInput> {
  if (!input || typeof input !== 'object') throw new BadRequestException('TELEMETRY_FEEDBACK_INVALID');
  const data = input as Record<string, unknown>;
  if (!['positive', 'negative'].includes(String(data.rating)) || (data.comment !== undefined && typeof data.comment !== 'string')
    || typeof data.comment === 'string' && data.comment.length > 2000) throw new BadRequestException('TELEMETRY_FEEDBACK_INVALID');
  return { rating: data.rating as 'positive' | 'negative', comment: typeof data.comment === 'string' ? data.comment.trim() : '' };
}

export function telemetryStatus(value: string): TelemetryStatus {
  if (['succeeded', 'accepted', 'submitted'].includes(value)) return 'completed';
  if (['uncertain', 'unavailable', 'interrupted', 'blocked', 'needs_revision', 'skipped'].includes(value)) return 'unknown';
  return statuses.includes(value as TelemetryStatus) ? value as TelemetryStatus : 'unknown';
}
export function p95(values: Array<number | null>): number | null {
  const measured = values.filter((value): value is number => value !== null && Number.isFinite(value)).sort((a, b) => a - b);
  return measured.length ? measured[Math.ceil(measured.length * .95) - 1] : null;
}
export function knownSum(values: Array<number | null>): number | null {
  const known = values.filter((value): value is number => value !== null && Number.isFinite(value));
  return known.length ? known.reduce((sum, value) => sum + value, 0) : null;
}

/** The exact same bounded identity is returned by agent rows and consumed by run filters. */
export function effectiveAgentKey(span: TelemetrySpan): string {
  const identity = span.rosterAgentId && span.rosterAgentVersionId
    ? ['roster', span.rosterAgentId, span.rosterAgentVersionId] : ['legacy', span.agentId];
  return `agent:${createHash('sha256').update(JSON.stringify([...identity, span.provider, span.model, span.executionMode ?? 'unknown'])).digest('hex').slice(0, 32)}`;
}

function ancestors(span: TelemetrySpan, byId: Map<string, TelemetrySpan>): TelemetrySpan[] {
  const result: TelemetrySpan[] = [], seen = new Set<string>([span.id]);
  let parent = span.parentId;
  while (parent && result.length < 64 && !seen.has(parent)) {
    seen.add(parent); const row = byId.get(parent); if (!row) break;
    result.push(row); parent = row.parentId;
  }
  return result;
}

function billableSpans(spans: TelemetrySpan[]): TelemetrySpan[] {
  const byId = new Map(spans.map(span => [span.id, span])), superseded = new Set<string>();
  const billable = spans.filter(span => ['agent', 'model'].includes(span.kind));
  for (const span of billable) for (const ancestor of ancestors(span, byId)) {
    if (['agent', 'model'].includes(ancestor.kind)) superseded.add(ancestor.id);
  }
  return billable.filter(span => !superseded.has(span.id));
}

export interface TelemetryExecution { span: TelemetrySpan; acceptance: boolean | null; usageKnown: boolean }

/** Historical receipts are logical executions; captured descendants enrich them, never add a second execution. */
export function telemetryExecutions(projection: TelemetryProjection, facts: TelemetryFacts): TelemetryExecution[] {
  const spans = projection.spans, byId = new Map(spans.map(span => [span.id, span]));
  const lineage = new Map(spans.map(span => [span.id, ancestors(span, byId)]));
  const anchors = spans.filter(span => {
    const parents = lineage.get(span.id)!;
    if (span.kind === 'agent') return !parents.some(parent => parent.kind === 'agent');
    if (span.kind === 'task' && !span.id.startsWith('event:')) return !parents.some(parent => ['agent', 'task'].includes(parent.kind));
    return span.kind === 'model' && !parents.some(parent => ['agent', 'task', 'model'].includes(parent.kind));
  });
  const anchorIds = new Set(anchors.map(anchor => anchor.id)), subtrees = new Map(anchors.map(anchor => [anchor.id, [anchor]]));
  for (const span of spans) {
    if (anchorIds.has(span.id)) continue;
    const anchor = lineage.get(span.id)!.find(parent => anchorIds.has(parent.id));
    if (anchor) subtrees.get(anchor.id)!.push(span);
  }
  return anchors.map(anchor => {
    const subtree = subtrees.get(anchor.id)!;
    const metered = billableSpans(subtree), actual = metered.filter(span => span.kind === 'model' || !span.id.startsWith('attempt:') && !span.id.startsWith('workflow:'));
    const unique = (values: Array<string | null>): string | null => { const known = [...new Set(values.filter((value): value is string => value !== null))]; return known.length === 1 ? known[0] : null; };
    const calls = subtree.filter(span => span.kind === 'task' && span.parentId === anchor.id && !span.id.startsWith('event:')).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    const span: TelemetrySpan = { ...anchor, kind: 'agent', agentId: anchor.agentId ?? unique(actual.map(item => item.agentId)),
      provider: actual.length ? unique(actual.map(item => item.provider)) : anchor.provider,
      model: actual.length ? unique(actual.map(item => item.model)) : anchor.model,
      executionMode: actual.length ? unique(actual.map(item => item.executionMode)) ?? anchor.executionMode : anchor.executionMode,
      status: calls.at(-1)?.status ?? anchor.status,
      inputTokens: knownSum(metered.map(item => item.inputTokens)), outputTokens: knownSum(metered.map(item => item.outputTokens)),
      totalTokens: knownSum(metered.map(item => item.totalTokens)), estimatedCostUsd: knownSum(metered.map(item => item.estimatedCostUsd)) };
    const capturedSource = facts.captured.find(item => item.id === anchor.id)?.sourceId;
    const attempt = facts.attempts.find(item => `attempt:${item.id}` === anchor.id || capturedSource && item.taskId === capturedSource);
    let acceptance: boolean | null = attempt && ['accepted', 'rejected'].includes(attempt.resultAcceptance) ? attempt.resultAcceptance === 'accepted' : null;
    if (!attempt) {
      const task = facts.tasks.find(item => item.attempts.some(entry => `workflow:${entry.id}` === anchor.id || capturedSource && entry.remoteTaskId === capturedSource));
      if (task) {
        const work = task.attempts.find(entry => (`workflow:${entry.id}` === anchor.id || capturedSource && entry.remoteTaskId === capturedSource) && entry.kind !== 'review');
        if (work && task.acceptedAttemptId === work.id) acceptance = true;
        else if (work && task.state === 'needs_revision' && task.attempts.filter(entry => entry.kind !== 'review').at(-1)?.id === work.id) acceptance = false;
      }
    }
    return { span, acceptance, usageKnown: metered.length > 0 && metered.every(item => item.totalTokens !== null) };
  });
}
function duration(start: string, end: string | null): number | null { return end ? Math.max(0, Date.parse(end) - Date.parse(start)) : null; }
function emptySpan(id: string, name: string, startedAt: string): TelemetrySpan {
  return { id, parentId: null, kind: 'agent', name, status: 'unknown', agentId: null, agentName: null, provider: null, model: null,
    executionMode: null, startedAt, completedAt: null, durationMs: null, inputTokens: null, outputTokens: null, totalTokens: null,
    estimatedCostUsd: null, errorCode: null, attempt: 1, traceId: null };
}
function aggregateStatus(spans: TelemetrySpan[]): TelemetryStatus {
  if (!spans.length) return 'unknown';
  const latest = new Map<string, TelemetrySpan>();
  for (const span of spans) {
    const key = span.id.startsWith('attempt:') ? `member:${span.agentId ?? span.id}` : span.id, prior = latest.get(key);
    if (!prior || span.attempt >= prior.attempt) latest.set(key, span);
  }
  return aggregateStates([...latest.values()].map(span => span.status));
}
function aggregateStates(states: TelemetryStatus[]): TelemetryStatus {
  if (!states.length) return 'unknown';
  if (states.includes('running')) return 'running';
  if (states.includes('queued')) return 'queued';
  if (states.includes('unknown')) return 'unknown';
  if (states.includes('failed')) return 'failed';
  if (states.includes('cancelled')) return 'cancelled';
  return 'completed';
}
function runFromSpans(id: string, source: TelemetryRun['source'], sourceId: string, sessionId: string | null, revision: number | null,
  title: string, scene: string, spans: TelemetrySpan[], fallback: string): TelemetryRun {
  const starts = spans.map(span => span.startedAt).sort(), ends = spans.map(span => span.completedAt ?? span.startedAt).sort();
  const authoritative = spans.filter(span => !span.id.startsWith('event:') && span.parentId === null && ['task', 'agent'].includes(span.kind));
  const startedAt = starts[0] ?? fallback, status = aggregateStatus(authoritative.length ? authoritative : spans.filter(span => span.kind !== 'tool' && !span.id.startsWith('event:')));
  const completedAt = ['completed', 'failed', 'cancelled'].includes(status) ? ends.at(-1) ?? null : null;
  // Parent task/agent summaries may repeat model usage. Count only measured leaves.
  const usage = billableSpans(spans);
  const totalTokens = knownSum(usage.map(span => span.totalTokens));
  return { id, source, sourceId, sessionId, revision, title, scene, startedAt, completedAt, lastActivityAt: ends.at(-1) ?? startedAt,
    status, durationMs: duration(startedAt, completedAt), agentCount: new Set(spans.map(span => span.agentId).filter(Boolean)).size,
    inputTokens: knownSum(usage.map(span => span.inputTokens)), outputTokens: knownSum(usage.map(span => span.outputTokens)), totalTokens,
    estimatedCostUsd: knownSum(usage.map(span => span.estimatedCostUsd)), usageKnown: totalTokens !== null && usage.every(span => span.totalTokens !== null),
    eventsTruncated: false, accepted: null, reportVersionId: null, adopted: null, traceId: spans.find(span => span.traceId)?.traceId ?? null };
}

/** Historical mutable sessions are containers. A revision/cycle, never the container, is a research run. */
export function buildTelemetry(facts: TelemetryFacts, filters: NormalizedTelemetryFilters): TelemetryProjection[] {
  const result: TelemetryProjection[] = [];
  for (const session of facts.sessions) {
    const attempts = facts.attempts.filter(item => item.sessionId === session.id), tasks = facts.tasks.filter(item => item.sessionId === session.id);
    const messages = facts.messages.filter(item => item.sessionId === session.id), reports = facts.reports.filter(item => item.sessionId === session.id);
    const groups = new Map<string, { revision: number; cycle: string; spans: TelemetrySpan[]; dates: string[]; accepted: boolean[] }>();
    const group = (revision: number, cycle: string | null) => {
      const key = `${revision}:${cycle ?? 'legacy'}`;
      if (!groups.has(key)) groups.set(key, { revision, cycle: cycle ?? 'legacy', spans: [], dates: [], accepted: [] });
      return groups.get(key)!;
    };
    for (const item of [...attempts, ...tasks]) group(item.revision, item.cycleId);
    for (const task of tasks) for (const attempt of task.attempts) group(attempt.revision ?? task.revision, task.cycleId);
    const resolveCycle = (revision: number, cycle: string | null) => {
      if (cycle) return cycle;
      const found = [...groups.values()].filter(item => item.revision === revision);
      return found.length === 1 ? found[0].cycle : null;
    };
    for (const report of reports) {
      group(report.revision, resolveCycle(report.revision, report.cycleId)).dates.push(report.createdAt.toISOString());
    }
    for (const message of messages.filter(item => item.cycleId || item.event)) group(message.revision, resolveCycle(message.revision, message.cycleId));
    if (!groups.size && (session.cycleId || session.status === 'running')) group(session.revision, session.cycleId);
    for (const item of attempts) {
      const member = session.members.find(entry => entry.id === item.memberId), startedAt = (item.startedAt ?? item.createdAt).toISOString();
      const span: TelemetrySpan = { ...emptySpan(`attempt:${item.id}`, member?.name ?? item.memberId, startedAt), agentId: item.memberId,
        agentName: member?.name ?? item.memberId, executionMode: member?.executionMode ?? (item.resourceKey.startsWith('local:') ? 'local' : null),
        status: telemetryStatus(item.status), completedAt: item.completedAt?.toISOString() ?? null, attempt: item.attempt, errorCode: item.failure?.code ?? null };
      span.durationMs = duration(startedAt, span.completedAt);
      // Legacy zero may be a default or missing native usage; do not relabel it as a measurement.
      const target = group(item.revision, item.cycleId); target.spans.push(span); target.dates.push(item.updatedAt.toISOString());
      if (item.resultAcceptance !== 'pending') target.accepted.push(item.resultAcceptance === 'accepted');
    }
    for (const item of tasks) {
      const currentTarget = group(item.revision, item.cycleId);
      for (const [index, attempt] of item.attempts.entries()) {
        const target = group(attempt.revision ?? item.revision, item.cycleId);
        if (attempt.reviewGroupId) {
          const shared = tasks.filter(task => task.revision === item.revision && task.cycleId === item.cycleId)
            .flatMap(task => task.attempts).filter(entry => entry.reviewGroupId === attempt.reviewGroupId);
          const primary = shared.find(entry => entry.id === attempt.reviewGroupId) ?? shared.sort((a, b) => a.id.localeCompare(b.id))[0];
          if (primary?.id !== attempt.id) continue;
        }
        const member = attempt.kind === 'review' ? session.members.find(entry => entry.role === 'manager') : session.members.find(entry => entry.id === item.memberId);
        const memberId = attempt.kind === 'review' ? member?.id ?? null : item.memberId;
        const span: TelemetrySpan = { ...emptySpan(`workflow:${attempt.id}`, `${member?.name ?? (attempt.kind === 'review' ? 'Review' : item.memberId)}: ${item.key}`, attempt.startedAt),
          agentId: memberId, agentName: member?.name ?? null, executionMode: member?.executionMode ?? null,
          status: telemetryStatus(attempt.state), completedAt: attempt.finishedAt ?? null, attempt: index + 1 };
        span.durationMs = duration(span.startedAt, span.completedAt); target.spans.push(span); target.dates.push(attempt.finishedAt ?? attempt.startedAt);
      }
      currentTarget.dates.push(item.updatedAt.toISOString());
      if (['accepted', 'needs_revision'].includes(item.state)) currentTarget.accepted.push(item.state === 'accepted');
    }
    for (const item of messages.filter(message => message.cycleId || message.event)) {
      const target = group(item.revision, resolveCycle(item.revision, item.cycleId)); target.dates.push(item.createdAt.toISOString());
      if (item.event) {
        const event = item.event;
        target.spans.push({ ...emptySpan(`event:${event.id}`, event.toolName ?? event.kind, event.at),
          kind: event.kind === 'tool' ? 'tool' : 'task', status: telemetryStatus(event.status), agentId: item.memberId,
          agentName: item.memberName, durationMs: event.durationMs ?? null,
          completedAt: ['succeeded', 'failed', 'cancelled'].includes(event.status) ? event.at : null, attempt: event.attempt ?? 1 });
      }
    }
    for (const [key, target] of groups) {
      const runReports = reports.filter(report => report.revision === target.revision && (resolveCycle(report.revision, report.cycleId) ?? 'legacy') === target.cycle);
      if (runReports.some(report => report.hidden)) continue;
      const report = runReports.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
      const spans = [...new Map(target.spans.map(span => [span.id, span])).values()];
      const run = runFromSpans(`research:${session.id}:${key}`, 'research', session.id, session.id, target.revision,
        session.title || 'Research', session.scene, spans, target.dates.sort()[0] ?? session.createdAt.toISOString());
      const workflowStates = tasks.filter(task => task.cycleId === target.cycle).flatMap(task => {
        if (task.revision === target.revision) return [telemetryStatus(task.state)];
        const last = task.attempts.filter(attempt => (attempt.revision ?? task.revision) === target.revision).at(-1);
        return last ? [telemetryStatus(last.state)] : [];
      });
      if (workflowStates.length) run.status = aggregateStates(workflowStates);
      // A legacy message is an activity timestamp, not an observed run start.
      const measuredStart = spans.some(span => !span.id.startsWith('event:'));
      if (!measuredStart) run.durationMs = null;
      const current = target.revision === session.revision && (target.cycle === 'legacy' || target.cycle === session.cycleId);
      if (report) {
        run.status = report.publicationOutcome === 'failed' ? 'failed' : report.publicationOutcome === 'succeeded' ? 'completed' : run.status;
        run.completedAt = report.createdAt.toISOString(); run.reportVersionId = report.reportVersionId; run.adopted = report.adopted;
        run.lastActivityAt = [run.lastActivityAt, report.createdAt.toISOString()].sort().at(-1)!;
        run.durationMs = measuredStart ? duration(run.startedAt, run.completedAt) : null;
      } else if (current && session.status === 'running') run.status = 'running';
      else if (current && session.status === 'failed') run.status = 'failed';
      else if (current && session.status === 'paused') run.status = 'cancelled';
      run.lastActivityAt = [...target.dates, run.lastActivityAt].sort().at(-1)!;
      // Acceptance is local result validation, distinct from report completion/adoption.
      const finalAttempts = new Map<string, TelemetryAttemptFact>();
      for (const attempt of attempts.filter(item => item.revision === target.revision && item.cycleId === target.cycle)) {
        if (!finalAttempts.has(attempt.memberId) || finalAttempts.get(attempt.memberId)!.attempt < attempt.attempt) finalAttempts.set(attempt.memberId, attempt);
      }
      const acceptance = [...finalAttempts.values()].map(item => item.resultAcceptance);
      for (const task of tasks.filter(item => item.revision === target.revision && item.cycleId === target.cycle)) {
        acceptance.push(task.state === 'accepted' ? 'accepted' : task.state === 'needs_revision' ? 'rejected' : 'pending');
      }
      run.accepted = acceptance.length && acceptance.every(value => ['accepted', 'rejected'].includes(value)) ? acceptance.every(value => value === 'accepted') : null;
      result.push({ run, spans, roles: new Map(session.members.map(member => [member.id, member.role])), quality: {
        completeDelivery: report?.complete ?? null, traceableEvidence: null,
        reverseCheck: report?.reverseCheck ?? null, adoption: null } });
    }
  }
  const captured = new Map<string, TelemetrySpanRecord[]>();
  for (const record of facts.captured) { const list = captured.get(record.runId) ?? []; list.push(record); captured.set(record.runId, list); }
  for (const [id, records] of captured) {
    const head = records[0], spans: TelemetrySpan[] = records.map(record => ({ ...telemetryDimensions(record), id: record.id, parentId: record.parentId, kind: record.kind,
      name: record.name, status: record.status, agentId: record.agentId, agentName: record.agentName, provider: record.provider, model: record.model,
      executionMode: record.executionMode, startedAt: record.startedAt, completedAt: record.completedAt, durationMs: record.durationMs,
      inputTokens: record.inputTokens, outputTokens: record.outputTokens, totalTokens: record.totalTokens, estimatedCostUsd: record.estimatedCostUsd,
      errorCode: record.errorCode, attempt: record.attempt, traceId: record.traceId }));
    const historical = result.find(item => item.run.id === id);
    if (historical) {
      const sources = new Set(records.filter(record => record.kind === 'agent').map(record => record.sourceId));
      const replaced = new Set(facts.attempts.filter(attempt => attempt.taskId && sources.has(attempt.taskId)).map(attempt => `attempt:${attempt.id}`));
      for (const task of facts.tasks) for (const attempt of task.attempts) if (attempt.remoteTaskId && sources.has(attempt.remoteTaskId)) replaced.add(`workflow:${attempt.id}`);
      historical.spans = historical.spans.filter(span => !replaced.has(span.id));
      historical.spans.push(...spans);
      const measured = runFromSpans(id, 'research', historical.run.sourceId, historical.run.sessionId, historical.run.revision,
        historical.run.title, historical.run.scene, historical.spans, head.startedAt);
      for (const key of ['inputTokens', 'outputTokens', 'totalTokens', 'estimatedCostUsd', 'usageKnown', 'traceId'] as const) Object.assign(historical.run, { [key]: measured[key] });
      const starts = historical.spans.filter(span => !span.id.startsWith('event:')).map(span => span.startedAt).sort();
      historical.run.startedAt = starts[0] ?? historical.run.startedAt;
      historical.run.durationMs = duration(historical.run.startedAt, historical.run.completedAt);
      historical.run.lastActivityAt = [historical.run.lastActivityAt, measured.lastActivityAt].sort().at(-1)!;
    } else {
      // If a research source was hidden, same-identity captured records cannot recreate it.
      if (id.startsWith('research:')) continue;
      result.push({ run: runFromSpans(id, id.startsWith('native:') || ['local', 'native', 'companion'].includes(head.executionMode ?? '') ? 'native' : 'model', head.sourceId,
        head.sessionId ?? null, head.revision ?? null, head.title, head.scene, spans, head.startedAt), spans, roles: new Map(),
      quality: { completeDelivery: null, traceableEvidence: null, reverseCheck: null, adoption: null } });
    }
  }
  for (const item of result) enrichTelemetryDimensions(item, facts);
  const executions = new Map(result.map(item => [item.run.id, telemetryExecutions(item, facts)]));
  for (const item of result) item.run.agentCount = new Set(executions.get(item.run.id)!.map(execution => effectiveAgentKey(execution.span))).size;
  return result.filter(item => item.run.startedAt >= filters.from && item.run.startedAt <= filters.to
    && (!filters.scene || item.run.scene === filters.scene) && (!filters.status || item.run.status === filters.status)
    && (!(filters.agentId || filters.executionMode || TELEMETRY_DIMENSION_KEYS.some(key => filters[key as keyof TelemetryFilters]))
      || executions.get(item.run.id)!.some(({ span }) => matchesExecutionFilters(span, filters)
        && (!filters.agentId || effectiveAgentKey(span) === filters.agentId) && (!filters.executionMode || span.executionMode === filters.executionMode)))
    && (!filters.search || `${item.run.title} ${item.run.id} ${item.spans.map(span => `${span.name} ${span.model ?? ''}`).join(' ')}`.toLocaleLowerCase().includes(filters.search.toLocaleLowerCase())))
    .sort((a, b) => b.run.startedAt.localeCompare(a.run.startedAt) || a.run.id.localeCompare(b.run.id));
}
