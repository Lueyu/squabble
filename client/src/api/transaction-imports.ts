import http from './http';
import type { TransactionImportInput, TransactionImportPreview, TransactionImportCommit, TransactionImportReceipt } from '@shared/transaction-import.interface';
export const createTransactionBatch = async (input: TransactionImportInput) => (await http.post<TransactionImportPreview>('/api/import/transaction-batches', input)).data;
export const previewTransactionBatch = async (id: string) => (await http.get<TransactionImportPreview>(`/api/import/transaction-batches/${id}/preview`)).data;
export const commitTransactionBatch = async (id: string, input: TransactionImportCommit) => (await http.post<TransactionImportReceipt>(`/api/import/transaction-batches/${id}/commit`, input)).data;
