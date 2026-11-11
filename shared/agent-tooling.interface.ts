import type { ResearchToolResult } from './research-tools.interface';

export const AGENT_TOOL_EFFECTS = ['read', 'compute', 'external_write'] as const;
export type AgentToolEffect = (typeof AGENT_TOOL_EFFECTS)[number];
export const AGENT_DATA_CLASSES = ['public', 'private_material', 'portfolio', 'application'] as const;
export type AgentDataClass = (typeof AGENT_DATA_CLASSES)[number];
export type AgentJsonValue = null | boolean | number | string | AgentJsonValue[] | { [key: string]: AgentJsonValue };
export type AgentConnectionStatus = 'unconfigured' | 'configured' | 'authorization_required'
  | 'discovered' | 'restricted' | 'unavailable' | 'reconfirmation_required';

/** A public projection; credentials and owner identity are injected by the server. */
export interface AgentToolConnection {
  id: string;
  provider: string;
  transport: 'streamable_http' | 'stdio' | 'adapter';
  revision: number;
  status: AgentConnectionStatus;
  allowedToolIds: string[];
  allowedDataClasses: AgentDataClass[];
  catalogVersionId: string | null;
  verifiedAt: string | null;
  candidateCatalogVersionId?: string | null;
  managedPresetId?: string | null;
  lastDiscoveryAt?: string | null;
  lastDiscoveryCode?: string | null;
}

/** Effect classification is trusted adapter policy, never a remote readOnly hint. */
export interface AgentToolDescriptor {
  id: string;
  connectionId: string | null;
  catalogVersionId: string;
  schemaHash: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  effect: AgentToolEffect;
  dataClasses: AgentDataClass[];
  timeoutMs: number;
  maxOutputBytes: number;
  supportsCancellation: boolean;
  supportsStatusLookup: boolean;
  remoteIdempotency: 'supported' | 'unsupported' | 'unknown';
}

export interface AgentToolCatalogSnapshot {
  catalogVersionId: string;
  schemaHash: string;
  connectionRevisions: Record<string, number>;
  descriptors: AgentToolDescriptor[];
  /** Model-facing aliases are frozen with the catalog, including collisions. */
  aliases: Record<string, string>;
}

export interface AgentSourceVersionRef {
  sourceId: string;
  sourceVersionId: string;
  contentHash: string;
}

export interface AgentToolScope {
  owner: string;
  runId: string;
  sessionId: string;
  revision: number;
  leaseToken: string;
  allowedInstrumentIds: string[];
  allowedAccountIds: string[];
  allowedDataClasses: AgentDataClass[];
  sourceVersions: AgentSourceVersionRef[];
  permissionRevision: number;
}

export interface AgentToolUsage {
  quantity: string | null;
  unit: 'calls' | 'credits' | 'seconds' | 'pages' | 'tokens' | 'bytes';
  amount: string | null;
  currency: string | null;
  known: boolean;
  priceVersionId: string | null;
}

export interface AgentResultCoverage {
  status: 'complete' | 'partial' | 'unknown';
  totalRows: number | null;
  returnedRows: number;
  sampleSize: number;
  missing: string[];
}

/** Legacy asOf remains readable; business time must come from provenance. */
export interface AgentToolResultEnvelope extends ResearchToolResult {
  envelopeVersion: 1;
  invocationId: string;
  datasetVersionId: string | null;
  artifactRefs: Array<{ artifactId: string; sha256: string }>;
  timing: { observedAt: string; completedAt: string };
  provenance: {
    dataAsOf: string | null;
    dataAsOfBasis: string | null;
    sourceVersions: AgentSourceVersionRef[];
  };
  usage: AgentToolUsage[] | null;
  coverage: AgentResultCoverage;
}

export interface AgentToolErrorResult {
  toolCallId: string;
  toolId: string | null;
  status: 'failed';
  error: {
    code: 'INVALID_JSON_ACTION' | 'INVALID_ACTION_SCHEMA' | 'UNKNOWN_TOOL'
      | 'INVALID_TOOL_ARGUMENTS' | 'DUPLICATE_TOOL_CALL' | 'TOOL_CALL_LIMIT';
    message: string;
    retryable: false;
  };
}
