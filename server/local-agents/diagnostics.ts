import { randomUUID } from 'node:crypto';
import type { NativeDiagnosticEvent } from '../../shared/local-agent-diagnostics.interface';

/** Observation is best effort and must never alter or replay native execution. */
export function observe<T>(callback: ((value: T) => void) | undefined, value: T): void {
  try { void Promise.resolve(callback?.(value)).catch(() => undefined); }
  catch { /* The execution result owns control flow. */ }
}
export function diagnostic(callback: ((event: NativeDiagnosticEvent) => void) | undefined,
  value: Omit<NativeDiagnosticEvent, 'id' | 'at'>): void {
  if (!callback) return;
  observe(callback, { id: randomUUID(), at: new Date().toISOString(), ...value });
}
