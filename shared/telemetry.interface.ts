/** Owner-scoped operational facts. Missing measurements remain null, never zero. */
export type TelemetryStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown';
export type TelemetryKind = 'task' | 'agent' | 'model' | 'tool';
/** Frozen execution references, never inferred from a current roster or a display name. */
export interface TelemetryDimensions {
  rosterAgentId?: string | null; rosterAgentVersionId?: string | null;
  memberId?: string | null; teamId?: string | null; teamVersionId?: string | null;
  commissionId?: string | null; workKey?: string | null; attemptId?: string | null;
  /** Saved selection/policy; provider/model below are observed execution facts. */
  configuredModel?: string | null;
}
/** A future privately authorized episode can refer to this trajectory without exporting content. */
export interface TelemetryTrajectoryRef extends TelemetryDimensions {
  runId: string; spanId: string; sourceId: string; sessionId: string | null; revision: number | null;
}
export interface TelemetryFilters {
  from?: string; to?: string; scene?: string; agentId?: string;
  rosterAgentId?: string; rosterAgentVersionId?: string; teamId?: string; teamVersionId?: string;
  commissionId?: string; workKey?: string; attemptId?: string; memberId?: string;
  executionMode?: string; status?: TelemetryStatus; search?: string; offset?: number; limit?: number;
}
export interface TelemetryRun extends Pick<TelemetryDimensions, 'teamId' | 'teamVersionId' | 'commissionId'> {
  id: string; source: 'research' | 'model' | 'native'; sourceId: string;
  sessionId: string | null; revision: number | null; title: string; scene: string;
  startedAt: string; completedAt: string | null; lastActivityAt: string;
  status: TelemetryStatus; durationMs: number | null; agentCount: number;
  inputTokens: number | null; outputTokens: number | null; totalTokens: number | null;
  estimatedCostUsd: number | null; usageKnown: boolean; eventsTruncated: boolean;
  accepted: boolean | null; reportVersionId: string | null; adopted: boolean | null; traceId: string | null;
}
export interface TelemetrySpan extends TelemetryDimensions {
  /** One measured review may cover multiple exact workflow receipts; it is still counted once. */
  relatedWorkRefs?: Array<{ workKey: string; attemptId: string }>;
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
export interface TelemetryAgent extends TelemetryDimensions {
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
