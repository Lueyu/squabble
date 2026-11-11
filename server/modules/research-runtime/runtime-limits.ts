export interface RuntimeLimits { maxSteps: number; maxToolCallsPerStep: number; maxInvocations: number }
export const DEFAULT_RUNTIME_LIMITS: Readonly<RuntimeLimits> = Object.freeze({
  maxSteps: 6, maxToolCallsPerStep: 4, maxInvocations: 24,
});

/** Callers may reduce the frozen limits, never increase the controlled-loop envelope. */
export function runtimeLimits(policy: Record<string, unknown>): RuntimeLimits {
  const bounded = (value: unknown, ceiling: number): number => {
    if (value === undefined) return ceiling;
    if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > ceiling) throw new Error('RUNTIME_LIMIT_INVALID');
    return Number(value);
  };
  return { maxSteps: bounded(policy.maxSteps, 6), maxToolCallsPerStep: bounded(policy.maxToolCallsPerStep, 4),
    maxInvocations: bounded(policy.maxInvocations ?? policy.maxTools, 24) };
}
