import { z } from 'zod';
import { verifyDatasetContent } from '../data-library/data-dataset.rules';
import type { ResearchDatasetVersion } from '../../../shared/research-dataset.interface';

export const ANALYTICS_DEPENDENCIES = Object.freeze({ worker: '1.0.0', python: '3.12.10', quantstats: '0.0.86',
  pandas: '2.3.3', numpy: '2.3.5', matplotlib: '3.10.7', backtrader: '1.9.78.123', font: 'DejaVu Sans (matplotlib 3.10.7)' });
export const computeRequestSchema = z.object({
  requestKey: z.string().min(1).max(160), runId: z.string().min(1).max(160),
  kind: z.enum(['statistics', 'backtest', 'exploratory']),
  datasetVersionIds: z.array(z.uuid()).min(1).max(20),
  expectedContentHashes: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/u)),
  parameters: z.record(z.string(), z.unknown()), seed: z.number().int().min(0).max(2_147_483_647),
  code: z.string().max(64_000).optional(), maxRuntimeMs: z.number().int().min(1000).max(120_000).default(60_000),
}).strict().superRefine((value, context) => {
  if (new Set(value.datasetVersionIds).size !== value.datasetVersionIds.length
    || value.datasetVersionIds.some(id => !value.expectedContentHashes[id])) context.addIssue({ code: 'custom', message: 'DATASET_HASH_REQUIRED' });
  if (value.kind === 'exploratory' ? !value.code?.trim() : value.code !== undefined) context.addIssue({ code: 'custom', message: 'COMPUTE_CODE_MODE_INVALID' });
  if (value.kind === 'exploratory' && value.parameters.validated) context.addIssue({ code: 'custom', message: 'EXPLORATORY_NOT_VALIDATED' });
});
export type ComputeRequest = z.infer<typeof computeRequestSchema>;

export function assertDatasetComputeInput(metadata: ResearchDatasetVersion, rows: Record<string, unknown>[], expected: string): void {
  if (metadata.status !== 'active' || metadata.contentHash !== expected || rows.length !== metadata.coverage.rowCount) throw new Error('COMPUTE_DATASET_CHANGED');
  if (!verifyDatasetContent(metadata, rows)) throw new Error('COMPUTE_DATASET_HASH_MISMATCH');
  const sensitive = metadata.dataClasses.some(value => value !== 'public');
  if (!metadata.license.permittedUses.includes('research')
    || sensitive && !metadata.license.permittedUses.includes('egress:e2b')) throw new Error('DATASET_EGRESS_NOT_ALLOWED');
}

export function statisticsParameters(value: Record<string, unknown>) {
  const returns = z.object({ inputKind: z.literal('returns').optional(),
    returnColumn: z.string().min(1).max(100), benchmarkColumn: z.string().min(1).max(100).nullable(),
    frequency: z.enum(['daily', 'weekly', 'monthly', 'quarterly', 'annual', 'custom']),
    annualizationFactor: z.number().int().min(1).max(100000), riskFreeRate: z.number().finite().gt(-1),
  }).strict();
  const prices = z.object({ inputKind: z.literal('prices'), dateColumn: z.string().min(1).max(100),
    priceColumn: z.string().min(1).max(100), returnBasis: z.enum(['unadjusted-price-only', 'provider-adjusted-price', 'total-return-index']),
    calendarDatasetVersionId: z.uuid().nullable(), calendarDateColumn: z.string().min(1).max(100).optional(),
    calendarOpenColumn: z.string().min(1).max(100).optional(), frequency: z.literal('daily'),
    annualizationFactor: z.number().int().min(1).max(366), riskFreeRate: z.number().finite().gt(-1),
  }).strict();
  return z.union([returns, prices]).parse(value);
}
