// The desktop package has an independent rootDir; mirror the fixed shared wire types.
export const FAILURE_CODES = ['LOCAL_INVALID_CONFIGURATION', 'LOCAL_CONFIGURATION_UNSUPPORTED', 'LOCAL_VERSION_UNSUPPORTED',
  'LOCAL_LOGIN_REQUIRED', 'LOCAL_DISPATCH_UNCERTAIN', 'LOCAL_TOOL_ISOLATION_FAILED', 'LOCAL_USAGE_LIMIT', 'LOCAL_RATE_LIMIT',
  'LOCAL_IMAGE_UNSUPPORTED', 'LOCAL_INVALID_INPUT', 'LOCAL_TIMEOUT', 'LOCAL_OUTPUT_LIMIT', 'LOCAL_LAUNCH_FAILED',
  'LOCAL_PROTOCOL_INCOMPLETE', 'LOCAL_NETWORK_UNAVAILABLE', 'LOCAL_TASK_FAILED', 'LOCAL_INVALID_RESULT', 'LOCAL_CANCELLED',
  'LOCAL_PAUSED', 'LOCAL_INTERRUPTED', 'LOCAL_UNAVAILABLE', 'MEMORY_CONTEXT_CHANGED'] as const;
export type FailureCode = typeof FAILURE_CODES[number];
export interface SafeFailure { code: FailureCode; stage: 'preflight' | 'dispatch' | 'runtime' | 'parse';
  fieldPath?: string; expectedType?: string; actualType?: string; exitCode?: number; outputBytes?: number; stderrBytes?: number;
  terminalEvent?: boolean; recoveries: Array<'check_existing' | 'reparse_existing' | 'retry_member' | 'fix_configuration'> }
export interface NativeDiagnosticEvent { id: string; stage: 'preflight' | 'process' | 'output' | 'result';
  status: 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted'; at: string; code?: string;
  exitCode?: number; outputBytes?: number; stderrBytes?: number; terminalEvent?: boolean }
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

export function safeFailure(value: unknown, code: FailureCode): SafeFailure {
  const row = object(value);
  const result: SafeFailure = { code: FAILURE_CODES.includes(row.code as FailureCode) ? row.code as FailureCode : code,
    stage: ['preflight', 'dispatch', 'runtime', 'parse'].includes(String(row.stage)) ? row.stage as SafeFailure['stage'] : 'runtime',
    recoveries: ['LOCAL_DISPATCH_UNCERTAIN', 'LOCAL_PAUSED', 'LOCAL_INTERRUPTED'].includes(code) ? ['check_existing'] : ['retry_member'] };
  if (Array.isArray(row.recoveries) && row.recoveries.length <= 4 && row.recoveries.every(item => ['check_existing', 'reparse_existing', 'retry_member', 'fix_configuration'].includes(String(item)))) result.recoveries = [...row.recoveries] as SafeFailure['recoveries'];
  for (const [key, limit] of [['fieldPath', 160], ['expectedType', 120], ['actualType', 80]] as const) {
    if (typeof row[key] === 'string' && row[key].length <= limit && /^[A-Za-z0-9_. ()–-]+$/u.test(row[key])) result[key] = row[key];
  }
  if (Number.isSafeInteger(row.exitCode) && Number(row.exitCode) >= -2147483648 && Number(row.exitCode) <= 4294967295) result.exitCode = Number(row.exitCode);
  for (const key of ['outputBytes', 'stderrBytes'] as const) if (Number.isSafeInteger(row[key]) && Number(row[key]) >= 0) result[key] = Number(row[key]);
  if (typeof row.terminalEvent === 'boolean') result.terminalEvent = row.terminalEvent;
  return result;
}

/** Copy only metadata and retain bounded pending entries until acknowledgement. */
export class DiagnosticBuffer {
  private entries: NativeDiagnosticEvent[] = [];
  truncated = false;
  get length(): number { return this.entries.length; }
  append(value: NativeDiagnosticEvent, secret: string): void {
    const row = object(value);
    if (typeof row.id !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/u.test(row.id)
      || !['preflight', 'process', 'output', 'result'].includes(String(row.stage))
      || !['running', 'succeeded', 'failed', 'cancelled', 'interrupted'].includes(String(row.status))
      || typeof row.at !== 'string' || !Number.isFinite(Date.parse(row.at)) || this.entries.some(item => item.id === row.id)) return;
    if (this.entries.length >= 128) { this.truncated = true; return; }
    const event: NativeDiagnosticEvent = { id: row.id, stage: row.stage as NativeDiagnosticEvent['stage'],
      status: row.status as NativeDiagnosticEvent['status'], at: new Date(row.at).toISOString() };
    const failure = safeFailure(row, 'LOCAL_TASK_FAILED');
    for (const key of ['exitCode', 'outputBytes', 'stderrBytes', 'terminalEvent'] as const) if (failure[key] !== undefined) Object.assign(event, { [key]: failure[key] });
    if (FAILURE_CODES.includes(row.code as FailureCode)) event.code = row.code as string;
    if (!JSON.stringify(event).includes(secret)) this.entries.push(event);
  }
  snapshot(): NativeDiagnosticEvent[] { return this.entries.slice(0, 32).map(event => ({ ...event })); }
  acknowledge(events: NativeDiagnosticEvent[]): void {
    const ids = new Set(events.map(event => event.id)); this.entries = this.entries.filter(event => !ids.has(event.id));
  }
}
