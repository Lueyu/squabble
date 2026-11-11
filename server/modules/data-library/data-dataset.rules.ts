import type { ResearchDatasetVersion } from '../../../shared/research-dataset.interface';
import { canonicalJson, hashContent, sourceRefs } from '../research-artifacts/research-artifacts.rules';

export interface DatasetCreate {
  metadata: Omit<ResearchDatasetVersion, 'id' | 'owner' | 'contentHash' | 'storageRef' | 'status'>;
  rows: Record<string, unknown>[];
}
export function datasetContentHash(metadata: DatasetCreate['metadata'], rows: Record<string, unknown>[]): string {
  return hashContent({ sourceVersion: metadata.sourceVersion, dependencies: sourceRefs(metadata.dependencies), schema: metadata.schema,
    schemaVersion: metadata.schemaVersion, provider: metadata.provider, operation: metadata.operation,
    parameterVersion: metadata.parameterVersion, timing: metadata.timing, coverage: metadata.coverage,
    adjustment: metadata.adjustment, corporateActionsVersionId: metadata.corporateActionsVersionId,
    termsRef: metadata.license.termsRef, rows });
}
export function verifyDatasetContent(metadata: ResearchDatasetVersion, rows: Record<string, unknown>[]): boolean {
  return metadata.coverage.rowCount === rows.length && datasetContentHash(metadata, rows) === metadata.contentHash;
}
export function validateDataset(input: DatasetCreate): void {
  if (!Array.isArray(input.rows) || input.rows.length > 100_000 ||
    input.rows.some(row => !row || typeof row !== 'object' || Array.isArray(row))) throw new Error('INVALID_DATASET_ROWS');
  if (Buffer.byteLength(canonicalJson(input)) > 32 * 1024 * 1024) throw new Error('DATASET_TOO_LARGE');
  if (input.metadata.coverage.rowCount !== input.rows.length) throw new Error('DATASET_ROW_COUNT_MISMATCH');
  const expected = input.metadata.coverage.expectedRowCount;
  if (expected !== null && (!Number.isSafeInteger(expected) || expected < input.rows.length)) throw new Error('INVALID_EXPECTED_ROWS');
  if (input.metadata.coverage.status === 'complete' && (input.metadata.coverage.missing.length ||
    expected !== null && expected !== input.rows.length)) throw new Error('INCOMPLETE_COVERAGE');
  for (const time of [input.metadata.timing.observedAt, input.metadata.timing.fetchedAt]) {
    if (!Number.isFinite(Date.parse(time))) throw new Error('INVALID_DATASET_TIMING');
  }
}
