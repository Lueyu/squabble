import type { ModelMessage } from 'ai';
import type { AgentToolCatalogSnapshot } from '../../../shared/agent-tooling.interface';
import type { RuntimeToolCall } from '../../../shared/research-runtime.interface';

/** Complete, credential-free request persisted and hashed before any transport. */
export interface ModelStepRequest {
  owner: string;
  connectionId: string;
  connectionRevision: number;
  /** Private fingerprint of endpoint, selected model configuration and credential. */
  connectionConfigHash?: string;
  model: string;
  messages: ModelMessage[];
  catalog: AgentToolCatalogSnapshot;
  maxOutputTokens?: number;
  timeoutMs?: number;
  /** Only an explicitly configured connection capability may select this protocol. */
  jsonActionMode?: boolean;
}
export interface ModelStepUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
}
export interface ModelStepResult {
  text: string;
  toolCalls: Array<RuntimeToolCall & { invalid?: boolean }>;
  finishReason: string;
  usage: ModelStepUsage | null;
  providerRequestId: string | null;
}
export interface ModelStepConnection { baseUrl: string; apiKey: string }
export interface ModelStepPort {
  generate(request: ModelStepRequest, signal?: AbortSignal): Promise<ModelStepResult>;
}
