import http from './http';
import type {
  DataFinancialConnection, DataFinancialProvider, DataFinancialQuery, DataFinancialQueryResult,
  DataBrowserStatus, DataFinancialTestResult, DataLibraryFileUpload, DataLibraryList, DataLibrarySource,
  DataLibrarySourceCreate,
  DataLibrarySourceDetail, DataLibrarySourceKind, DataLibrarySourceUpdate, DataLibrarySyncJob,
  DataLibrarySyncResult, DataLibraryVersion, DataDocumentStatus,
} from '@shared/data-library.interface';

const base = '/api/data-library';
const sourcePath = (id: string) => `${base}/sources/${encodeURIComponent(id)}`;
export const dataLibraryKey = ['data-library'] as const;

export const dataLibraryApi = {
  list: async (params: { offset?: number; limit?: number; kind?: DataLibrarySourceKind; q?: string }) =>
    (await http.get<DataLibraryList>(`${base}/sources`, { params })).data,
  detail: async (id: string) => (await http.get<DataLibrarySourceDetail>(sourcePath(id))).data,
  version: async (id: string, versionId: string) =>
    (await http.get<DataLibraryVersion>(`${sourcePath(id)}/versions/${encodeURIComponent(versionId)}`)).data,
  create: async (input: DataLibrarySourceCreate) => (await http.post(`${base}/sources`, input)).data,
  update: async (id: string, input: DataLibrarySourceUpdate) =>
    (await http.patch<DataLibrarySource>(sourcePath(id), input)).data,
  remove: async (id: string) => (await http.delete(sourcePath(id))).data,
  upload: async (input: DataLibraryFileUpload) => (await http.post(`${base}/files`, input)).data,
  file: async (id: string) => (await http.get<Blob>(`${sourcePath(id)}/file`, { responseType: 'blob' })).data,
  documentStatus: async (id: string, versionId?: string) =>
    (await http.get<DataDocumentStatus>(`${sourcePath(id)}/document`, { params: { versionId } })).data,
  reparseDocument: async (id: string, extractor: string) =>
    (await http.post(`${sourcePath(id)}/document/reparse`, { extractor })).data,
  cancelDocument: async (id: string) => (await http.post(`${base}/document-jobs/${encodeURIComponent(id)}/cancel`)).data,
  artifact: async (id: string) => (await http.get<Blob>(`/api/research-artifacts/${encodeURIComponent(id)}/download`, { responseType: 'blob' })).data,
  dataset: async (id: string) => (await http.get<Blob>(`${base}/datasets/${encodeURIComponent(id)}/download`, { responseType: 'blob' })).data,
  sync: async (id: string) => (await http.post<DataLibrarySyncResult>(`${sourcePath(id)}/sync`, {}, { timeout: 90000 })).data,
  browserStatus: async (id: string) => (await http.get<DataBrowserStatus>(`${sourcePath(id)}/browser`)).data,
  openBrowser: async (id: string) =>
    (await http.post<DataBrowserStatus>(`${sourcePath(id)}/browser/open`, {}, { timeout: 60000 })).data,
  confirmBrowser: async (id: string) =>
    (await http.post<DataBrowserStatus>(`${sourcePath(id)}/browser/confirm`, {}, { timeout: 60000 })).data,
  disconnectBrowser: async (id: string) =>
    (await http.delete<DataBrowserStatus>(`${sourcePath(id)}/browser/session`)).data,
  jobs: async (sourceId: string) =>
    (await http.get<{ items: DataLibrarySyncJob[]; total: number }>(`${base}/jobs`, { params: { sourceId } })).data,
  providers: async () => (await http.get<{ providers: DataFinancialConnection[] }>(`${base}/financial`)).data,
  saveProvider: async (provider: DataFinancialProvider, input: { apiKey?: string; enabled?: boolean }) =>
    (await http.put(`${base}/financial/${provider}`, input)).data,
  removeProvider: async (provider: DataFinancialProvider) => (await http.delete(`${base}/financial/${provider}`)).data,
  testProvider: async (provider: DataFinancialProvider) =>
    (await http.post<DataFinancialTestResult>(`${base}/financial/${provider}/test`, {}, { timeout: 60000 })).data,
  queryProvider: async ({ provider, ...input }: DataFinancialQuery) =>
    (await http.post<DataFinancialQueryResult>(`${base}/financial/${provider}/query`, input, { timeout: 60000 })).data,
};
