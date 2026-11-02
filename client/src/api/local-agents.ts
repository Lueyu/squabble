import type { LocalAgentConnection, LocalAgentPairing, LocalAgentsStatus } from '@shared/local-agents.interface';
import http from './http';

export type { LocalAgentConnection } from '@shared/local-agents.interface';

const BASE_URL = '/api/settings/local-agents';

export async function fetchLocalAgents(): Promise<LocalAgentConnection[]> {
  const response = await http.get<{ items: LocalAgentConnection[] }>(BASE_URL);
  return response.data.items;
}

export async function fetchLocalAgentsStatus(): Promise<LocalAgentsStatus> {
  const response = await http.get<LocalAgentsStatus>(`${BASE_URL}/status`);
  return response.data;
}

export async function connectLocalAgent(id: string): Promise<{ ok: true }> {
  const response = await http.post<{ ok: true }>(`${BASE_URL}/${encodeURIComponent(id)}/connect`);
  return response.data;
}

export async function disconnectLocalAgent(id: string): Promise<{ ok: true }> {
  const response = await http.post<{ ok: true }>(`${BASE_URL}/${encodeURIComponent(id)}/disconnect`);
  return response.data;
}

export async function loginLocalAgent(id: string): Promise<{ ok: true }> {
  const response = await http.post<{ ok: true }>(`${BASE_URL}/${encodeURIComponent(id)}/login`);
  return response.data;
}

export async function createLocalAgentPairing(): Promise<LocalAgentPairing> {
  const response = await http.post<LocalAgentPairing>(`${BASE_URL}/pairing`);
  return response.data;
}

export async function disconnectLocalCompanion(): Promise<{ ok: true }> {
  const response = await http.delete<{ ok: true }>(`${BASE_URL}/companion`);
  return response.data;
}
