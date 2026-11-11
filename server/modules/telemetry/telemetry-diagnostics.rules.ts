import { createHash } from 'node:crypto';
import type { SafeFailure, ResultAcceptance, ResearchTaskActivityContext } from '../../../shared/research-execution.interface';
import type { TelemetryDiagnosticEvent, TelemetryDiagnostics, TelemetryTaskDiagnostic } from '../../../shared/telemetry-diagnostics.interface';
import type { LocalAgentTaskDiagnostics } from '../local-agents/local-agents.types';
import { publicText } from '../local-agents/research-journal';

export interface DiagnosticTaskReference {
  id: string;
  remoteTaskId: string | null;
  sessionId: string | null;
  revision: number | null;
  cycleId: string | null;
  memberId: string | null;
  memberName: string;
  attempt: number;
  turn: number | null;
  createdAt: string;
  updatedAt: string;
  acceptance: ResultAcceptance | null;
  acceptanceAt?: string;
  failure: SafeFailure | null;
  /** Legacy optional retry coordinates are safe only with a unique authoritative task association. */
  allowUnnumberedAttempt?: boolean;
  ambiguous?: boolean;
}
const identifier = (value: unknown, max = 128): string | undefined => typeof value === 'string'
  && /^[A-Za-z0-9_.:/+-]+$/u.test(value) && value.length <= max ? value : undefined;
const measurement = (value: unknown): number | undefined => typeof value === 'number' && Number.isSafeInteger(value)
  && value >= 0 && value <= 2_147_483_647 ? value : undefined;
const date = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));
const stageOrder: Record<TelemetryDiagnosticEvent['stage'], number> = { queue: 0, preflight: 1, dispatch: 2, execution: 3, result: 4, acceptance: 5, publication: 6 };

interface ReviewedWorkflowAttempt {
  id: string;
  kind: 'work' | 'review';
  state: string;
  finishedAt?: string;
  reviewAccepted: boolean | null;
}

/** A later work attempt closes the previous work/review segment; mutable task state cannot erase its saved verdict. */
export function workflowDiagnosticAcceptance(attempts: ReviewedWorkflowAttempt[], index: number,
  acceptedAttemptId: string | null): { acceptance: ResultAcceptance | null; acceptanceAt?: string } {
  const work = attempts[index];
  if (work.kind === 'review') return { acceptance: null };
  const nextWork = attempts.findIndex((attempt, position) => position > index && attempt.kind === 'work');
  const review = attempts.slice(index + 1, nextWork < 0 ? undefined : nextWork)
    .filter(attempt => attempt.kind === 'review' && attempt.state === 'succeeded' && typeof attempt.reviewAccepted === 'boolean').at(-1);
  if (acceptedAttemptId === work.id) return { acceptance: 'accepted', acceptanceAt: review?.reviewAccepted === true ? review.finishedAt : work.finishedAt };
  if (work.state === 'succeeded' && review) return { acceptance: review.reviewAccepted ? 'accepted' : 'rejected', acceptanceAt: review.finishedAt };
  return { acceptance: 'pending' };
}

/** Reconstruct the fixed failure contract; historical JSON may contain additional private fields. */
export function diagnosticFailure(input: SafeFailure | null | undefined): SafeFailure | null {
  if (!input || !/^[A-Z][A-Z_0-9]{1,100}$/u.test(input.code)
    || !['preflight', 'dispatch', 'runtime', 'parse'].includes(input.stage)) return null;
  const field = (value: unknown, max: number): string | undefined => typeof value === 'string'
    && /^[A-Za-z0-9_. ()–-]+$/u.test(value) ? value.slice(0, max) : undefined;
  return { code: input.code, stage: input.stage,
    recoveries: [...new Set((input.recoveries ?? []).filter(value => ['check_existing', 'reparse_existing', 'retry_member', 'fix_configuration'].includes(value)))],
    ...(field(input.fieldPath, 160) ? { fieldPath: field(input.fieldPath, 160) } : {}),
    ...(field(input.expectedType, 120) ? { expectedType: field(input.expectedType, 120) } : {}),
    ...(field(input.actualType, 80) ? { actualType: field(input.actualType, 80) } : {}),
    ...(typeof input.exitCode === 'number' && Number.isSafeInteger(input.exitCode) ? { exitCode: input.exitCode } : {}),
    ...(measurement(input.outputBytes) !== undefined ? { outputBytes: input.outputBytes } : {}),
    ...(measurement(input.stderrBytes) !== undefined ? { stderrBytes: input.stderrBytes } : {}),
    ...(typeof input.terminalEvent === 'boolean' ? { terminalEvent: input.terminalEvent } : {}) };
}

/** Remote task IDs and every recorded source coordinate must agree, including retry identity. */
export function diagnosticContextMatches(reference: DiagnosticTaskReference,
  context?: Pick<ResearchTaskActivityContext, 'sessionId' | 'revision' | 'cycleId' | 'memberId' | 'turn' | 'attempt'>): boolean {
  if (!reference.sessionId) return !context?.sessionId;
  return !!context && context.sessionId === reference.sessionId && context.revision === reference.revision
    && context.cycleId === reference.cycleId && context.memberId === reference.memberId
    && (reference.turn === null || context.turn === reference.turn)
    && (context.attempt === reference.attempt || context.attempt === undefined && reference.allowUnnumberedAttempt === true);
}

function processState(task: LocalAgentTaskDiagnostics): TelemetryTaskDiagnostic['processState'] {
  const markers = task.diagnostics.filter(event => event.stage === 'process');
  const last = markers.at(-1);
  if (!last) return 'not_observed';
  if (last.status === 'running') return ['running', 'cancelling'].includes(task.state) ? 'running' : 'unknown';
  // -1 can mean failed launch or unconfirmed termination, rather than an observed exit.
  if (last.exitCode !== undefined && last.exitCode >= 0) return 'exited';
  return markers.some(event => event.status === 'running') ? 'unknown' : 'not_observed';
}

function terminalStage(reference: DiagnosticTaskReference, task: LocalAgentTaskDiagnostics,
  at: string, recorded: TelemetryDiagnosticEvent[]): TelemetryDiagnosticEvent['stage'] {
  const failure = diagnosticFailure(reference.failure) ?? diagnosticFailure(task.failure);
  if (failure?.stage === 'preflight' || failure?.stage === 'dispatch') return failure.stage;
  if (failure?.stage === 'parse') return 'result';
  const observed = recorded.filter(event => Date.parse(event.at) <= Date.parse(at));
  const native = observed.filter(event => event.id.startsWith('native:')).at(-1);
  if (native) return native.stage;
  const activity = observed.filter(event => event.kind === 'tool' || event.kind === 'summary').at(-1);
  return activity?.stage ?? (task.commandEmitted || task.runtimeEntered ? 'dispatch' : 'queue');
}

function publicEvents(reference: DiagnosticTaskReference, task: LocalAgentTaskDiagnostics): TelemetryDiagnosticEvent[] {
  const taskId = reference.remoteTaskId!;
  const events: TelemetryDiagnosticEvent[] = [];
  for (const event of task.diagnostics.slice(0, 256)) {
    if (!identifier(event.id) || !date(event.at) || !['preflight', 'process', 'output', 'result'].includes(event.stage)
      || !['running', 'succeeded', 'failed', 'cancelled', 'interrupted'].includes(event.status)) continue;
    const stage = event.stage === 'preflight' ? 'preflight' : event.stage === 'result' ? 'result' : 'execution';
    const summary = event.stage === 'preflight' ? 'Native execution preflight' : event.stage === 'output' ? 'First process output observed'
      : event.stage === 'result' ? 'Provider result protocol' : event.status === 'running' ? 'Native process started' : 'Native process ended';
    events.push({ id: `native:${event.id}`, taskId, sequence: 0, kind: 'stage', stage, status: event.status, at: event.at, summary,
      ...(event.code && /^[A-Z][A-Z_0-9]{1,100}$/u.test(event.code) ? { code: event.code } : {}),
      ...(typeof event.exitCode === 'number' && Number.isSafeInteger(event.exitCode) ? { exitCode: event.exitCode } : {}),
      ...(measurement(event.outputBytes) !== undefined ? { outputBytes: event.outputBytes } : {}),
      ...(measurement(event.stderrBytes) !== undefined ? { stderrBytes: event.stderrBytes } : {}),
      ...(typeof event.terminalEvent === 'boolean' ? { terminalEvent: event.terminalEvent } : {}) });
  }
  for (const event of task.events.slice(0, 256)) {
    if (event.taskId !== taskId || !diagnosticContextMatches(reference, event) || !identifier(event.id) || !date(event.at)
      || !['task', 'tool', 'summary', 'capability', 'skill'].includes(event.kind)
      || !['queued', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted', 'unavailable'].includes(event.status)
      || typeof event.summary !== 'string') continue;
    const kind = event.kind === 'task' || event.kind === 'skill' ? 'stage' : event.kind;
    const stage = event.kind !== 'task' ? 'execution' : event.status === 'queued' ? 'queue' : event.status === 'running' ? 'dispatch'
      : event.status === 'succeeded' ? 'result' : terminalStage(reference, task, event.at, events);
    events.push({ id: `activity:${event.id}`, taskId, sequence: 0, kind, stage,
      status: event.status, at: event.at, summary: event.kind === 'task' && event.status === 'running'
        ? 'Task handed off; subprocess launch not yet established' : publicText(event.summary),
      ...(identifier(event.toolName, 101) ? { toolName: event.toolName } : {}),
      ...(identifier(event.callId) ? { callId: event.callId } : {}),
      ...(measurement(event.durationMs) !== undefined ? { durationMs: event.durationMs } : {}) });
  }
  return [...new Map(events.map(event => [event.id, event])).values()];
}

export function diagnosticTask(reference: DiagnosticTaskReference, retained?: LocalAgentTaskDiagnostics): TelemetryTaskDiagnostic {
  const task = !reference.ambiguous && retained?.taskId === reference.remoteTaskId && diagnosticContextMatches(reference, retained.activityContext) ? retained : undefined;
  const events = task ? publicEvents(reference, task) : [];
  const taskId = !reference.ambiguous && reference.remoteTaskId || `attempt:${reference.id}`;
  if (reference.acceptance === 'accepted' || reference.acceptance === 'rejected') events.push({
    id: `acceptance:${reference.id}`, taskId, sequence: events.length + 1, kind: 'acceptance', stage: 'acceptance',
    status: reference.acceptance === 'accepted' ? 'succeeded' : 'failed', at: reference.acceptanceAt ?? reference.updatedAt,
    summary: reference.acceptance === 'accepted' ? 'Application accepted the returned result' : 'Application rejected the returned result' });
  // Coincident timestamps are not finer timing measurements. Use fixed protocol stage order across streams,
  // preserving input order within each equal stage so a late-concatenated tool cannot follow its result marker.
  events.sort((a, b) => a.at.localeCompare(b.at) || stageOrder[a.stage] - stageOrder[b.stage]);
  events.forEach((event, index) => { event.sequence = index + 1; });
  const tools = events.filter(event => event.kind === 'tool');
  const bridgeHeartbeat = task?.executionMode === 'companion' && date(task.companionLastSeenAt)
    && new Date(task.companionLastSeenAt).toISOString() === task.companionLastSeenAt ? task.companionLastSeenAt : null;
  return { taskId, memberId: reference.memberId, memberName: publicText(reference.memberName, 80),
    provider: task?.provider ?? null, transport: task?.executionMode ?? null, retained: !!task,
    attempt: reference.attempt, state: task?.state ?? 'unknown', configuredModel: task?.configuredModel ? publicText(task.configuredModel, 160) : null,
    observedModel: null, createdAt: task?.createdAt ?? reference.createdAt, updatedAt: task?.updatedAt ?? reference.updatedAt,
    lastActivityAt: events.filter(event => event.kind !== 'acceptance').map(event => event.at).sort().at(-1) ?? null,
    // This is the owner/task-device bridge heartbeat. It does not prove task progress or process liveness.
    heartbeatAt: bridgeHeartbeat, processState: task ? processState(task) : 'unknown',
    acceptance: reference.acceptance, failure: diagnosticFailure(reference.failure) ?? diagnosticFailure(task?.failure),
    activityCapability: task?.activityCapability ?? (tools.length ? tools.some(event => !['queued', 'running'].includes(event.status)) ? 'tools' : 'starts_only'
      : events.some(event => event.kind === 'stage') ? 'phases' : 'none'), modelRequestsVisible: false,
    eventsTruncated: !!task && (task.eventsTruncated || task.diagnosticsTruncated), events };
}

export function diagnosticSnapshot(tasks: TelemetryTaskDiagnostic[], publication: TelemetryDiagnostics['publication'], incomplete = false): TelemetryDiagnostics {
  const observed = tasks.filter(task => task.retained);
  const coverage = !observed.length ? 'unavailable' : incomplete || observed.length !== tasks.length
    || tasks.some(task => task.eventsTruncated || task.processState === 'not_observed' || task.processState === 'unknown') ? 'partial' : 'available';
  const cursor = createHash('sha256').update(JSON.stringify({ tasks, coverage, publication })).digest('hex');
  return { generatedAt: new Date().toISOString(), tasks, coverage, publication, cursor };
}
