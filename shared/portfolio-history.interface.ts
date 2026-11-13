import type { PortfolioComparisonPeriod } from './portfolio-comparison.interface';

export interface PortfolioHistoryPoint {
  date: string;
  /** Present only for a genuine dated market observation, never a fabricated daily-close time. */
  timestamp?: string;
  valueUsd: number | null;
  knownValueUsd: number;
  coveredPositions: number;
  totalPositions: number;
  priceAsOf: Array<{ ticker: string; date: string; timestamp?: string; source: string }>;
  fxAsOf: Array<{ currency: string; date: string; source: string }>;
  gaps: string[];
}

export interface PortfolioHistorySeries {
  accountId: string;
  name: string;
  kind: 'real' | 'simulation';
  holdingsAsOf: string;
  points: PortfolioHistoryPoint[];
  coverage: { completePoints: number; totalPoints: number; coveredPositions: number; totalPositions: number };
  gaps: string[];
}

/** Reference only: today's quantities × dated provider closes × dated FX. Never historical NAV or realized return. */
export interface PortfolioHistoryView {
  basis: 'current_positions_historical_prices';
  currency: 'USD';
  period: PortfolioComparisonPeriod;
  /** ALL is bounded to the most recent 365 days; other periods retain their requested duration. */
  maximumDays: 365;
  from: string;
  to: string;
  readAt: string;
  refreshing: boolean;
  includesCash: false;
  priceBasis: 'provider_close' | 'provider_quote' | 'mixed_close_and_quote';
  intradayGranularity?: 'observations' | 'hourly';
  /** Provider close conventions are retained. No dividend/corporate-action ledger is reconstructed. */
  corporateActions: 'not_reconstructed';
  series: PortfolioHistorySeries[];
  gaps: string[];
}
