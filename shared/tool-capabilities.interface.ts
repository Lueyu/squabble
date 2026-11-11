import type { AgentDataClass } from './agent-tooling.interface';

export const TOOL_CAPABILITY_PACK_IDS = ['documents', 'market_data', 'browser', 'compute'] as const;
export type ToolCapabilityPackId = typeof TOOL_CAPABILITY_PACK_IDS[number];
export interface ToolCapabilityView {
  packId: ToolCapabilityPackId;
  manifestVersion: string;
  manifestHash: string;
  installation: 'starting' | 'ready' | 'unavailable';
  catalog: 'verified' | 'changed' | 'unavailable';
  grant: 'disabled' | 'enabled' | 'review_required';
  revision: number;
  dataClasses: AgentDataClass[];
  connectionId: string | null;
  catalogVersionId?: string | null;
  schemaHash?: string | null;
  checkedAt: string | null;
  reasonCode: string | null;
  ready: boolean;
  /** These are deployment facts, never credentials or a successful business-tool test. */
  facts: Record<string, string | number | boolean | null>;
}
export interface ToolCapabilityActivation {
  grants: Array<{ packId: ToolCapabilityPackId; revision: number; manifestHash: string; dataClasses: AgentDataClass[];
    catalogVersionId?: string | null; schemaHash?: string | null }>;
  publicNetwork: boolean;
}
export interface ToolCapabilityGrantSnapshot { revision: number; dataClasses: AgentDataClass[] }
