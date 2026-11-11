import http from './http';
import type { AgentToolConnection, AgentToolDescriptor, AgentDataClass } from '@shared/agent-tooling.interface';

export interface ToolConnectionView extends AgentToolConnection { endpoint: string | null; hasCredential: boolean; toolEffects: Record<string, string>; authKind: 'none' | 'bearer' | 'oauth' }
export interface ToolCatalogView { id: string; schemaHash: string; descriptors: AgentToolDescriptor[]; connectionRevision: number }
export interface ToolCatalogReviewView { active: ToolCatalogView | null; candidate: ToolCatalogView | null;
  changes: { added: string[]; removed: string[]; changed: string[] } }
export interface CreateToolConnection {
  provider: string; endpoint?: string; credential?: string;
  oauth?: { clientId: string; authorizationUrl: string; tokenUrl: string; scopes: string[] };
  providerConfig?: { authConfigId?: string; connectedAccountId?: string; toolVersions?: Record<string, string> };
}
export interface ToolActionView {
  id: string; runId: string; revision: number; payloadHash: string; state: string; expiresAt: string;
  accountId: string; target: string; args: Record<string, unknown>; descriptor: AgentToolDescriptor;
  attachments: Array<{ artifactId: string; sha256: string }>;
  costLimit: { maxCalls: number; maxAmount: string | null; currency: string | null };
  receipt: { state: 'completed' | 'failed' | 'unknown'; code?: string; remoteId?: string } | null;
}
const BASE = '/api/tool-connections';
export async function listToolConnections() { return (await http.get<ToolConnectionView[]>(BASE)).data; }
export async function createToolConnection(body: CreateToolConnection) { return (await http.post<ToolConnectionView>(BASE, body)).data; }
/** Saving is durable even if the subsequent metadata check fails; never create a duplicate on discovery failure. */
export async function saveToolConnectionWithDiscovery(body: CreateToolConnection) {
  const connection = await createToolConnection(body);
  return discoverSavedToolConnection(connection);
}
export async function discoverSavedToolConnection(connection: ToolConnectionView) {
  if (connection.status !== 'configured') return { connection, catalog: null, discoveryError: null };
  try {
    const discovered = await discoverToolConnection(connection.id);
    return { ...discovered, discoveryError: null };
  } catch (error) {
    return { connection, catalog: null, discoveryError: toolRequestError(error) };
  }
}
export async function prepareAuthorizedToolConnection(id: string) {
  const connection = (await http.get<ToolConnectionView>(`${BASE}/${encodeURIComponent(id)}`)).data;
  return discoverSavedToolConnection(connection);
}
export async function getToolCatalog(id: string) { return (await http.get<ToolCatalogView | null>(`${BASE}/${id}/catalog`)).data; }
export async function getToolCatalogReview(id: string) { return (await http.get<ToolCatalogReviewView>(`${BASE}/${id}/catalogs`)).data; }
export async function discoverToolConnection(id: string) { return (await http.post<{ connection: ToolConnectionView; catalog: ToolCatalogView }>(`${BASE}/${id}/discover`)).data; }
export async function enableToolConnection(id: string, body: { revision: number; catalogVersionId: string; schemaHash: string;
  toolIds: string[]; dataClasses: AgentDataClass[]; effects?: Record<string, string> }) {
  return (await http.post<ToolConnectionView>(`${BASE}/${id}/enable`, body)).data;
}
export async function updateToolCredential(id: string, body: { revision: number; credential: string }) { return (await http.put<ToolConnectionView>(`${BASE}/${id}/credential`, body)).data; }
export async function disconnectToolConnection(id: string) { return (await http.delete<ToolConnectionView>(`${BASE}/${id}`)).data; }
export async function authorizeToolApp(id: string) { return (await http.post<{ authorizationUrl: string }>(`${BASE}/${id}/composio/authorize`)).data; }
export async function completeToolApp(id: string, sessionUri: string) { return (await http.post<ToolConnectionView>(`${BASE}/${id}/composio/complete`, { sessionUri })).data; }
export async function authorizeToolOAuth(id: string) { return (await http.post<{ authorizationUrl: string }>(`${BASE}/${id}/oauth`)).data; }
export async function completeToolOAuth(state: string, code: string) { return (await http.post<{ connectionId: string; authorized: boolean }>(`${BASE}/oauth/callback`, { state, code })).data; }
export async function listToolActions(runId?: string) { return (await http.get<ToolActionView[]>('/api/tool-actions', { params: runId ? { runId } : undefined })).data; }
export async function confirmToolAction(action: ToolActionView) { return (await http.post<ToolActionView>(`/api/tool-actions/${action.id}/confirm`, { revision: action.revision, payloadHash: action.payloadHash })).data; }
export async function rejectToolAction(id: string) { return (await http.post<ToolActionView>(`/api/tool-actions/${id}/reject`)).data; }
export async function editToolAction(action: ToolActionView, body: { args: Record<string, unknown>; accountId: string; target: string }) {
  return (await http.put<ToolActionView>(`/api/tool-actions/${action.id}/preview`, { ...body, revision: action.revision, payloadHash: action.payloadHash })).data;
}
export function toolRequestError(error: unknown): string {
  if (error && typeof error === 'object' && 'response' in error) {
    const response = error.response as { data?: { error?: { message?: string }; message?: string } };
    const message = response.data?.error?.message ?? response.data?.message;
    if (typeof message === 'string') return message;
  }
  return 'TOOL_CONNECTION_REQUEST_FAILED';
}

export interface ModelToolCapabilityView {
  connection_id: string; model: string; supported: boolean; enabled: boolean; run_id: string; verified_at: string;
}
export interface ModelToolProbeResult { runId: string; status: string; supported: boolean; enabled: boolean }
export async function listModelToolCapabilities() { return (await http.get<ModelToolCapabilityView[]>('/api/model-tool-capabilities')).data; }
export async function probeModelToolCapability(body: { requestKey: string; connectionId?: string; tier: 'fast' | 'slow'; enable: boolean }) {
  return (await http.post<ModelToolProbeResult>('/api/model-tool-capabilities/probe', body)).data;
}
export async function disableModelToolCapability(connectionId: string) { return (await http.post('/api/model-tool-capabilities/disable', { connectionId })).data; }
export type ResearchRuntimeDriver = 'controlled' | 'deep_agents';
export async function listResearchRuntimeDrivers() { return (await http.get<Array<{ connection_id: string; driver: ResearchRuntimeDriver }>>('/api/model-tool-capabilities/drivers')).data; }
export async function setResearchRuntimeDriver(connectionId: string, driver: ResearchRuntimeDriver) {
  return (await http.post('/api/model-tool-capabilities/driver', { connectionId, driver })).data;
}
