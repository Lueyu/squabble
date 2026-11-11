import type { ResearchEventStatus } from './research-events.interface';
import type { SafeFailure, ResultAcceptance } from './research-execution.interface';
import type { LocalAgentProvider } from './local-agents.interface';

export type TelemetryDiagnosticStage = 'queue' | 'preflight' | 'dispatch' | 'execution' | 'result' | 'acceptance' | 'publication';
export interface TelemetryDiagnosticEvent {
  id: string;
  taskId: string;
  sequence: number;
  kind: 'stage' | 'tool' | 'summary' | 'capability' | 'acceptance';
  stage: TelemetryDiagnosticStage;
  status: ResearchEventStatus;
  at: string;
  summary: string;
  toolName?: string;
  callId?: string;
  durationMs?: number;
  code?: string;
  exitCode?: number;
  outputBytes?: number;
  stderrBytes?: number;
  terminalEvent?: boolean;
}
export interface TelemetryTaskDiagnostic {
  taskId: string;
  memberId: string | null;
  memberName: string;
  /** A missing retained journal cannot establish provider or transport identity. */
  provider: LocalAgentProvider | null;
  transport: 'native' | 'companion' | null;
  retained: boolean;
  attempt: number;
  state: 'staged' | 'queued' | 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled' | 'unknown';
  configuredModel: string | null;
  observedModel: string | null;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string | null;
  /** Owner/task-device Companion bridge heartbeat only; not task progress or subprocess liveness. */
  heartbeatAt: string | null;
  processState: 'not_observed' | 'running' | 'exited' | 'unknown';
  acceptance: ResultAcceptance | null;
  failure: SafeFailure | null;
  activityCapability: 'tools' | 'starts_only' | 'phases' | 'none';
  modelRequestsVisible: false;
  eventsTruncated: boolean;
  events: TelemetryDiagnosticEvent[];
}
export interface TelemetryDiagnostics {
  generatedAt: string;
  tasks: TelemetryTaskDiagnostic[];
  coverage: 'available' | 'partial' | 'unavailable';
  /** Only an explicit persisted publication outcome establishes success or failure. */
  publication: 'published' | 'failed' | 'pending' | 'unknown';
  /** Opaque snapshot revision; reconnecting clients always revalidate source visibility. */
  cursor: string;
}
