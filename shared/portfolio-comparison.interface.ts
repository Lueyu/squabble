export type PortfolioComparisonPeriod = '1D' | '1W' | '1M' | '3M' | 'YTD' | 'ALL';
export type PortfolioComparisonMetric = 'equity' | 'return';

/** Saved observations only: null is an unknown value, never a zero balance. */
export interface PortfolioComparisonPoint {
  timestamp: string;
  date: string;
  equityUsd: number | null;
  returnPct: number | null;
  gaps: string[];
}
export interface PortfolioComparisonSeries {
  accountId: string;
  name: string;
  kind: 'real' | 'simulation';
  colorIndex: number;
  status: 'real' | 'running' | 'paused' | 'archived';
  createdAt: string | null;
  valuationAsOf: string | null;
  equityUsd: number | null;
  returnPct: number | null;
  returnFrom: string | null;
  strategyCount: number;
  points: PortfolioComparisonPoint[];
  gaps: string[];
}
export interface PortfolioComparisonView {
  currency: 'USD';
  period: PortfolioComparisonPeriod;
  from: string;
  to: string;
  granularity: 'observations' | 'daily';
  methodology: 'saved_valuations_no_external_flows';
  series: PortfolioComparisonSeries[];
}
