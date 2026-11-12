import http from './http';
import type { AgentProfile, AgentRosterPage, AgentTemplate, CreateAgentInput, UpdateAgentInput, AddRecommendedAgentsInput, ArchiveAgentInput, AgentMemory, AgentMemoryScope, WriteAgentMemoryInput, ShareAgentMemoryInput } from '@shared/agent-roster.interface';

const base = '/api/agent-roster';
const path = (id: string) => `${base}/${encodeURIComponent(id)}`;
export const agentRosterApi = {
  list: async () => { const data = (await http.get<AgentRosterPage>(base)).data; if (!data || !Array.isArray(data.items)) throw new Error('Invalid agent roster response'); return data; },
  templates: async () => (await http.get<{ items: AgentTemplate[] }>(`${base}/templates`)).data.items,
  detail: async (id: string) => (await http.get<AgentProfile>(path(id))).data,
  create: async (input: CreateAgentInput) => (await http.post<AgentProfile>(base, input)).data,
  recommended: async (input: AddRecommendedAgentsInput) => (await http.post<{ items: AgentProfile[] }>(`${base}/recommended`, input)).data,
  update: async (id: string, input: UpdateAgentInput) => (await http.patch<AgentProfile>(path(id), input)).data,
  archive: async (id: string, input: ArchiveAgentInput) => (await http.post<AgentProfile>(`${path(id)}/archive`, input)).data,
  memories: async (id: string, scope: AgentMemoryScope) => (await http.get<{ items: AgentMemory[] }>(`${path(id)}/memories`, { params: { scope: scope.kind, scopeId: scope.kind === 'team' ? scope.teamId : scope.kind === 'conversation' ? scope.conversationId : undefined } })).data,
  remember: async (id: string, input: WriteAgentMemoryInput) => (await http.post<AgentMemory>(`${path(id)}/memories`, input)).data,
  share: async (id: string, memoryId: string, input: ShareAgentMemoryInput) => (await http.post<AgentMemory>(`${path(id)}/memories/${encodeURIComponent(memoryId)}/share`, input)).data,
};
