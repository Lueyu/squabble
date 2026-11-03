import http from './http';
import type { CouncilSession, CreateCouncilSession, LlmBudgetSettings, LlmBudgetUsage } from '@shared/council.interface';

export async function fetchCouncilSessions(): Promise<CouncilSession[]> {
  const response = await http.get<{ items: CouncilSession[] }>('/api/council/sessions');
  return response.data.items;
}

export async function fetchCouncilSession(id: string): Promise<CouncilSession> {
  const response = await http.get<CouncilSession>(`/api/council/sessions/${encodeURIComponent(id)}`);
  return response.data;
}

export async function createCouncilSession(request: CreateCouncilSession): Promise<CouncilSession> {
  const response = await http.post<CouncilSession>('/api/council/sessions', request);
  return response.data;
}

export async function postCouncilMessage(id: string, content: string): Promise<CouncilSession> {
  const response = await http.post<CouncilSession>(
    `/api/council/sessions/${encodeURIComponent(id)}/messages`, { content },
  );
  return response.data;
}

export async function runCouncilSession(id: string): Promise<CouncilSession> {
  const response = await http.post<CouncilSession>(`/api/council/sessions/${encodeURIComponent(id)}/run`);
  return response.data;
}

export async function pauseCouncilSession(id: string): Promise<CouncilSession> {
  const response = await http.post<CouncilSession>(`/api/council/sessions/${encodeURIComponent(id)}/pause`);
  return response.data;
}
export async function retryCouncilTask(id: string, taskId: string): Promise<CouncilSession> {
  return (await http.post<CouncilSession>(`/api/council/sessions/${encodeURIComponent(id)}/tasks/${encodeURIComponent(taskId)}/retry`)).data;
}

export async function fetchLlmBudget(): Promise<LlmBudgetSettings> {
  const response = await http.get<LlmBudgetSettings>('/api/llm-budget');
  return response.data;
}

export async function fetchLlmBudgetUsage(): Promise<LlmBudgetUsage> {
  const response = await http.get<LlmBudgetUsage>('/api/llm-budget/usage');
  return response.data;
}

export async function saveLlmBudget(settings: LlmBudgetSettings): Promise<LlmBudgetSettings> {
  const response = await http.put<LlmBudgetSettings>('/api/llm-budget', settings);
  return response.data;
}
