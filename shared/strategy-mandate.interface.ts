import type { ReportReference } from './research-document.interface';
import type { StrategyRule } from './strategy.interface';

export type StrategyRoute = 'direct' | 'ai' | 'council' | 'blocked';
export interface StrategyRoutePolicy {
  councilPositionCapRatio: number;
  councilIncrementPct: number;
  rollingWindowMinutes: number;
  candidateTtlSeconds: number;
}
export interface MandateRule extends StrategyRule {
  semanticCondition?: string;
  reviewMode?: 'deterministic' | 'ai';
}
export interface StrategyMandateInput {
  parentPolicyId?: string; parentPolicyRevision?: number; cycleId?: string;
  title: string; objective: string;
  period: 'day' | 'month' | 'custom'; timezone: string; startsAt: string; endsAt: string;
  accountId: string; profileId: string;
  references: ReportReference[]; sourceSessionId?: string;
  rules: MandateRule[];
  limits: { maxPositionPct: number; maxDailyIncreasePct: number; maxDailyTurnoverPct: number;
    minCashPct?: number; maxGrossExposurePct?: number; maxOrderPct?: number };
  exposureGroups?: Array<{ id: string; label: string; tickers: string[]; maxExposurePct: number }>;
  eventWindows?: Array<{ id: string; label: string; tickers: string[]; startsAt: string; endsAt: string }>;
  routePolicy: StrategyRoutePolicy;
  dailyPlanMode: 'fixed_rules' | 'bounded_ai';
}
export interface StrategyMandate extends StrategyMandateInput {
  id: string; version: number; revision: number; parentId: string | null;
  profileVersion: number; status: 'draft' | 'extracting' | 'published' | 'paused' | 'superseded' | 'expired';
  publishedAt: string | null; createdAt: string; updatedAt: string;
  sourceWarnings: string[];
  researchAlerts?: Array<{ ruleId: string; reason: string; sessionId: string }>;
}
export interface StrategyRouteDecision {
  route: StrategyRoute; reason: string; postTradeExposurePct: number | null; accumulatedIncreasePct: number | null;
}
export interface StrategyRouteRecord extends StrategyRouteDecision {
  signalId: string; accountId: string; mandateId: string | null;
  ticker: string; side: string; quantity: number; state: string; createdAt: string;
  orderId: string | null; councilSessionId: string | null; councilReportId: string | null;
  ruleId: string; planId: string; planVersion: number; quoteAt: string; expiresAt: string;
  finalReason: string; references: ReportReference[]; sourceSessionId: string | null;
}
export interface StrategyMonitorStatus {
  lastHeartbeat: string | null; gaps: Array<{ from: string; to: string }>; activePlanCount: number;
  reviews: Array<{ id: string; from: string; to: string; state: string; reportVersionId: string | null }>;
}
export interface StrategyMandateWorkspace { items: StrategyMandate[]; decisions: StrategyRouteRecord[]; monitor?: StrategyMonitorStatus }
