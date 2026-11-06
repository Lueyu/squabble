import http from './http';
import type { CreateResearchConversationInput, ResearchConversationMessageInput, ResearchConversationView, ResearchConversationResult } from '@shared/simple-conversation.interface';
import type { ResearchExecutionReadiness, ResearchRecoveryInput } from '@shared/research-execution.interface';
import type { NativeAgentConfiguration } from '@shared/local-agents.interface';

export const fetchResearchConversations = async (): Promise<ResearchConversationView[]> => {
  const data = (await http.get('/api/research-conversations')).data;
  return Array.isArray(data) ? data : data.items;
};
export const fetchResearchConversation = async (id: string): Promise<ResearchConversationView> =>
  (await http.get(`/api/research-conversations/${encodeURIComponent(id)}`)).data;
export const createResearchConversation = async (input: CreateResearchConversationInput): Promise<ResearchConversationResult> =>
  (await http.post('/api/research-conversations', input)).data;
export const postResearchConversationMessage = async (id: string, input: ResearchConversationMessageInput): Promise<ResearchConversationView> =>
  (await http.post(`/api/research-conversations/${encodeURIComponent(id)}/messages`, input)).data;
export const renameResearchConversation = async (id: string, input: { title: string; requestKey: string }): Promise<ResearchConversationView> =>
  (await http.patch(`/api/research-conversations/${encodeURIComponent(id)}`, input)).data;
export const recoverResearchConversation = async (id: string, input: ResearchRecoveryInput): Promise<ResearchConversationView> =>
  (await http.post(`/api/research-conversations/${encodeURIComponent(id)}/recovery`, input)).data;
export const fetchOriginalResearchResult = async (id: string, memberId: string): Promise<{ text: string; verified: false; resultAcceptance: string }> =>
  (await http.get(`/api/research-conversations/${encodeURIComponent(id)}/members/${encodeURIComponent(memberId)}/result`)).data;
export const stopResearchConversation = async (id: string): Promise<ResearchConversationView> =>
  (await http.post(`/api/research-conversations/${encodeURIComponent(id)}/stop`)).data;
export const fetchResearchExecutionReadiness = async (): Promise<ResearchExecutionReadiness[]> =>
  (await http.get<{ items: ResearchExecutionReadiness[] }>('/api/research-execution/readiness')).data.items;
export const configureResearchExecution = async (connectionId: string, input: NativeAgentConfiguration): Promise<ResearchExecutionReadiness[]> =>
  (await http.put<{ items: ResearchExecutionReadiness[] }>(`/api/research-execution/${encodeURIComponent(connectionId)}/configuration`, input)).data.items;
