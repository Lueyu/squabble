import http from './http';
import type {
  ImportBatch,
  ImportBatchCommit,
  ImportBatchCreate,
  ImportBatchPreview,
  ImportBatchRow,
  ImportBatchUpload,
  ImportCommitReceipt,
  ImportExecutor,
} from '@shared/screenshot-import.interface';
import type {
  ImportCommitDto,
  ImportCommitResult,
} from '@shared/api.interface';
const path = (id: string) => `/api/import/batches/${encodeURIComponent(id)}`;
export async function reselectImportImage(
  id: string,
  imageId: string,
  image: ImportBatchUpload['image'],
): Promise<ImportBatch> {
  return (
    await http.post(
      `${path(id)}/images/${encodeURIComponent(imageId)}/reselect`,
      { image },
    )
  ).data;
}
export async function fetchImportBatches(): Promise<ImportBatch[]> {
  return (await http.get('/api/import/batches')).data;
}
export async function createImportBatch(
  input: ImportBatchCreate,
): Promise<ImportBatch> {
  return (await http.post('/api/import/batches', input)).data;
}
export async function fetchImportBatch(id: string): Promise<ImportBatch> {
  return (await http.get(path(id))).data;
}
export async function uploadImportImage(
  id: string,
  input: ImportBatchUpload,
): Promise<ImportBatch> {
  return (await http.post(`${path(id)}/images`, input)).data;
}
export async function startImportBatch(
  id: string,
  credentials?: Extract<
    ImportExecutor,
    {
      executor: 'vision';
    }
  >,
): Promise<ImportBatch> {
  return (await http.post(`${path(id)}/start`, { credentials })).data;
}
export async function recoverImportBatch(id: string): Promise<ImportBatch> {
  return (await http.post(`${path(id)}/recover`)).data;
}
export async function cancelImportBatch(id: string): Promise<ImportBatch> {
  return (await http.delete(path(id))).data;
}
export async function retryImportImage(
  id: string,
  imageId: string,
): Promise<ImportBatch> {
  return (
    await http.post(`${path(id)}/images/${encodeURIComponent(imageId)}/retry`)
  ).data;
}
export async function editImportRow(
  id: string,
  rowId: string,
  patch: Partial<ImportBatchRow>,
  expectedRevision: number,
): Promise<ImportBatch> {
  return (
    await http.post(`${path(id)}/rows/${encodeURIComponent(rowId)}`, {
      patch,
      expectedRevision,
    })
  ).data;
}
export async function previewImportBatch(
  id: string,
): Promise<ImportBatchPreview> {
  return (await http.get(`${path(id)}/preview`)).data;
}
export async function commitImportBatch(
  id: string,
  input: ImportBatchCommit,
): Promise<ImportCommitReceipt> {
  return (await http.post(`${path(id)}/commit`, input)).data;
}
export async function confirmMappedImport(
  input: ImportCommitDto & {
    requestKey: string;
    analyze: boolean;
  },
): Promise<
  ImportCommitResult & {
    receiptId: string;
    updated: number;
    analysisRequestId?: string;
  }
> {
  return (await http.post('/api/import/commit', input)).data;
}
export const IMPORT_QUERY_KEYS = [
  ['import'],
  ['holdings'],
  ['today'],
  ['current-research'],
  ['simple-experience'],
] as const;
