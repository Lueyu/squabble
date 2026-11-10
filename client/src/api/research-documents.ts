import http from './http';
import type { DeleteResearchDocumentVersionInput, ResearchDeletionResult } from '@shared/research-deletion.interface';
import type { ReportReference, ReportSource, ResolvedReportReference, ResearchDocumentVersion, ResearchDocumentView, ResearchRevisionDraft, ResearchRevisionInput, ResearchDocumentIndex, ResearchDocumentIndexQuery } from '@shared/research-document.interface';

const root = '/api/research-documents';
export async function deleteResearchDocumentVersion(id: string, input: DeleteResearchDocumentVersionInput): Promise<ResearchDeletionResult> {
  return (await http.post<ResearchDeletionResult>(`${root}/versions/${encodeURIComponent(id)}/delete`, input)).data;
}
export async function fetchResearchDocuments(query: ResearchDocumentIndexQuery = {}): Promise<ResearchDocumentIndex> {
  return (await http.get<ResearchDocumentIndex>(root, { params: query })).data;
}
export async function importResearchDocument(source: ReportSource): Promise<ResearchDocumentVersion> {
  return (await http.post<ResearchDocumentVersion>(`${root}/import`, source)).data;
}
export async function resolveResearchReferences(references: ReportReference[]): Promise<ResolvedReportReference[]> {
  return (await http.post<ResolvedReportReference[]>(`${root}/resolve`, references)).data;
}
export async function fetchResearchDocument(versionId: string): Promise<ResearchDocumentView> {
  return (await http.get<ResearchDocumentView>(`${root}/versions/${encodeURIComponent(versionId)}`)).data;
}
export async function createResearchRevision(versionId: string, input: ResearchRevisionInput): Promise<ResearchRevisionDraft> {
  return (await http.post<ResearchRevisionDraft>(`${root}/versions/${encodeURIComponent(versionId)}/drafts`, input)).data;
}
export async function updateResearchRevision(id: string, input: ResearchRevisionInput, expectedRevision: number): Promise<ResearchRevisionDraft> {
  return (await http.patch<ResearchRevisionDraft>(`${root}/drafts/${encodeURIComponent(id)}`, { ...input, expectedRevision })).data;
}
export async function publishResearchRevision(id: string, expectedRevision: number): Promise<ResearchDocumentVersion> {
  return (await http.post<ResearchDocumentVersion>(`${root}/drafts/${encodeURIComponent(id)}/publish`, { expectedRevision })).data;
}
export async function adoptResearchVersion(id: string, expectedAdoptedVersionId: string | null): Promise<void> {
  await http.post(`${root}/versions/${encodeURIComponent(id)}/adopt`, { expectedAdoptedVersionId });
}
export async function forkResearchVersion(id: string, title: string): Promise<ResearchDocumentVersion> {
  return (await http.post<ResearchDocumentVersion>(`${root}/versions/${encodeURIComponent(id)}/fork`, { title })).data;
}
export async function revokeResearchVersion(id: string, reason: string): Promise<void> {
  await http.post(`${root}/versions/${encodeURIComponent(id)}/revoke`, { reason });
}
