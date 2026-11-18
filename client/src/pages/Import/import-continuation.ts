import type { confirmMappedImport } from '@/api/import-batches';
import type { ImportBatchCommit } from '@shared/screenshot-import.interface';
import { readTabRecovery, writeTabRecovery } from '@/utils/workspace-tab-recovery';

type CsvInput = Parameters<typeof confirmMappedImport>[0];
type CsvResult = Awaited<ReturnType<typeof confirmMappedImport>>;
type CsvImportRecovery =
  | { kind: 'pending'; input: CsvInput }
  | { kind: 'saved'; result: CsvResult; filename?: string };

interface ScreenshotCommit {
  batchId: string;
  input: ImportBatchCommit;
}

export function readCsvImportRecovery(): CsvImportRecovery | null {
  const record = readTabRecovery('csv-import') as CsvImportRecovery | null;
  if (record?.kind === 'pending' && typeof record.input?.requestKey === 'string' && Array.isArray(record.input.rows)) return record;
  if (record?.kind === 'saved' && typeof record.result?.receiptId === 'string' && Array.isArray(record.result.failed)) return record;
  return null;
}

export function saveCsvImportRecovery(record: CsvImportRecovery | null): boolean {
  return writeTabRecovery('csv-import', record);
}

export function readScreenshotRecovery(): ScreenshotCommit | null {
  const record = readTabRecovery('screenshot-import') as ScreenshotCommit | null;
  return typeof record?.batchId === 'string' && typeof record.input?.requestKey === 'string'
    && Array.isArray(record.input.rowIds) ? record : null;
}

export function saveScreenshotRecovery(record: ScreenshotCommit | null): boolean {
  return writeTabRecovery('screenshot-import', record);
}
