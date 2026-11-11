import http from './http';
import type { DeleteResearchConversationInput, ResearchDeletionResult } from '@shared/research-deletion.interface';

export const deleteResearchConversation = async (id: string, input: DeleteResearchConversationInput): Promise<ResearchDeletionResult> =>
  (await http.post<ResearchDeletionResult>(`/api/research-conversations/${encodeURIComponent(id)}/delete`, input)).data;
import type { CreateResearchConversationInput, ResearchConversationMessageInput, ResearchConversationView, ResearchConversationResult, ResumeDailyReportInput } from '@shared/simple-conversation.interface';
import type { ResearchExecutionReadiness, ResearchRecoveryInput } from '@shared/research-execution.interface';
import type { NativeAgentConfiguration } from '@shared/local-agents.interface';
import type { ResearchSkillDescriptor } from '@shared/research-skills.interface';

export const fetchResearchSkills = async (): Promise<ResearchSkillDescriptor[]> =>
  (await http.get<{ items: ResearchSkillDescriptor[] }>('/api/research-conversations/skills')).data.items;

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
export const recoverResearchRuntime = async (id: string, input: import('@shared/research-runtime.interface').CouncilRuntimeRecoveryInput): Promise<ResearchConversationView> =>
  (await http.post(`/api/research-conversations/${encodeURIComponent(id)}/runtime-recovery`, input)).data;
export const resumeDailyReport = async (id: string, input: ResumeDailyReportInput): Promise<ResearchConversationView> =>
  (await http.post(`/api/research-conversations/${encodeURIComponent(id)}/resume-report`, input)).data;
export const fetchOriginalResearchResult = async (id: string, memberId: string): Promise<{ text: string; verified: false; resultAcceptance: string }> =>
  (await http.get(`/api/research-conversations/${encodeURIComponent(id)}/members/${encodeURIComponent(memberId)}/result`)).data;
export const stopResearchConversation = async (id: string): Promise<ResearchConversationView> =>
  (await http.post(`/api/research-conversations/${encodeURIComponent(id)}/stop`)).data;
export const fetchResearchExecutionReadiness = async (): Promise<ResearchExecutionReadiness[]> =>
  (await http.get<{ items: ResearchExecutionReadiness[] }>('/api/research-execution/readiness')).data.items;
export const configureResearchExecution = async (connectionId: string, input: NativeAgentConfiguration): Promise<ResearchExecutionReadiness[]> =>
  (await http.put<{ items: ResearchExecutionReadiness[] }>(`/api/research-execution/${encodeURIComponent(connectionId)}/configuration`, input)).data.items;
