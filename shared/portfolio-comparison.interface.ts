export type PortfolioComparisonPeriod = '1D' | '1W' | '1M' | '3M' | 'YTD' | 'ALL';
export type PortfolioComparisonMetric = 'equity' | 'return';

/** A present reading, separate from saved NAV and its verified return chain. */
export interface PortfolioCurrentMark {
  valueUsd: number | null;
  basis: 'total_assets' | 'holdings_market_value' | 'known_assets';
  holdingsValueUsd: number | null;
  cashValueUsd: number | null;
  complete: boolean;
  asOf: string | null;
  readAt: string;
  pricing: 'saved_prices' | 'cached_close' | 'mixed' | 'none';
  coveredPositions: number;
  totalPositions: number;
  gaps: string[];
}

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
  currentMark?: PortfolioCurrentMark;
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
