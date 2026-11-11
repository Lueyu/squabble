import type { ResearchActivity } from './research-events.interface';
import type { ResearchToolBundle, ResearchToolCapability } from './research-tools.interface';
import type { NativeAgentImage } from './native-image.interface';
import type { NativeDiagnosticEvent } from './local-agent-diagnostics.interface';
import type { SafeFailure } from './research-execution.interface';
/** Native runtimes are selected from a fixed catalog; clients never supply executable paths. */
export const LOCAL_AGENT_PROVIDERS = ['codex', 'claude', 'gemini', 'antigravity', 'opencode', 'kimi', 'doubao'] as const;
export type LocalAgentProvider = typeof LOCAL_AGENT_PROVIDERS[number];
export type LocalAgentActivityCapability = 'tools' | 'starts_only' | 'phases' | 'none';
export interface NativeAgentConfiguration { model?: string; reasoningEffort?: string }
export interface NativeAgentModel { id: string; name: string; reasoningEfforts?: string[] }
export type NativeAgentState = 'not_installed' | 'login_required' | 'ready' | 'error';
export interface NativeAgentStatus {
  /** Read-only configured native default, when discoverable without a model request. */
  defaultModel?: string;
  imageInput?: boolean;
  researchTools?: ResearchToolCapability;
  provider: LocalAgentProvider;
  name: string;
  state: NativeAgentState;
  version?: string;
  loginCommand: string;
  installUrl: string;
  models?: NativeAgentModel[];
  reasoningEfforts?: string[];
  configurationHelp?: string;
}
export interface LocalAgentConnection extends NativeAgentStatus {
  id: string;
  connected: boolean;
  available: boolean;
  busy: boolean;
  source: 'native' | 'companion';
}
export interface LocalAgentsStatus {
  mode: 'native' | 'companion';
  items: LocalAgentConnection[];
  companion: { connected: boolean; name?: string };
}
export interface LocalAgentPairing { code: string; expiresAt: string }
export interface CompanionCommand {
  image?: NativeAgentImage;
  hasImage?: boolean;
  researchTools?: ResearchToolBundle;
  id: string;
  kind: 'run' | 'login';
  provider: LocalAgentProvider;
  prompt?: string;
  agentSettings?: NativeAgentConfiguration;
}
export interface CompanionUpdate {
  events?: ResearchActivity[];
  diagnostics?: NativeDiagnosticEvent[];
  diagnosticsTruncated?: boolean;
  eventsTruncated?: boolean;
  failure?: SafeFailure;
  activityCapability?: LocalAgentActivityCapability;
  id: string;
  state: 'running' | 'completed' | 'failed' | 'cancelled';
  progress?: string;
  text?: string;
  usageTokens?: number | null;
  error?: CompanionFailureCode;
}
export const COMPANION_FAILURE_CODES = ['LOCAL_INVALID_CONFIGURATION', 'LOCAL_CONFIGURATION_UNSUPPORTED', 'LOCAL_VERSION_UNSUPPORTED',
  'LOCAL_LOGIN_REQUIRED', 'LOCAL_DISPATCH_UNCERTAIN', 'LOCAL_TOOL_ISOLATION_FAILED', 'LOCAL_USAGE_LIMIT', 'LOCAL_RATE_LIMIT',
  'LOCAL_IMAGE_UNSUPPORTED', 'LOCAL_INVALID_INPUT', 'LOCAL_TIMEOUT', 'LOCAL_OUTPUT_LIMIT', 'LOCAL_LAUNCH_FAILED',
  'LOCAL_PROTOCOL_INCOMPLETE', 'LOCAL_NETWORK_UNAVAILABLE', 'LOCAL_TASK_FAILED', 'LOCAL_INVALID_RESULT', 'LOCAL_CANCELLED',
  'LOCAL_PAUSED', 'LOCAL_INTERRUPTED', 'LOCAL_UNAVAILABLE', 'MEMORY_CONTEXT_CHANGED'] as const;
export type CompanionFailureCode = typeof COMPANION_FAILURE_CODES[number];
export interface CompanionPoll {
  agents: NativeAgentStatus[];
  updates: CompanionUpdate[];
}
export interface CompanionPollResult { commands: CompanionCommand[]; cancelTaskIds: string[] }
