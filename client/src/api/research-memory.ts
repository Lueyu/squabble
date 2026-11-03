import http from './http';
import type { ResearchMemoryItem, ResearchMemoryList, ResearchMemoryPreferences, ResearchMemoryQuery,
  ResearchThesis, ResearchThesisVersion, UpdateResearchThesis, ResearchMemoryRecall } from '@shared/research-memory.interface';

const root = '/api/research-memory';
export async function previewResearchMemory(query: ResearchMemoryQuery): Promise<ResearchMemoryRecall> {
  return (await http.get<ResearchMemoryRecall>(`${root}/recall`, { params: query })).data;
}
export async function fetchResearchMemory(query: ResearchMemoryQuery): Promise<ResearchMemoryList> {
  return (await http.get<ResearchMemoryList>(root, { params: query })).data;
}
export async function fetchResearchMemoryPreferences(): Promise<ResearchMemoryPreferences> {
  return (await http.get<ResearchMemoryPreferences>(`${root}/preferences`)).data;
}
export async function saveResearchMemoryPreferences(input: ResearchMemoryPreferences): Promise<ResearchMemoryPreferences> {
  return (await http.put<ResearchMemoryPreferences>(`${root}/preferences`, input)).data;
}
export async function updateResearchMemory(id: string, excluded: boolean): Promise<ResearchMemoryItem> {
  return (await http.patch<ResearchMemoryItem>(`${root}/memories/${encodeURIComponent(id)}`, { excluded })).data;
}
export async function deleteResearchMemory(id: string): Promise<void> {
  await http.delete(`${root}/memories/${encodeURIComponent(id)}`);
}
export async function updateResearchThesis(id: string, input: UpdateResearchThesis): Promise<ResearchThesis> {
  return (await http.patch<ResearchThesis>(`${root}/theses/${encodeURIComponent(id)}`, input)).data;
}
export async function deleteResearchThesis(id: string, expectedVersion: number): Promise<void> {
  await http.delete(`${root}/theses/${encodeURIComponent(id)}`, { data: { expectedVersion } });
}
export async function fetchResearchThesisVersions(id: string): Promise<ResearchThesisVersion[]> {
  return (await http.get<ResearchThesisVersion[]>(`${root}/theses/${encodeURIComponent(id)}/versions`)).data;
}
