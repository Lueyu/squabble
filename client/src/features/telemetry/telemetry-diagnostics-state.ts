import type { TelemetryDiagnostics, TelemetryDiagnosticEvent, TelemetryTaskDiagnostic } from '@shared/telemetry-diagnostics.interface';

/** Only persisted evidence establishes a stage or a successful step. Silence establishes neither. */
export function diagnosticEvidence(task: TelemetryTaskDiagnostic): {
  stage: TelemetryDiagnosticEvent['stage'] | null;
  latestEvent: TelemetryDiagnosticEvent | null;
  lastSuccess: TelemetryDiagnosticEvent | null;
} {
  const events = [...task.events].sort((a, b) => a.sequence - b.sequence);
  const latestEvent = events[events.length - 1] ?? null;
  return { stage: latestEvent?.stage ?? null, latestEvent, lastSuccess: [...events].reverse().find(event => event.status === 'succeeded') ?? null };
}

export function diagnosticAccessDenied(error: unknown): boolean {
  const status = (error as { response?: { status?: number } } | null)?.response?.status;
  return status === 401 || status === 403 || status === 404;
}

/** Export the public response schema, never request state or arbitrary object properties. */
export function diagnosticPack(runId: string, data: TelemetryDiagnostics): string {
  return JSON.stringify({ schemaVersion: 1, runId, diagnostics: {
    generatedAt: data.generatedAt, cursor: data.cursor, coverage: data.coverage, publication: data.publication,
    tasks: data.tasks.map(task => ({
      taskId: task.taskId, memberId: task.memberId, memberName: task.memberName,
      provider: task.provider, transport: task.transport, retained: task.retained, attempt: task.attempt,
      state: task.state, configuredModel: task.configuredModel, observedModel: task.observedModel,
      createdAt: task.createdAt, updatedAt: task.updatedAt, lastActivityAt: task.lastActivityAt,
      heartbeatAt: task.heartbeatAt, processState: task.processState, acceptance: task.acceptance,
      activityCapability: task.activityCapability, modelRequestsVisible: false, eventsTruncated: task.eventsTruncated,
      failure: task.failure ? {
        code: task.failure.code, stage: task.failure.stage, fieldPath: task.failure.fieldPath,
        expectedType: task.failure.expectedType, actualType: task.failure.actualType,
        exitCode: task.failure.exitCode, outputBytes: task.failure.outputBytes, stderrBytes: task.failure.stderrBytes,
        terminalEvent: task.failure.terminalEvent, recoveries: task.failure.recoveries,
      } : null,
      events: task.events.map(event => ({
        id: event.id, taskId: event.taskId, sequence: event.sequence, kind: event.kind,
        stage: event.stage, status: event.status, at: event.at, summary: event.summary,
        toolName: event.toolName, callId: event.callId, durationMs: event.durationMs,
        code: event.code, exitCode: event.exitCode, outputBytes: event.outputBytes,
        stderrBytes: event.stderrBytes, terminalEvent: event.terminalEvent,
      })),
    })),
  } }, null, 2);
}

/** Subsecond task failures need finer timestamps than the aggregate run list. */
export function formatDiagnosticTime(value: string, language: string): string {
  const at = new Date(value);
  if (!Number.isFinite(at.getTime())) return '—';
  const time = at.toLocaleString(language, {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  return `${time}.${String(at.getMilliseconds()).padStart(3, '0')}`;
}
