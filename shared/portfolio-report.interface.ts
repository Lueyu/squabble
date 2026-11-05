import type { ModelRoute } from './model-route.interface';

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
