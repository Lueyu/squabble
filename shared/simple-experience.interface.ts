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
  readingState?: 'ready' | 'pending';
  sessionId?: string | null;
  summary?: string | null; keyPoints?: string[]; risks?: string[]; nextChecks?: string[];
  progress?: {phase:string;message:string;percent:number} | null;
  executorLabel?: string | null;
  startedAt?: string | null; cancelling?: boolean; cancelled?: boolean;
}
export interface DailyResearchReports {
  initial: CurrentResearchView | null;
  latestDiscussion: CurrentResearchView | null;
  history: CurrentResearchView[];
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
  initialAnalysis?: CurrentResearchView | null;
  discussionAnalysis?: CurrentResearchView | null;
  reportHistory?: CurrentResearchView[];
  marketTimes: Array<{ market: string; dataAsOf: string | null }>;
  currencyTotals?: Array<{currency:string;holdingsValue:number|null;cash:number|null}>;
  dailyBaselineMissing?: boolean;
  assetMetrics?: {
    totalValueUsd:number|null;knownValueUsd:number;holdingsValueUsd:number;cashUsd:number|null;knownCashUsd:number;
    dailyPnlUsd:number|null;knownDailyPnlUsd:number|null;returnPct:number|null;partial:boolean;estimated:boolean;gaps:string[];
    marketTimes:Array<{market:string;dataAsOf:string|null;tradingDate:string|null}>;refreshing:boolean;
    provenance?:AssetValuationProvenance;
  };
  assetTrend?: {
    points:Array<{date:string;capturedAt:string;valueUsd:number;complete:boolean}>;since:string|null;
    assetChangeUsd:number|null;netExternalFlowUsd:number|null;investmentPnlUsd:number|null;gaps:string[];
  };
  teamActivity?: Array<{ id: string; sessionId: string; title: string; summary: string; hasDisagreement: boolean; createdAt: string }>;
  recentActions?: Array<{ id: string; ticker: string; side: string; status: string; reason: string | null; createdAt: string }>;
}

export interface AssetValuationProvenance {
  fx:Array<{currency:string;usdRate:number|null;rateDate:string|null;source:'identity'|'recorded'|'missing';direction:'direct'|'inverse'|null}>;
  quotes:Array<{ticker:string;market:string;source:string;quoteAt:string|null;retrievedAt:string|null;tradingDate:string|null;previousCloseDate:string|null}>;
}
