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
  sessionId: string; revision: number; memberId: string; memberName: string; turn: number;
  ticker: string; language: 'en' | 'zh-CN'; webResearch: boolean; expiresAt: number;
}
/** Safe fallback context and descriptors. No bearer token or arbitrary server URL. */
export interface ResearchToolBundle { descriptors: ResearchToolDescriptor[]; snapshot: string }
export interface ResearchToolCapability {
  mode: 'mcp' | 'snapshot'; reason: 'supported' | 'version_unsupported' | 'runtime_unsupported';
}
