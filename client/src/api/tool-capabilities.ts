import http from './http';
import type { ToolCapabilityActivation, ToolCapabilityPackId, ToolCapabilityView } from '@shared/tool-capabilities.interface';

const BASE = '/api/tool-capabilities';
export async function listToolCapabilities(): Promise<ToolCapabilityView[]> {
  return (await http.get<ToolCapabilityView[]>(BASE)).data;
}
export async function refreshToolCapabilities(): Promise<ToolCapabilityView[]> {
  return (await http.post<ToolCapabilityView[]>(`${BASE}/refresh`)).data;
}
export async function activateToolCapabilities(input: ToolCapabilityActivation): Promise<ToolCapabilityView[]> {
  return (await http.post<ToolCapabilityView[]>(`${BASE}/activate`, input)).data;
}
export async function revokeToolCapability(packId: ToolCapabilityPackId, revision: number): Promise<ToolCapabilityView[]> {
  return (await http.post<ToolCapabilityView[]>(`${BASE}/${encodeURIComponent(packId)}/revoke`, { revision })).data;
}
