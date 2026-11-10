/** Owner-scoped operational facts. Missing measurements remain null, never zero. */
export type TelemetryStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown';
export type TelemetryKind = 'task' | 'agent' | 'model' | 'tool';
export interface TelemetryFilters {
  from?: string; to?: string; scene?: string; agentId?: string;
  executionMode?: string; status?: TelemetryStatus; search?: string; offset?: number; limit?: number;
}
export interface TelemetryRun {
  id: string; source: 'research' | 'model' | 'native'; sourceId: string;
  sessionId: string | null; revision: number | null; title: string; scene: string;
  startedAt: string; completedAt: string | null; lastActivityAt: string;
  status: TelemetryStatus; durationMs: number | null; agentCount: number;
  inputTokens: number | null; outputTokens: number | null; totalTokens: number | null;
  estimatedCostUsd: number | null; usageKnown: boolean; eventsTruncated: boolean;
  accepted: boolean | null; reportVersionId: string | null; adopted: boolean | null; traceId: string | null;
}
export interface TelemetrySpan {
  id: string; parentId: string | null; kind: TelemetryKind; name: string; status: TelemetryStatus;
  agentId: string | null; agentName: string | null; provider: string | null; model: string | null;
  executionMode: string | null; startedAt: string; completedAt: string | null; durationMs: number | null;
  inputTokens: number | null; outputTokens: number | null; totalTokens: number | null;
  estimatedCostUsd: number | null; errorCode: string | null; attempt: number; traceId: string | null;
}
export interface TelemetrySpanRecord extends TelemetrySpan {
  runId: string; sourceId: string; sessionId?: string | null; revision?: number | null;
  scene: string; title: string;
}
export interface TelemetryRatio { numerator: number; denominator: number; value: number | null }
export interface TelemetryAgent {
  id: string; name: string; role: string; provider: string | null; model: string | null; executionMode: string;
  executions: number; completed: number; failed: number; accepted: number; acceptanceKnown: number;
  completionRate: number | null; p95DurationMs: number | null; totalTokens: number | null;
  estimatedCostUsd: number | null; knownUsageExecutions: number;
}
export interface TelemetryIntegration {
  enabled: boolean; configured: boolean; status: 'disabled' | 'ready' | 'unavailable';
  baseUrl: string | null; projectUrl: string | null; captureContent: false;
}
export interface TelemetryFeedback { rating: 'positive' | 'negative'; comment: string; updatedAt: string }
export interface TelemetryFeedbackInput { rating: 'positive' | 'negative'; comment?: string }
export interface TelemetryWorkspace {
  generatedAt: string; range: { from: string; to: string }; total: number;
  overview: {
    totalRuns: number; completedRuns: number; failedRuns: number; cancelledRuns: number;
    runningRuns: number; unknownRuns: number; completionRate: number | null; p95DurationMs: number | null;
    totalTokens: number | null; estimatedCostUsd: number | null; knownUsageRuns: number;
    tokenCoverageRate: number | null;
    trends: Array<{ date: string; completed: number; failed: number; other: number }>;
  };
  agents: TelemetryAgent[]; runs: TelemetryRun[];
  quality: {
    completeDelivery: TelemetryRatio; traceableEvidence: TelemetryRatio; reverseCheck: TelemetryRatio;
    adoption: TelemetryRatio; evaluationAvailable: boolean; feedback: { positive: number; negative: number };
  };
  integration: TelemetryIntegration; limitations: string[];
}
export interface TelemetryRunDetail {
  run: TelemetryRun; spans: TelemetrySpan[]; feedback: TelemetryFeedback | null;
  integration: TelemetryIntegration; limitations: string[];
}
