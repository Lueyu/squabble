/** Data-library responses never expose credentials or encrypted secrets. */
export const dataLibraryKinds = ['page', 'website', 'slides', 'image', 'file'] as const;
export type DataLibrarySourceKind = typeof dataLibraryKinds[number];
export const dataLibraryFormats = ['text', 'html', 'rss', 'json', 'pptx', 'image'] as const;
export type DataLibraryFormat = typeof dataLibraryFormats[number];
export const dataLibraryAuthKinds = ['none', 'cookie', 'bearer', 'basic'] as const;
export type DataLibraryAuthKind = typeof dataLibraryAuthKinds[number];
export type DataLibraryState = 'pending' | 'ready' | 'syncing' | 'needs-auth' | 'failed' | 'paused' | 'needs-text';
export interface DataLibrarySection { locator: string; title?: string; text: string }
export interface DataLibrarySource {
  id: string; kind: DataLibrarySourceKind; title: string; description: string;
  format: DataLibraryFormat; url: string | null; fileName: string | null; mimeType: string | null;
  enabled: boolean; authKind: DataLibraryAuthKind; hasCredential: boolean; needsReentry: boolean;
  syncIntervalMinutes: number | null; nextSyncAt: string | null; latestVersionId: string | null;
  versionCount: number; state: DataLibraryState; lastSuccessAt: string | null; lastErrorCode: string | null;
  createdAt: string; updatedAt: string;
}
export interface DataLibraryVersionSummary {
  id: string; sourceId: string; version: number; contentHash: string; byteLength: number;
  observedAt: string; extractionState: 'ready' | 'needs-text'; sectionCount: number;
}
export interface DataLibraryVersion extends DataLibraryVersionSummary {
  rawContent: string; extractedText: string; sections: DataLibrarySection[];
}
export interface DataLibrarySourceDetail { source: DataLibrarySource; versions: DataLibraryVersionSummary[] }
export interface DataLibraryList { items: DataLibrarySource[]; total: number; offset: number; limit: number }
export interface DataLibrarySourceCreate {
  title: string; kind: 'page' | 'website'; description?: string; format?: 'text' | 'html' | 'rss' | 'json';
  text?: string; url?: string; enabled?: boolean; syncIntervalMinutes?: number | null;
  authKind?: DataLibraryAuthKind;
  /** Write only. Basic accepts username/password separately. Never include these in traces. */
  credential?: string; username?: string; password?: string;
}
export interface DataLibrarySourceUpdate {
  title?: string; description?: string; text?: string; enabled?: boolean;
  syncIntervalMinutes?: number | null; authKind?: DataLibraryAuthKind;
  credential?: string; username?: string; password?: string; clearCredential?: boolean;
}
export interface DataLibraryFileUpload {
  title: string; description?: string; fileName: string; mimeType: string; data: string;
}
export interface DataLibrarySyncJob {
  id: string; sourceId: string; state: 'running' | 'succeeded' | 'failed' | 'cancelled';
  outcome: 'updated' | 'unchanged' | null; versionId: string | null; errorCode: string | null;
  startedAt: string; finishedAt: string | null;
}
export interface DataLibrarySyncResult { job: DataLibrarySyncJob; source: DataLibrarySource }
export interface DataLibraryReference { sourceId: string; versionId: string }
export interface DataLibrarySearchItem extends DataLibraryReference {
  title: string; kind: DataLibrarySourceKind; sourceUrl?: string; fileName?: string;
  locator: string; excerpt: string; observedAt: string; validity: 'current';
}
export interface DataLibrarySearchResult { items: DataLibrarySearchItem[]; asOf: string; truncated: boolean }
export const dataFinancialProviders = ['public', 'sec', 'finnhub', 'alpha-vantage'] as const;
export type DataFinancialProvider = typeof dataFinancialProviders[number];
export const dataFinancialOperations = ['quote', 'daily-history', 'financials', 'news'] as const;
export type DataFinancialOperation = typeof dataFinancialOperations[number];
export interface DataFinancialConnection {
  provider: DataFinancialProvider; name: string; description: string; capabilities: DataFinancialOperation[];
  markets: string[]; requiresKey: boolean; enabled: boolean; configured: boolean; needsReentry: boolean;
  hasApiKey: boolean; maskedApiKey?: string; lastTestAt: string | null;
  lastTestOk: boolean | null; lastTestCode: string | null;
}
export interface DataFinancialQuery {
  provider: DataFinancialProvider; symbol: string; operation: DataFinancialOperation;
}
export interface DataFinancialQueryResult extends DataFinancialQuery {
  status: 'succeeded' | 'partial' | 'unavailable' | 'failed'; data: unknown;
  observedAt: string; asOf: string; freshness: 'end-of-day' | 'provider-timestamp' | 'filing';
  sources: Array<{ title: string; url?: string; fetchedAt: string }>;
  errorCode?: string;
}
export interface DataFinancialTestResult { ok: boolean; code: string; testedAt: string; sample?: DataFinancialQueryResult }
