import http from './http';
import type { CreateResearchConversationInput, ResearchConversationMessageInput, ResearchConversationView, ResearchConversationResult } from '@shared/simple-conversation.interface';

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
