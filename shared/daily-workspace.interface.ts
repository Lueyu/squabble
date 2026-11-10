import type { PortfolioDailyFacts } from './portfolio-report.interface';
import type { DailyResearchReports } from './simple-experience.interface';

export interface DailyAccountFacts {
  id: string; name: string; status: string; date: string;
  companionId?: import('./portfolio-workspace.interface').PortfolioCompanionId | null;
  valuationTimezone?: string;
  openingEquityUsd: number | null; equityUsd: number | null; cashUsd: number | null; dailyPnlUsd: number | null;
  valuationAsOf: string | null; gaps: string[];
  trades: Array<{ id: string; orderId: string; ticker: string; side: string;
    quantity: number | null; price: number | null; fee: number | null;
    currency: string | null; feeCurrency: 'USD'; executedAt: string }>;
  notExecuted: Array<{ id: string; ticker: string; side: string; status: string; reason: string | null; recordedAt: string }>;
}
/** A fresh read projection; saved report inputs remain separate and immutable. */
export interface DailyWorkspaceView {
  date: string; timezone: 'Asia/Shanghai'; readAt: string;
  personal: PortfolioDailyFacts; accounts: DailyAccountFacts[];
  reports: DailyResearchReports;
}

/** Exact server-owned input for a requested overall report. Opinions are not ledger facts. */
export interface OverallDailyEvidence {
  schemaVersion: 1;
  facts: Omit<DailyWorkspaceView, 'reports'>;
  personalHistory: {
    scope: 'latest_five_saved_portfolio_inputs';
    sources: Array<{ versionId: string; businessDate: string; capturedAt: string | null; snapshot: import('./research-document.interface').ResearchInputSnapshot }>;
    currentStoredPortfolio: { capturedAt: string; holdings: unknown[]; cash: unknown[] } | null;
    gaps: string[];
  };
}
export interface OverallDailyResearchView {
  date: string; timezone: 'Asia/Shanghai';
  latest: { sessionId: string; status: string; stage: string; error: string | null; readAt: string; factsHash: string } | null;
  reports: Array<{ versionId: string; sessionId: string; title: string; createdAt: string; readAt: string; factsHash: string; content: string }>;
}
