import type { AgentDataClass, AgentSourceVersionRef } from './agent-tooling.interface';

export interface ResearchInstrument {
  id: string;
  exchange: string | null;
  symbol: string;
  assetType: string;
  originalSymbol: string;
  mappingBasis: string | null;
}

export interface ResearchDatasetTiming {
  observedAt: string;
  fetchedAt: string;
  dataAsOf: string | null;
  marketDate: string | null;
  reportPeriod: string | null;
  announcedAt: string | null;
  availableAt: string | null;
  availableAtBasis: string | null;
  datePrecision: 'instant' | 'day' | 'month' | 'year' | 'unknown';
}

/** Financial values are decimal strings; unknown units and currency stay null. */
export interface ResearchFinancialValue {
  value: string | null;
  currency: string | null;
  unit: string | null;
  scale: string | null;
  accountingBasis: 'CAS' | 'IFRS' | 'US-GAAP' | 'unknown';
  consolidation: 'consolidated' | 'parent' | 'unknown';
  periodBasis: 'annual' | 'quarter' | 'YTD' | 'TTM' | 'unknown';
  valueBasis: 'actual' | 'forecast' | 'unknown';
}

export interface ResearchDatasetVersion {
  id: string;
  owner: string;
  sourceVersion: AgentSourceVersionRef;
  dependencies: AgentSourceVersionRef[];
  contentHash: string;
  schema: Record<string, unknown>;
  schemaVersion: string;
  provider: string;
  operation: string;
  parameterVersion: string;
  timing: ResearchDatasetTiming;
  coverage: {
    status: 'complete' | 'partial';
    rowCount: number;
    expectedRowCount: number | null;
    from: string | null;
    to: string | null;
    missing: string[];
    delayed: boolean | null;
  };
  adjustment: 'unadjusted' | 'forward' | 'backward' | 'total_return' | 'unknown';
  corporateActionsVersionId: string | null;
  storageRef: string;
  dataClasses: AgentDataClass[];
  license: { termsRef: string | null; permittedUses: string[]; retentionUntil: string | null };
  status: 'active' | 'revoked' | 'deleted';
}

export interface ResearchDatasetSummary {
  datasetVersionId: string;
  contentHash: string;
  rowCount: number;
  sampleSize: number;
  truncated: boolean;
  coverage: ResearchDatasetVersion['coverage'];
}
