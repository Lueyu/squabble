import type { PortfolioReportSnapshot } from './portfolio-report.interface';

export interface ExperiencePreferences {
  enabled: boolean; timezone: string; defaultMembers: string[]; defaultAccountId: string | null;
  migrationState: 'new' | 'legacy' | 'adopted';
}
export interface CurrentResearchView {
  topicKey: string; dateKey: string; documentId: string | null; title: string; content: string;
  updatedAt: string | null; dataAsOf: string | null; changeSummary: string | null;
  state: 'empty' | 'ready' | 'generating' | 'failed'; taskId: string | null; error: string | null;
  source: { type: string; id: string } | null;
  researchLevel?: 'facts_only' | 'ai';
  summary?: string | null; keyPoints?: string[]; risks?: string[]; nextChecks?: string[];
  progress?: {phase:string;message:string;percent:number} | null;
  executorLabel?: string | null;
  startedAt?: string | null; cancelling?: boolean; cancelled?: boolean;
}
export interface TodayAttention {
  id: string; kind: 'concentration' | 'data_gap' | 'research'; title: string; detail: string; ticker?: string;
}
export interface TodayView {
  date: string; timezone: string; asOf: string;
  overview: { totalValueUsd: number | null; cashUsd: number | null; dailyPnlUsd: number | null;
    returnPct: number | null; holdingCount: number };
  holdings: PortfolioReportSnapshot['holdings']; summary: string | null; attention: TodayAttention[];
  analysis: CurrentResearchView; gaps: string[]; aiAvailable: boolean;
  marketTimes: Array<{ market: string; dataAsOf: string | null }>;
  currencyTotals?: Array<{currency:string;holdingsValue:number|null;cash:number|null}>;
  dailyBaselineMissing?: boolean;
  teamActivity?: Array<{ id: string; sessionId: string; title: string; summary: string; hasDisagreement: boolean; createdAt: string }>;
  recentActions?: Array<{ id: string; ticker: string; side: string; status: string; reason: string | null; createdAt: string }>;
}
