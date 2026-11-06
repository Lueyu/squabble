export interface SimulationSeedPosition {
  sourceHoldingId: string; ticker: string; market: 'US' | 'HK' | 'CN'; currency: 'USD' | 'HKD' | 'CNY';
  company: string | null; shares: string; historicalCost: string | null; initialPrice: string | null;
  quoteAt: string | null; sourceUpdatedAt: string; sellableShares: string | null; restriction: string;
}
export interface SimulationCash {
  currency: string; total: string; available: string; frozen: string; unsettled: string;
  availabilityKnown: boolean; sourceUpdatedAt?: string;
}
export interface SimulationSeed {
  sourceRevision: string; capturedAt: string; valuationStartedAt?: string; positions: SimulationSeedPosition[]; cash: SimulationCash[];
  /** Real recorded cash before optional virtual funding, for source-change comparisons. */
  copiedCash?: Array<{ currency: string; total: string }>;
  fx: Array<{ currency: string; rate: string; at: string }>;
  initialEquityUsd: string | null; gaps: string[];
  model: { version: 'paper-v1'; feeBps: number; slippageBps: number; corporateActions: 'unsupported' };
  benchmarkOptions?: SimulationIndexBenchmark[];
  benchmark?: SimulationIndexBenchmark | null;
}
export interface SimulationIndexBenchmark { ticker: 'SPY' | 'QQQ'; currency: 'USD'; initialPrice: string | null; quoteAt: string | null }
export interface SimulationPreview { id: string; expiresAt: string; seed: SimulationSeed }
export interface CreateSimulationExperiment {
  previewId: string; idempotencyKey: string; name: string; acknowledgeGaps: boolean;
  cashAvailable?: Record<string, string>; sellableShares?: Record<string, string>; confirmNoCash?: boolean;
  feeBps?: number; slippageBps?: number; benchmarkTicker?: 'SPY' | 'QQQ' | null;
}
export interface SimulationExperiment {
  id: string; name: string; active: boolean; initialEquityUsd: string; createdAt: string;
  seed: SimulationSeed | null; cash: SimulationCash[];
  /** Null when no real-account seed or reliable source comparison is available. */
  sourceChanged: boolean | null;
  executionModel: SimulationSeed['model'];
}
export interface SimulationReview {
  timezone: string;
  accountId: string; from: string; to: string; initialEquityUsd: string | null; endingEquityUsd: string | null;
  profitUsd: string | null; returnPct: string | null; buyAndHoldEquityUsd: string | null;
  excessReturnPct: string | null; orders: number; feesUsd: string; gaps: string[]; valuationAsOf: string | null;
  indexBenchmarkTicker: string | null; indexBenchmarkEquityUsd: string | null;
  indexBenchmarkReturnPct: string | null; indexExcessReturnPct: string | null;
  observedMaxDrawdownPct: string | null; drawdownSampleCount: number;
  drawdownCoverage: 'observed_snapshots_only' | 'insufficient_samples' | 'corporate_action_gap';
  strategyContributions: Array<{ mandateId: string; title: string; version: number; from: string; to: string;
    profitUsd: string | null; returnPct: string | null; orders: number; feesUsd: string; gaps: string[] }>;
}
