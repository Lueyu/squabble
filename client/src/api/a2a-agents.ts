import http from './http';
import type { A2aConnection, A2aCreateConnection } from '@shared/a2a-agents.interface';
const base = '/api/a2a-agents';
export const a2aAgentsApi = {
  list: async () => (await http.get<{ items: A2aConnection[] }>(base)).data.items,
  create: async (input: A2aCreateConnection) => (await http.post<A2aConnection>(base, input)).data,
  refresh: async (id: string, input: { requestKey: string; expectedRevision: number }) => (await http.post<A2aConnection>(`${base}/${encodeURIComponent(id)}/refresh-card`, input)).data,
  disable: async (id: string, input: { requestKey: string; expectedRevision: number }) => (await http.post<A2aConnection>(`${base}/${encodeURIComponent(id)}/disable`, input)).data,
};
