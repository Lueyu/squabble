import type { MemoryReference } from './research-memory.interface';
/** Task-bound read-only tools; never carry account credentials across this boundary. */
export interface ResearchSource { title: string; url?: string; fetchedAt: string }
export interface ResearchToolDescriptor {
  name: string; description: string; inputSchema: Record<string, unknown>; outputSchema?: Record<string, unknown>;
  annotations: { readOnlyHint: true; destructiveHint: false; openWorldHint: boolean };
}
export interface ResearchToolRequest { callId: string; name: string; arguments: Record<string, unknown> }
export interface ResearchToolCancelRequest { taskId: string; callId: string }
export interface ResearchToolResult {
  status: 'succeeded' | 'partial' | 'unavailable' | 'failed' | 'cancelled';
  data: unknown; sources: ResearchSource[]; asOf: string; truncated: boolean; errorCode?: string;
}
export interface ResearchToolScope {
  /** Server-owned durable member attempt, required for parallel simple research. */
  attemptId?: string;
  /** Server-owned allowlist for workflow prompt memory. Explicit [] forbids further memory; snapshots never duplicate it. */
  memoryReferences?: MemoryReference[];
  sessionId: string; revision: number; memberId: string; memberName: string; turn: number;
  ticker: string; language: 'en' | 'zh-CN'; webResearch: boolean; expiresAt: number;
}
/** Safe fallback context and descriptors. No bearer token or arbitrary server URL. */
export interface ResearchToolBundle { descriptors: ResearchToolDescriptor[]; snapshot: string }
export interface ResearchToolCapability {
  mode: 'mcp' | 'snapshot'; reason: 'supported' | 'version_unsupported' | 'runtime_unsupported';
}
export type ResearchValuationMetric = 'earnings' | 'revenue' | 'book_value';
export interface ResearchValuationRequest {
  metric: ResearchValuationMetric;
  multiples: { bear: number; base: number; bull: number };
}
export interface ResearchValuationInput {
  metric: ResearchValuationMetric; value: number; currency: string; units: 'currency';
  periodStart: string | null; periodEnd: string; annual: boolean; source: ResearchSource;
}
export interface ResearchValuationQuote { price: number; currency: string; asOf: string }
