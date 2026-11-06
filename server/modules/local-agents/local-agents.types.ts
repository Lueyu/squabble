import type { NativeAgentConfiguration } from '../../../shared/local-agents.interface';
import type { ResearchToolScope } from '../../../shared/research-tools.interface';
import type { NativeAgentImage } from '../../../shared/native-image.interface';

export interface LocalAgentTaskRef { taskId: string; contextId: string }
/** Validation may fence the local handoff, but must never await remote execution. */
export type LocalAgentHandoff = (handoff: () => Promise<void>) => Promise<void>;
export interface LocalAgentExecution {
  activityContext?: import('../../../shared/research-execution.interface').ResearchTaskActivityContext;
  image?: NativeAgentImage;
  /** Transient cancellation for screenshot dispatch; never serialized with the task. */
  signal?: AbortSignal;
  researchScope?: ResearchToolScope;
  agentId: string;
  messageId: string;
  prompt: string;
  agentSettings?: NativeAgentConfiguration;
  remoteTaskId?: string;
  contextId?: string;
  resumeInput?: boolean;
  onDispatch?(submission?: { inputBytes: number }): Promise<void>;
  withHandoff?: LocalAgentHandoff;
  /** Queue acceptance alone is not delivery. Companion receipt means emitted command, not private model use. */
  onSubmitted?(delivery: 'runtime' | 'companion-command'): Promise<void>;
  onTask(ref: LocalAgentTaskRef): Promise<void>;
  onProgress(text: string): Promise<void>;
  shouldContinue(): Promise<boolean>;
}
export interface LocalAgentResult {
  taskId?: string;
  contextId?: string;
  text: string;
  data?: unknown;
  usageTokens: number | null;
}
export class LocalAgentError extends Error {
  constructor(readonly code: string, readonly taskId?: string, readonly contextId?: string) {
    super(code);
    this.name = 'LocalAgentError';
  }
}

/** Publish only known runtime failures; CLI diagnostics can contain private data. */
export function nativeFailureCode(error: unknown): string {
  if (error instanceof LocalAgentError) return error.code;
  const codes: Record<string, string> = {
    NATIVE_AGENT_TIMEOUT: 'LOCAL_TIMEOUT',
    NATIVE_AGENT_OUTPUT_LIMIT: 'LOCAL_OUTPUT_LIMIT',
    NATIVE_AGENT_LAUNCH_FAILED: 'LOCAL_LAUNCH_FAILED',
    NATIVE_AGENT_INCOMPLETE: 'LOCAL_PROTOCOL_INCOMPLETE',
    NATIVE_AGENT_INVALID_IMAGE: 'LOCAL_INVALID_INPUT',
    NATIVE_AGENT_IMAGE_UNSUPPORTED: 'LOCAL_IMAGE_UNSUPPORTED',
    MEMORY_CONTEXT_CHANGED: 'MEMORY_CONTEXT_CHANGED',
    LOCAL_PAUSED: 'LOCAL_PAUSED',
    NATIVE_AGENT_LOGIN_REQUIRED: 'LOCAL_LOGIN_REQUIRED',
    NATIVE_AGENT_INVALID_CONFIGURATION: 'LOCAL_INVALID_CONFIGURATION',
    NATIVE_AGENT_CONFIGURATION_UNSUPPORTED: 'LOCAL_CONFIGURATION_UNSUPPORTED',
    NATIVE_AGENT_VERSION_UNSUPPORTED: 'LOCAL_VERSION_UNSUPPORTED',
    NATIVE_AGENT_CANCEL_UNCONFIRMED: 'LOCAL_DISPATCH_UNCERTAIN',
    NATIVE_AGENT_UPSTREAM_PENDING: 'LOCAL_DISPATCH_UNCERTAIN',
    NATIVE_AGENT_TOOL_ISOLATION_FAILED: 'LOCAL_TOOL_ISOLATION_FAILED',
    NATIVE_AGENT_USAGE_LIMIT: 'LOCAL_USAGE_LIMIT',
    NATIVE_AGENT_RATE_LIMIT: 'LOCAL_RATE_LIMIT',
  };
  return error instanceof Error ? codes[error.message] ?? 'LOCAL_TASK_FAILED' : 'LOCAL_TASK_FAILED';
}
