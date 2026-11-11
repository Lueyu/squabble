import type { NativeDiagnosticEvent } from '../../../shared/local-agent-diagnostics.interface';
import { COMPANION_FAILURE_CODES } from '../../../shared/local-agents.interface';
import type { AgentTask } from './local-agents.store';

/** Second trust boundary: copy only fixed operational fields into the durable journal. */
export function appendNativeDiagnostics(task: AgentTask, entries: NativeDiagnosticEvent[]): void {
  if (!['queued', 'running', 'cancelling'].includes(task.state)) return;
  if (entries.length > 64) task.diagnosticsTruncated = true;
  for (const entry of entries.slice(0, 64)) {
    if (!entry || !/^[A-Za-z0-9_.:-]{1,128}$/u.test(entry.id)
      || !['preflight', 'process', 'output', 'result'].includes(entry.stage)
      || !['running', 'succeeded', 'failed', 'cancelled', 'interrupted'].includes(entry.status)
      || !Number.isFinite(Date.parse(entry.at))) continue;
    const entries = task.diagnostics ??= [];
    if (entries.some(item => item.id === entry.id)) continue;
    const at = new Date(Math.max(task.createdAt, Math.min(Date.now(), Date.parse(entry.at)))).toISOString();
    const event: NativeDiagnosticEvent = { id: entry.id, stage: entry.stage, status: entry.status, at };
    if (COMPANION_FAILURE_CODES.includes(entry.code as typeof COMPANION_FAILURE_CODES[number])) event.code = entry.code;
    if (Number.isSafeInteger(entry.exitCode) && Number(entry.exitCode) >= -2147483648 && Number(entry.exitCode) <= 4294967295) event.exitCode = entry.exitCode;
    for (const key of ['outputBytes', 'stderrBytes'] as const) if (Number.isSafeInteger(entry[key]) && Number(entry[key]) >= 0) event[key] = entry[key];
    if (typeof entry.terminalEvent === 'boolean') event.terminalEvent = entry.terminalEvent;
    entries.push(event); task.updatedAt = Date.now();
    if (entries.length > 128) { task.diagnostics = [entries[0], ...entries.slice(-127)]; task.diagnosticsTruncated = true; }
  }
}
