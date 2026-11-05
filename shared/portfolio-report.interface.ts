import type { ModelRoute } from './model-route.interface';
import type { TradingMarketSchedule } from './trading-market.interface';

/** Immutable server ledger facts. Transaction dates are user-recorded dates, not execution timestamps. */
export interface PortfolioDailyFacts {
  businessDate: string; timezone: 'Asia/Shanghai'; capturedAt: string;
  transactions: Array<{ id: string; date: string; ticker: string; type: string; currency: string;
    shares: number | null; price: number | null; notional: number | null; fees: number | null; updatedAt: string; assumedFunding: boolean }>;
  byCurrency: Array<{ currency: string; buys: number; sells: number; deposits: number; withdrawals: number; fees: number }>;
  positionChanges: Array<{ ticker: string; boughtShares: number; soldShares: number; netShares: number }>;
  marketSessions: Array<TradingMarketSchedule & { lastCompletedTradingDate: string | null }>;
  returnBasis: { method: 'equity_change_minus_external_flows'; currency: 'USD';
    startSnapshot: { id: string; date: string; accountValue: number | null; updatedAt: string } | null;
    endSnapshot: { id: string; date: string; accountValue: number | null; updatedAt: string } | null;
    fx: Array<{ base: string; quote: string; rate: number; date: string }>;
    netExternalFlowUsd: number | null; pnlUsd: number | null; returnPct: number | null };
  gaps: string[];
}

export interface PortfolioReportHoldingSnapshot {
  ticker: string;
  company: string;
  market: string;
  currency: string;
  shares: number;
  currentPrice: number | null;
  costPrice: number | null;
  marketValueUsd: number | null;
  weightPct: number | null;
}

export interface PortfolioReportSnapshot {
  capturedAt: string;
  holdings: PortfolioReportHoldingSnapshot[];
  cashUsd: number | null;
  totalValueUsd: number | null;
  gaps: string[];
  dailyFacts?: PortfolioDailyFacts;
}

export type PortfolioHoldingStance = 'add' | 'hold' | 'reduce' | 'exit' | 'watch';

export interface PortfolioHoldingJudgment {
  ticker: string;
  stance: PortfolioHoldingStance;
  rationale: string;
  evidenceRefs: string[];
  triggers: string[];
}

export interface PortfolioReport {
  summary: string;
  allocationRisks: string[];
  actions: string[];
  uncertainties: string[];
  holdings: PortfolioHoldingJudgment[];
  /** Server-sourced gaps from the frozen snapshot, never model-authored. */
  dataGaps: string[];
}

export type PortfolioReportStatus = 'pending' | 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled';

export interface PortfolioReportProgress {
  phase: 'queued' | 'preparing' | 'analyzing' | 'validating' | 'completed';
  message: string;
  percent: number;
}

export interface PortfolioReportRun {
  id: string;
  status: PortfolioReportStatus;
  route: ModelRoute;
  snapshot: PortfolioReportSnapshot;
  progress: PortfolioReportProgress;
  report: PortfolioReport | null;
  usageKnown: boolean;
  tokensUsed: number | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}
