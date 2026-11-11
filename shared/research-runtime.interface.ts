import type { AgentJsonValue, AgentSourceVersionRef, AgentToolEffect } from './agent-tooling.interface';

export const RUNTIME_STATES = ['queued', 'running', 'waiting_approval', 'cancelling',
  'provider_unknown', 'result_received', 'accepted', 'failed', 'cancelled', 'settled_unknown'] as const;
export type RuntimeState = (typeof RUNTIME_STATES)[number];
export const isRuntimeState = (value: string): value is RuntimeState =>
  (RUNTIME_STATES as readonly string[]).includes(value);

export interface RuntimeIdentity {
  owner: string;
  sessionId: string;
  cycleId: string;
  revision: number;
  memberId: string;
  turn: number;
  executionAttempt: number;
}

export interface RuntimeDispatchIdentity {
  owner: string;
  dispatchKey: string;
  /** Hash of the canonical complete provider request, model and frozen revisions. */
  requestHash: string;
}

export interface RuntimeDatasetSnapshotRef { datasetVersionId: string; contentHash: string }
export interface RuntimeFrozenInputSnapshot {
  version: 1;
  datasetVersionIds: string[];
  datasets: RuntimeDatasetSnapshotRef[];
  /** Full facts, kept private. An instrument allowlist cannot replace these values. */
  payload: {
    holdings: Array<{ accountId: string; instrumentId: string; quantity: string | null; [key: string]: AgentJsonValue }>;
    cash: Array<{ accountId: string; amount: string | null; currency: string; [key: string]: AgentJsonValue }>;
    sourcePayloads: Array<{ datasetVersionId: string; [key: string]: AgentJsonValue }>;
    context?: AgentJsonValue;
  };
  payloadHash: string;
}

export interface RuntimeRun {
  id: string;
  identity: RuntimeIdentity;
  memberAttemptId: string | null;
  driver: 'controlled' | 'deep_agents';
  frozenInputHash: string;
  frozenInput: RuntimeFrozenInputSnapshot;
  policySnapshot: RuntimeExecutionPolicy;
  catalogVersionId: string;
  state: RuntimeState;
  cursor: number;
  leaseToken: string | null;
  parentRunId: string | null;
}

/** One step owns exactly one model HTTP request; nested model calls are child dispatches. */
export interface RuntimeStep {
  id: string;
  runId: string;
  stepIndex: number;
  dispatch: RuntimeDispatchIdentity;
  model: string;
  connectionId: string;
  connectionRevision: number;
  state: RuntimeState;
  privateRequestRef: string;
  privateResponseRef: string | null;
  responseHash: string | null;
  providerRequestId: string | null;
  usageKnown: boolean;
  /** Bound to the response, so reparse cannot import another member's evidence. */
  evidenceSnapshot: AgentSourceVersionRef[];
}

export interface RuntimeParseAttempt {
  id: string;
  stepId: string;
  responseHash: string;
  parserVersion: string;
  status: 'accepted' | 'failed';
  errorCode: string | null;
  createdAt: string;
}

export interface RuntimeTransition {
  event: 'start' | 'wait_approval' | 'approve' | 'edit_preview' | 'reject' | 'expire'
    | 'cancel' | 'cancel_confirmed' | 'provider_unknown' | 'provider_result'
    | 'provider_terminated' | 'accept' | 'parse_failed' | 'reparse' | 'close_unknown'
    | 'billing_correction' | 'resume';
  hasStoredResponse?: boolean;
  parseAttemptId?: string;
  providerTerminationConfirmed?: boolean;
}

export interface RuntimeExecutionPolicy {
  loopOwner: 'runtime';
  maxModelRequestsPerStep: 1;
  sdkRetries: 0;
  sdkToolExecution: false;
  sdkToolApproval: false;
  providerExecutedWrites: false;
  fallback: null | {
    connectionId: string;
    explicitlyConfigured: true;
    visible: true;
    errorTriggered: false;
  };
}

export interface RuntimeToolCall { id: string; toolId: string; arguments: Record<string, unknown> }
export interface RuntimePlannedToolCall { toolCallId: string; toolId: string; effect: AgentToolEffect }
export interface RuntimeToolBatchPlan {
  executable: RuntimePlannedToolCall[];
  parkedWrites: RuntimePlannedToolCall[];
}

export interface RuntimeToolInvocation {
  id: string;
  runId: string;
  stepId: string;
  toolCallId: string;
  catalogVersionId: string;
  argumentsHash: string;
  state: RuntimeState;
  privatePayloadRef: string;
  resultRef: string | null;
  providerRequestId: string | null;
}

export interface RuntimeActionPayload {
  accountId: string;
  target: string;
  body: string;
  attachmentHashes: string[];
  catalogVersionId: string;
  connectionRevision: number;
  sourceVersionIds: string[];
  feeCeiling: { amount: string; currency: string } | null;
  [key: string]: AgentJsonValue;
}

export interface RuntimeApprovalPreview {
  id: string;
  runId: string;
  stepId: string;
  invocationId: string;
  state: RuntimeState;
  revision: number;
  payloadHash: string;
  payload: RuntimeActionPayload;
  expiresAt: number;
  approval: { payloadHash: string; revision: number; approvedAt: number } | null;
}

/** Unknown reservations stay in inFlight until supported by provider facts. */
export interface RuntimeBudgetBalance { limit: number; settled: number; inFlight: number[] }
export interface RuntimeToolBudgetReservation {
  owner: string;
  runId: string;
  invocationId: string;
  reservedQuantity: string;
  reservedAmount: string | null;
  currency: string | null;
  priceVersionId: string | null;
  state: 'reserved' | 'settled' | 'unknown';
}

export interface RuntimeRecoveryTarget { runId: string; stepId?: string; expectedCursor: number }
export interface CouncilRuntimePending extends RuntimeRecoveryTarget {
  memberId: string; turn: number; attemptId?: string; state: string; resumeRequested?: boolean;
}
export interface CouncilRuntimeRecoveryInput {
  action: 'check_existing' | 'resume_approval' | 'reparse_existing' | 'close_unknown';
  requestKey: string; expectedRevision: number; runtimeTarget: RuntimeRecoveryTarget;
}
