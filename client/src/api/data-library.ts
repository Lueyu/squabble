import http from './http';
import type {
  DataFinancialConnection, DataFinancialProvider, DataFinancialQuery, DataFinancialQueryResult,
  DataFinancialTestResult, DataLibraryFileUpload, DataLibraryList, DataLibrarySourceCreate,
  DataLibrarySourceDetail, DataLibrarySourceKind, DataLibrarySourceUpdate, DataLibrarySyncJob,
  DataLibrarySyncResult, DataLibraryVersion,
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
  update: async (id: string, input: DataLibrarySourceUpdate) => (await http.patch(sourcePath(id), input)).data,
  remove: async (id: string) => (await http.delete(sourcePath(id))).data,
  upload: async (input: DataLibraryFileUpload) => (await http.post(`${base}/files`, input)).data,
  file: async (id: string) => (await http.get<Blob>(`${sourcePath(id)}/file`, { responseType: 'blob' })).data,
  sync: async (id: string) => (await http.post<DataLibrarySyncResult>(`${sourcePath(id)}/sync`, {}, { timeout: 90000 })).data,
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
