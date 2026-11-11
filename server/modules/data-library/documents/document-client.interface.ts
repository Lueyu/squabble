export interface DocumentUpload { fileName: string; mime: 'application/pdf' | 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'; data: Buffer }
export interface DocumentTaskReceipt { taskId: string; fileId?: string }
export type DocumentTaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
export interface DocumentExtractionResult { markdown: string; lossless: unknown; archive?: Buffer }
export interface DocumentExtractor {
  readonly id: string; readonly version: string;
  submit(file: DocumentUpload, onReceipt?: (receipt: DocumentTaskReceipt) => Promise<void>): Promise<DocumentTaskReceipt>;
  status(receipt: DocumentTaskReceipt): Promise<DocumentTaskStatus>;
  result(receipt: DocumentTaskReceipt): Promise<DocumentExtractionResult>;
  cancel?(receipt: DocumentTaskReceipt): Promise<void>;
}
export function validateDocumentUpload(file: DocumentUpload): void {
  if (!file.fileName || file.fileName.length > 200 || /[\\/\r\n\u0000]/u.test(file.fileName) ||
    !file.data.length || file.data.length > 8 * 1024 * 1024) throw new Error('DOCUMENT_INPUT_REJECTED');
  if (file.mime === 'application/pdf' && (!file.fileName.toLowerCase().endsWith('.pdf') || file.data.subarray(0,5).toString() !== '%PDF-')) throw new Error('DOCUMENT_FORMAT_MISMATCH');
  if (file.mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' &&
    (!file.fileName.toLowerCase().endsWith('.docx') || file.data.subarray(0,2).toString() !== 'PK')) throw new Error('DOCUMENT_FORMAT_MISMATCH');
  if (!['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'].includes(file.mime)) throw new Error('DOCUMENT_FORMAT_REJECTED');
  if (file.mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') guardZip(file.data, 'INVALID_DOCX');
}
import { guardZip } from '../data-library.extract';
