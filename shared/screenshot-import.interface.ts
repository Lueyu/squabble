import type { ImportRowCandidate, OcrExtractResult } from './api.interface';
import type { NativeAgentConfiguration } from './local-agents.interface';
import type { NativeAgentImage } from './native-image.interface';
export type ScreenshotExtractRequest = {
  requestId: string;
  image: NativeAgentImage;
  purpose?: 'trades' | 'cash-flows';
} & (
  | {
      executor: 'local';
      agentId: string;
      agentSettings?: NativeAgentConfiguration;
    }
  | {
      executor: 'vision';
      baseUrl?: string;
      model: string;
      apiKey: string;
    }
);
export interface ScreenshotJob {
  id: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  phase: 'queued' | 'recognizing' | 'validating' | 'done';
  executor: 'local' | 'vision' | 'unknown';
  createdAt: string;
  updatedAt: string;
  result?: ScreenshotResult;
  error?: {
    code: string;
  };
}
export interface ScreenshotFieldIssue {
  field: string;
  code: string;
}
export interface ScreenshotProblemRow {
  index: number;
  sourceImageId?: string;
  raw: Record<string, unknown>;
  issues: ScreenshotFieldIssue[];
}
export interface ScreenshotResult extends OcrExtractResult {
  documentKind?: 'trades' | 'cash-flows';
  ledgerRows?: import('./transaction-import.interface').TransactionImportCandidate[];
  problemRows?: ScreenshotProblemRow[];
}
export type ImportExecutor =
  | Omit<
      Extract<
        ScreenshotExtractRequest,
        {
          executor: 'local';
        }
      >,
      'image' | 'requestId'
    >
  | Omit<
      Extract<
        ScreenshotExtractRequest,
        {
          executor: 'vision';
        }
      >,
      'image' | 'requestId'
    >;
export interface ImportBatchRow extends ImportRowCandidate {
  id: string;
  market?: 'US' | 'HK' | 'CN';
  sourceImageIds: string[];
  revision?: number;
  committedRevision?: number;
  confirmed?: boolean;
  issues?: ScreenshotFieldIssue[];
  raw?: Record<string, unknown>;
  edits?: Array<{
    at: string;
    patch: Record<string, unknown>;
  }>;
  conflicts?: Array<{
    field: string;
    candidates: Array<{
      value: unknown;
      sourceImageIds: string[];
    }>;
  }>;
}
export interface ImportBatchImage {
  id: string;
  filename: string;
  fingerprint: string;
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  bytes: number;
  status:
    | 'queued'
    | 'running'
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'unknown';
  attempt: number;
  taskId?: string;
  error?: string;
  expiresAt: string;
  fileAvailable: boolean;
  cleanupPending?: boolean;
  timings?: {
    uploadMs?: number;
    probeMs?: number;
    startupMs?: number;
    inferenceMs?: number;
    validationMs?: number;
    totalMs?: number;
  };
  rowCount?: number;
  problemCount?: number;
}
export interface ImportCommitReceipt {
  id: string;
  requestKey: string;
  rowIds: string[];
  created: number;
  updated: number;
  createdAt: string;
  analysisRequestId?: string;
}
export interface ImportBatch {
  id: string;
  revision: number;
  status: 'draft' | 'queued' | 'running' | 'paused' | 'completed' | 'cancelled';
  executor:
    | Omit<
        Extract<
          ImportExecutor,
          {
            executor: 'vision';
          }
        >,
        'apiKey'
      >
    | Extract<
        ImportExecutor,
        {
          executor: 'local';
        }
      >;
  images: ImportBatchImage[];
  rows: ImportBatchRow[];
  receipts: ImportCommitReceipt[];
  createdAt: string;
  updatedAt: string;
  pauseReason?: string;
  firstResultMs?: number;
  performance?: {
    strategy: 'single_image';
    maxConcurrency: 1;
    reason: 'SOURCE_ATTRIBUTION_NOT_VERIFIED';
  };
}
export interface ImportBatchCreate {
  id: string;
  executor: ImportExecutor;
}
export interface ImportBatchUpload {
  id: string;
  filename: string;
  image: ScreenshotExtractRequest['image'];
}
export interface ImportBatchCommit {
  requestKey: string;
  expectedRevision: number;
  holdingsRevision: string;
  rowIds: string[];
  analyze: boolean;
}
export interface ImportBatchPreview {
  holdingsRevision: string;
  changes: Array<{
    rowId: string;
    ticker: string;
    kind: 'new' | 'update' | 'unchanged' | 'review';
    before?: {
      shares: string;
      avgCost: string | null;
    };
    after: {
      shares: ImportRowCandidate['shares'];
      avgCost: ImportRowCandidate['avgCost'];
    };
  }>;
}
