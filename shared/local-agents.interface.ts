/** Native runtimes are selected from a fixed catalog; clients never supply executable paths. */
export const LOCAL_AGENT_PROVIDERS = ['codex', 'claude'] as const;
export type LocalAgentProvider = typeof LOCAL_AGENT_PROVIDERS[number];
export type NativeAgentState = 'not_installed' | 'login_required' | 'ready' | 'error';
export interface NativeAgentStatus {
  provider: LocalAgentProvider;
  name: string;
  state: NativeAgentState;
  version?: string;
  loginCommand: string;
  installUrl: string;
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
  id: string;
  kind: 'run' | 'login';
  provider: LocalAgentProvider;
  prompt?: string;
}
export interface CompanionUpdate {
  id: string;
  state: 'running' | 'completed' | 'failed' | 'cancelled';
  progress?: string;
  text?: string;
  usageTokens?: number | null;
}
export interface CompanionPoll {
  agents: NativeAgentStatus[];
  updates: CompanionUpdate[];
}
export interface CompanionPollResult { commands: CompanionCommand[]; cancelTaskIds: string[] }
