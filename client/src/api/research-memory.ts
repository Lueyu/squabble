import http from './http';
import type { ResearchMemoryItem, ResearchMemoryList, ResearchMemoryPreferences, ResearchMemoryQuery,
  ResearchThesis, ResearchThesisVersion, UpdateResearchThesis, ResearchMemoryRecall, ResearchArchiveQuery, ResearchArchiveJobs, ResearchArchiveJob,
  ResearchArchiveImport, ResearchArchiveImportResult, ResearchEvidenceGraph } from '@shared/research-memory.interface';
import type { ResearchMonitorView, WriteResearchMonitor } from '@shared/research-monitor.interface';

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

export async function fetchResearchMemoryById(id: string): Promise<ResearchMemoryItem> {
  return (await http.get<ResearchMemoryItem>(`${root}/memories/${encodeURIComponent(id)}`)).data;
}
export async function fetchResearchArchiveJobs(query: ResearchArchiveQuery = {}): Promise<ResearchArchiveJobs> {
  return (await http.get<ResearchArchiveJobs>(`${root}/archive-jobs`, { params: query })).data;
}
export async function importResearchReports(input: ResearchArchiveImport = {}): Promise<ResearchArchiveImportResult> {
  return (await http.post<ResearchArchiveImportResult>(`${root}/archive-jobs/import`, input)).data;
}
export async function retryResearchArchive(id: string): Promise<ResearchArchiveJob> {
  return (await http.post<ResearchArchiveJob>(`${root}/archive-jobs/${encodeURIComponent(id)}/retry`)).data;
}
export async function fetchResearchThesis(id: string): Promise<ResearchThesis> {
  return (await http.get<ResearchThesis>(`${root}/theses/${encodeURIComponent(id)}`)).data;
}
export async function fetchResearchEvidence(id: string): Promise<ResearchEvidenceGraph> {
  return (await http.get<ResearchEvidenceGraph>(`${root}/memories/${encodeURIComponent(id)}/evidence`)).data;
}
export async function fetchResearchMonitors(id: string): Promise<ResearchMonitorView> {
  return (await http.get<ResearchMonitorView>(`${root}/theses/${encodeURIComponent(id)}/monitors`)).data;
}
export async function writeResearchMonitor(id: string, input: WriteResearchMonitor): Promise<ResearchMonitorView> {
  return (await http.post<ResearchMonitorView>(`${root}/theses/${encodeURIComponent(id)}/monitors`, input)).data;
}
