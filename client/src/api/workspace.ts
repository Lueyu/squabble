import http from './http';
import type { DailyWorkspaceView, OverallDailyResearchView } from '@shared/daily-workspace.interface';
import type { ResearchMemoryInventory } from '@shared/research-memory.interface';

export async function fetchDailyWorkspace(date?: string): Promise<DailyWorkspaceView> {
  return (await http.get<DailyWorkspaceView>('/api/daily-workspace', { params: { date } })).data;
}
export async function fetchMemoryInventory(offset = 0): Promise<ResearchMemoryInventory> {
  return (await http.get<ResearchMemoryInventory>('/api/research-memory/inventory', { params: { offset, limit: 24 } })).data;
}
export async function fetchOverallDailyResearch(date: string): Promise<OverallDailyResearchView> {
  return (await http.get<OverallDailyResearchView>('/api/daily-workspace/research', { params: { date } })).data;
}
export async function startOverallDailyResearch(input: { date: string; requestKey: string }): Promise<OverallDailyResearchView> {
  return (await http.post<OverallDailyResearchView>('/api/daily-workspace/research', input)).data;
}
