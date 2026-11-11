import type { ModelRoute } from './model-route.interface';
import type { NativeAgentConfiguration, NativeAgentModel } from './local-agents.interface';
export type ResultAcceptance = 'pending' | 'accepted' | 'rejected';
export type RecoveryAction = 'check_existing' | 'reparse_existing' | 'retry_member' | 'fix_configuration';
export type FailureStage = 'preflight' | 'dispatch' | 'runtime' | 'parse';
/** Allowlisted diagnostics only: never stderr, prompts, credentials or portfolio contents. */
export interface SafeFailure { code: string; stage: FailureStage; fieldPath?: string; expectedType?: string; actualType?: string;
  exitCode?: number; outputBytes?: number; stderrBytes?: number; terminalEvent?: boolean; recoveries: RecoveryAction[] }
export interface ResearchExecutionReadiness { connectionId: string; provider: string; name: string; connected: boolean; busy: boolean;
  configuration?: NativeAgentConfiguration; models?: NativeAgentModel[]; reasoningEfforts?: string[];
  state: 'not_connected' | 'login_required' | 'configuration_required' | 'busy' | 'ready' | 'unknown'; executable: boolean;
  effectiveModel: { id?: string; provider?: string; source: 'override' | 'default' | 'unknown'; verified: boolean };
  route?: ModelRoute; failure?: SafeFailure }
export interface ResearchMemberState { memberId: string; attempt: number; taskId?: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown' | 'skipped';
  resultAcceptance: ResultAcceptance; failure?: SafeFailure; startedAt?: string; lastActivityAt: string; completedAt?: string;
  recoveries: RecoveryAction[] }
export interface ResearchRecoveryInput { memberId: string; action: RecoveryAction; requestKey: string; expectedRevision: number;
  runtimeTarget?: import('./research-runtime.interface').RuntimeRecoveryTarget }
/** Activity identity is independent of whether this task may access security tools. */
export interface ResearchTaskActivityContext { sessionId: string; revision: number; memberId: string; memberName: string; turn: number;
  language: string; attempt?: number; cycleId?: string }
