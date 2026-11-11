import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AGENT_DATA_CLASSES, AGENT_TOOL_EFFECTS } from '@shared/agent-tooling.interface';
import type {
  AgentToolDescriptor, AgentToolErrorResult, AgentToolResultEnvelope,
} from '@shared/agent-tooling.interface';
import type { ResearchToolResult } from '@shared/research-tools.interface';
import type {
  RuntimeActionPayload, RuntimeApprovalPreview, RuntimeBudgetBalance,
  RuntimeDispatchIdentity, RuntimeFrozenInputSnapshot, RuntimePlannedToolCall,
  RuntimeState, RuntimeToolBatchPlan, RuntimeToolCall, RuntimeTransition,
} from '@shared/research-runtime.interface';

const HASH = /^[a-f0-9]{64}$/u;
const MAX_SCHEMA_BYTES = 65_536;
const MAX_SCHEMA_DEPTH = 16;
const idSchema = z.string().trim().min(1).max(160).regex(/^[^\u0000-\u001f]+$/u);

/** Canonicalization deliberately rejects lossy JSON values before hashing. */
function canonicalJson(value: unknown, ancestors: Set<object> = new Set()): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (!value || typeof value !== 'object' || ancestors.has(value)) throw new Error('INVALID_JSON');
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) throw new Error('INVALID_JSON');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      // Array holes would otherwise silently become null during serialization.
      if (Object.keys(value).length !== value.length) throw new Error('INVALID_JSON');
      return `[${value.map(item => canonicalJson(item, ancestors)).join(',')}]`;
    }
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(object[key], ancestors)}`).join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

export function canonicalHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

/** Billing corrections are audited facts; they never reopen a closed workflow. */
export function assertRuntimeTransition(from: RuntimeState, to: RuntimeState, context: RuntimeTransition): void {
  if (context.event === 'billing_correction' && from === to
    && ['provider_unknown', 'result_received', 'accepted', 'failed', 'cancelled', 'settled_unknown'].includes(from)) return;
  if (from === 'failed' && to === 'result_received' && context.event === 'reparse') {
    if (!context.hasStoredResponse || !context.parseAttemptId?.trim()) throw new Error('RUNTIME_REPARSE_REQUIRES_RESPONSE_AND_AUDIT');
    return;
  }
  const transitions = new Set([
    'queued:start:running', 'queued:cancel:cancelled',
    'running:wait_approval:waiting_approval', 'running:provider_unknown:provider_unknown',
    'running:provider_result:result_received', 'running:cancel:cancelling',
    'waiting_approval:approve:running', 'waiting_approval:edit_preview:waiting_approval',
    'waiting_approval:reject:cancelled', 'waiting_approval:expire:cancelled', 'waiting_approval:cancel:cancelled',
    'provider_unknown:provider_result:result_received', 'provider_unknown:provider_terminated:failed',
    'provider_unknown:cancel_confirmed:cancelled', 'provider_unknown:close_unknown:settled_unknown',
    'cancelling:cancel_confirmed:cancelled', 'cancelling:provider_unknown:provider_unknown',
    'cancelling:provider_result:cancelled',
    'result_received:accept:accepted', 'result_received:parse_failed:failed', 'result_received:cancel:cancelled',
  ]);
  if (!transitions.has(`${from}:${context.event}:${to}`)) throw new Error('RUNTIME_TRANSITION_NOT_ALLOWED');
  if (['provider_terminated', 'cancel_confirmed'].includes(context.event) && !context.providerTerminationConfirmed) {
    throw new Error('RUNTIME_PROVIDER_FACT_REQUIRED');
  }
}

/** A replay is scoped to its owner and exact canonical provider request. */
export function assertDispatchReplay(prior: RuntimeDispatchIdentity, next: RuntimeDispatchIdentity): 'reuse' {
  if (prior.owner !== next.owner || prior.dispatchKey !== next.dispatchKey || prior.requestHash !== next.requestHash) {
    throw new Error('DISPATCH_IDENTITY_CONFLICT');
  }
  return 'reuse';
}

export function availableBudget(balance: RuntimeBudgetBalance): number {
  const values = [balance.limit, balance.settled, ...balance.inFlight];
  if (values.some(value => !Number.isFinite(value) || value < 0)) throw new Error('INVALID_BUDGET');
  return Math.max(0, balance.limit - balance.settled - balance.inFlight.reduce((sum, value) => sum + value, 0));
}

const descriptorSchema = z.strictObject({
  id: idSchema, connectionId: idSchema.nullable(), catalogVersionId: idSchema,
  schemaHash: z.string().regex(HASH), name: idSchema, description: z.string().min(1).max(8_192),
  inputSchema: z.record(z.string(), z.unknown()), effect: z.enum(AGENT_TOOL_EFFECTS),
  dataClasses: z.array(z.enum(AGENT_DATA_CLASSES)).min(1).max(4),
  timeoutMs: z.number().int().min(1).max(3_600_000),
  maxOutputBytes: z.number().int().min(1).max(64 * 1024 * 1024),
  supportsCancellation: z.boolean(), supportsStatusLookup: z.boolean(),
  remoteIdempotency: z.enum(['supported', 'unsupported', 'unknown']),
});

function inspectSchema(value: unknown, depth: number): void {
  if (depth > MAX_SCHEMA_DEPTH) throw new Error('TOOL_SCHEMA_DEPTH');
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach(item => inspectSchema(item, depth + 1));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (['$ref', '$dynamicRef', '$recursiveRef'].includes(key)
      && (typeof child !== 'string' || !child.startsWith('#'))) throw new Error('TOOL_SCHEMA_REF');
    inspectSchema(child, depth + 1);
  }
}

export function validateAgentToolDescriptor(value: unknown): AgentToolDescriptor {
  const result = descriptorSchema.safeParse(value);
  if (!result.success) throw new Error('TOOL_DESCRIPTOR_INVALID');
  if (Buffer.byteLength(canonicalJson(result.data.inputSchema), 'utf8') > MAX_SCHEMA_BYTES) throw new Error('TOOL_SCHEMA_SIZE');
  inspectSchema(result.data.inputSchema, 0);
  return { ...result.data, connectionId: result.data.connectionId ?? null };
}

/** There is no SDK execution or approval state machine nested inside the runtime. */
export function assertRuntimeExecutionPolicy(value: unknown): void {
  if (!value || typeof value !== 'object') throw new Error('RUNTIME_POLICY_INVALID');
  const policy = value as Record<string, unknown>;
  if (policy.loopOwner !== 'runtime' || policy.maxModelRequestsPerStep !== 1 || policy.sdkRetries !== 0
    || policy.sdkToolExecution !== false || policy.sdkToolApproval !== false || policy.providerExecutedWrites !== false) {
    throw new Error('RUNTIME_POLICY_INVALID');
  }
  if (policy.fallback === null) return;
  const fallback = policy.fallback as Record<string, unknown> | undefined;
  if (!fallback || !idSchema.safeParse(fallback.connectionId).success || fallback.explicitlyConfigured !== true
    || fallback.visible !== true || fallback.errorTriggered !== false) throw new Error('FALLBACK_POLICY_INVALID');
}

/** Completed receipts include failed/partial reads: resume must not silently repeat them. */
export function planToolBatch(calls: RuntimePlannedToolCall[], completedToolCallIds: readonly string[]): RuntimeToolBatchPlan {
  const seen = new Set<string>();
  const completed = new Set(completedToolCallIds);
  const plan: RuntimeToolBatchPlan = { executable: [], parkedWrites: [] };
  for (const call of calls) {
    if (seen.has(call.toolCallId)) throw new Error('DUPLICATE_TOOL_CALL');
    seen.add(call.toolCallId);
    if (completed.has(call.toolCallId)) continue;
    if (call.effect === 'external_write') plan.parkedWrites.push(call);
    else plan.executable.push(call);
  }
  return plan;
}

/** A preview edit is local and stays on its original model step. */
export function reviseActionPreview(preview: RuntimeApprovalPreview, payload: RuntimeActionPayload, now: number): RuntimeApprovalPreview {
  if (preview.state !== 'waiting_approval') throw new Error('PREVIEW_STATE_INVALID');
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('PREVIEW_TIME_INVALID');
  const revision = preview.revision + 1;
  const snapshot = JSON.parse(canonicalJson(payload)) as RuntimeActionPayload;
  return { ...preview, payload: snapshot, revision, approval: null, expiresAt: now + 15 * 60 * 1_000,
    payloadHash: canonicalHash({ previewId: preview.id, runId: preview.runId, invocationId: preview.invocationId, revision, payload: snapshot }) };
}

export interface JsonActionContext {
  stepId: string;
  maxToolCalls: number;
  catalog: readonly AgentToolDescriptor[];
  /** The compiled, frozen schema validator; no provider calls or repair callbacks. */
  validateArguments: (tool: AgentToolDescriptor, args: Record<string, unknown>) => string | null;
}
export interface JsonActionResult {
  text: string;
  toolCalls: RuntimeToolCall[];
  toolResults: AgentToolErrorResult[];
  /** A hint to the bounded runtime; this function never schedules that step. */
  requiresNewModelStep: boolean;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Invalid model actions become ordinary feedback, not transport failures or paid repair. */
export function parseJsonAction(raw: string, context: JsonActionContext): JsonActionResult {
  const result: JsonActionResult = { text: '', toolCalls: [], toolResults: [], requiresNewModelStep: true };
  const error = (code: AgentToolErrorResult['error']['code'], ordinal: number, toolCallId?: string, toolId?: string): AgentToolErrorResult => ({
    toolCallId: toolCallId ?? `json-action:${context.stepId}:${ordinal}`, toolId: toolId ?? null,
    status: 'failed', error: { code, message: code, retryable: false },
  });
  if (!idSchema.safeParse(context.stepId).success || !Number.isSafeInteger(context.maxToolCalls)
    || context.maxToolCalls < 1 || context.maxToolCalls > 4) throw new Error('JSON_ACTION_CONTEXT_INVALID');
  let action: unknown;
  try {
    if (Buffer.byteLength(raw, 'utf8') > MAX_SCHEMA_BYTES) throw new Error('ACTION_SIZE');
    action = JSON.parse(raw);
  } catch {
    result.toolResults.push(error('INVALID_JSON_ACTION', 0));
    return result;
  }
  if (isObject(action) && action.type === 'final' && typeof action.text === 'string' && action.text.trim()
    && Object.keys(action).every(key => ['type', 'text'].includes(key))) {
    return { ...result, text: action.text, requiresNewModelStep: false };
  }
  if (!isObject(action) || action.type !== 'tool_calls' || !Array.isArray(action.toolCalls)
    || action.toolCalls.length === 0 || Object.keys(action).some(key => !['type', 'toolCalls'].includes(key))) {
    result.toolResults.push(error('INVALID_ACTION_SCHEMA', 0));
    return result;
  }
  if (action.toolCalls.length > context.maxToolCalls) {
    result.toolResults.push(error('TOOL_CALL_LIMIT', 0));
    return result;
  }
  const ids = action.toolCalls.filter(isObject).map(call => call.id).filter(id => typeof id === 'string');
  if (new Set(ids).size !== ids.length) {
    result.toolResults.push(error('DUPLICATE_TOOL_CALL', 0));
    return result;
  }
  action.toolCalls.forEach((call: unknown, ordinal: number) => {
    if (!isObject(call) || !idSchema.safeParse(call.id).success || !idSchema.safeParse(call.toolId).success
      || !isObject(call.arguments) || Object.keys(call).some(key => !['id', 'toolId', 'arguments'].includes(key))) {
      result.toolResults.push(error('INVALID_ACTION_SCHEMA', ordinal));
      return;
    }
    const toolCallId = call.id as string;
    const toolId = call.toolId as string;
    const tool = context.catalog.find(candidate => candidate.id === toolId);
    if (!tool) {
      result.toolResults.push(error('UNKNOWN_TOOL', ordinal, toolCallId, toolId));
      return;
    }
    if (context.validateArguments(tool, call.arguments) !== null) {
      result.toolResults.push(error('INVALID_TOOL_ARGUMENTS', ordinal, toolCallId, toolId));
      return;
    }
    result.toolCalls.push({ id: toolCallId, toolId, arguments: call.arguments });
  });
  return result;
}

const snapshotSchema = z.strictObject({
  version: z.literal(1), datasetVersionIds: z.array(idSchema),
  datasets: z.array(z.strictObject({ datasetVersionId: idSchema, contentHash: z.string().regex(HASH) })),
  payloadHash: z.string().regex(HASH),
  payload: z.strictObject({
    holdings: z.array(z.object({ accountId: idSchema, instrumentId: idSchema, quantity: z.string().nullable() }).catchall(z.unknown())),
    cash: z.array(z.object({ accountId: idSchema, amount: z.string().nullable(), currency: z.string() }).catchall(z.unknown())),
    sourcePayloads: z.array(z.object({ datasetVersionId: idSchema }).catchall(z.unknown())),
    context: z.json().optional(),
  }),
});

export function assertFrozenInputSnapshot(value: unknown): asserts value is RuntimeFrozenInputSnapshot {
  const parsed = snapshotSchema.safeParse(value);
  if (!parsed.success) throw new Error('FROZEN_DATASET_VERSION_INVALID');
  const snapshot = parsed.data;
  const ids = snapshot.datasetVersionIds;
  const references = snapshot.datasets.map(dataset => dataset.datasetVersionId);
  const payloadIds = snapshot.payload.sourcePayloads.map(payload => payload.datasetVersionId);
  if (new Set(ids).size !== ids.length || new Set(references).size !== references.length
    || new Set(payloadIds).size !== payloadIds.length || ids.length !== references.length || ids.length !== payloadIds.length
    || ids.some(id => !references.includes(id) || !payloadIds.includes(id))) throw new Error('FROZEN_DATASET_VERSION_MISMATCH');
  if (canonicalHash(snapshot.payload) !== snapshot.payloadHash) throw new Error('FROZEN_INPUT_HASH_MISMATCH');
}

export function toAgentToolEnvelope(legacy: ResearchToolResult, input: {
  invocationId: string; observedAt: string; completedAt: string; dataAsOf: string | null;
}): AgentToolResultEnvelope {
  return { ...legacy, envelopeVersion: 1, invocationId: input.invocationId,
    datasetVersionId: null, artifactRefs: [], timing: { observedAt: input.observedAt, completedAt: input.completedAt },
    provenance: { dataAsOf: input.dataAsOf, dataAsOfBasis: null, sourceVersions: [] }, usage: null,
    coverage: { status: legacy.status === 'partial' || legacy.truncated ? 'partial' : 'unknown',
      totalRows: null, returnedRows: 0, sampleSize: 0, missing: [] } };
}
