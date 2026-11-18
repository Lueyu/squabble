import type { ResearchSourceRef, TeamBudget, TeamMemberSnapshot, TeamPreview } from './team-workspace.interface';
import type { TradingMarket } from './trading-market.interface';

export interface TeamRunBudget {
  perRun: TeamBudget & { ceiling: { amount: string | null; currency: 'USD' } };
  /** Null explicitly leaves this aggregate limit unset; every individual research run remains finite. */
  daily: { costUsd: string | null; calls: number | null };
  monthly: { costUsd: string | null; calls: number | null };
}
export interface TeamRunAgreementInput {
  requestKey: string; teamVersionId: string; bindingId: string; expectedBindingRevision: number;
  objective: string; market: TradingMarket; cadence?: { kind: 'after_close'; delayMinutes: number };
  /** Research once at startup, then follow cadence. Omitted on legacy agreements means scheduled. */
  initialRun?: 'immediate' | 'scheduled';
  budget: TeamRunBudget; replacementPolicy: { kind: 'replace_combination'; allocationPct: number };
  inputRefs: ResearchSourceRef[];
}
export interface TeamRunConfiguration extends Omit<TeamRunAgreementInput, 'requestKey' | 'cadence'> {
  cadence: { kind: 'after_close'; delayMinutes: number };
  /** Server-generated at preview/confirm; never accepted from a client body. */
  workPlanProof?: import('./team-work-blueprint.interface').TeamWorkPlanProof;
}
export type TeamRunAgreementState = 'confirmed' | 'running' | 'paused' | 'suspended';
export interface TeamRunAgreement {
  id: string; teamId: string; accountId: string; revision: number; state: TeamRunAgreementState;
  configuration: TeamRunConfiguration; scopeRevision: number; members: TeamMemberSnapshot[];
  confirmedBy: string; confirmedAt: string; updatedAt: string;
  suspensionReason: string | null; externalCostUnknown: boolean;
}
export type TeamRunCycleState = 'reserved' | 'researching' | 'processing' | 'applied' | 'observed' | 'blocked' | 'uncertain' | 'cancelled';
export interface TeamRunCycle {
  id: string; agreementId: string; agreementRevision: number; tradingDate: string;
  state: TeamRunCycleState; commissionId: string | null; reportVersionId: string | null;
  decisionId: string | null; strategyId: string | null; policyRevision: number | null;
  reservedCostUsd: string | null; reservedCalls: number; lastError: string | null;
  createdAt: string; updatedAt: string;
}
export type TeamRunWindow =
  | { kind: 'after_close'; at: string; timezone: string }
  | { kind: 'first' | 'inactive' | 'after_cycle' | 'unknown' };

export interface TeamRunStatus {
  agreement: TeamRunAgreement | null;
  accountName: string | null;
  recentCycles: TeamRunCycle[];
  confirmationRevision: number | null;
  nextWindow: TeamRunWindow;
}
export interface TeamRunFill {
  id: string; accountId: string; accountName: string; orderId: string;
  ticker: string; market: string; side: string; quantity: string; price: string; currency: string; createdAt: string;
  filledAt: string | null;
}
export interface TeamRunResearch {
  versionId: string; version: number; commissionId: string; title: string;
  summary: string; publishedAt: string; source: 'automatic' | 'manual';
  applied: { revision: number; at: string } | null;
}
export interface TeamRunResearchResult {
  report: TeamRunResearch | null;
  visibilityLimited: boolean;
}
export type TeamRunAgreementPreview = TeamPreview<{ configuration: TeamRunConfiguration; accountId: string; members: TeamMemberSnapshot[] }>;
export interface TeamRunControlInput { requestKey: string; expectedRevision: number }
/** Passed only inside trusted server code; never accepted from an HTTP request body. */
export interface TeamRunAuthority { agreementId: string; revision: number; cycleId: string }
