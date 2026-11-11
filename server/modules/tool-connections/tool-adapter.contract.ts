import type { AgentToolDescriptor, AgentToolUsage } from '../../../shared/agent-tooling.interface';

export interface ToolAdapterConnection {
  id: string; provider: string; endpoint: string | null; secret: string | null;
  externalUserId?: string;
  config?: { connectedAccountId?: string; authConfigId?: string; toolVersions?: Record<string, string> };
}
export interface ToolRemoteReceipt {
  provider: string; state: 'completed' | 'running' | 'cancelled' | 'unknown'; remoteJobId?: string;
}
export interface ToolAdapterContext {
  invocationId: string; signal?: AbortSignal;
  beforeDispatch?: () => Promise<void>;
  onReceipt?: (receipt: ToolRemoteReceipt) => Promise<void>;
}
export interface ToolAdapterResult {
  output: unknown; receipt: ToolRemoteReceipt; usage: AgentToolUsage[] | null;
  observedAt: string; dataAsOf: string | null;
}
export interface TrustedToolAdapter {
  provider: string;
  discover(connection: ToolAdapterConnection): Promise<AgentToolDescriptor[]>;
  invoke(connection: ToolAdapterConnection, tool: AgentToolDescriptor,
    args: Record<string, unknown>, context: ToolAdapterContext): Promise<ToolAdapterResult>;
}

/** Stable codes only: upstream bodies and URLs may contain credentials or private arguments. */
export class ToolAdapterError extends Error {
  constructor(readonly code: string, readonly dispatched = false) { super(code); }
}
