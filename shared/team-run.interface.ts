import type { ResearchSourceRef, TeamBudget, TeamMemberSnapshot, TeamPreview } from './team-workspace.interface';
import type { TradingMarket } from './trading-market.interface';

export interface TeamRunBudget {
  perRun: TeamBudget & { ceiling: { amount: string; currency: 'USD' } };
  daily: { costUsd: string; calls: number };
  monthly: { costUsd: string; calls: number };
}
export interface TeamRunAgreementInput {
  requestKey: string; teamVersionId: string; bindingId: string; expectedBindingRevision: number;
  objective: string; market: TradingMarket; cadence?: { kind: 'after_close'; delayMinutes: number };
  budget: TeamRunBudget; replacementPolicy: { kind: 'replace_combination'; allocationPct: number };
  inputRefs: ResearchSourceRef[];
}
export interface TeamRunConfiguration extends Omit<TeamRunAgreementInput, 'requestKey' | 'cadence'> {
  cadence: { kind: 'after_close'; delayMinutes: number };
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
  reservedCostUsd: string; reservedCalls: number; lastError: string | null;
  createdAt: string; updatedAt: string;
}
export interface TeamRunStatus { agreement: TeamRunAgreement | null; recentCycles: TeamRunCycle[] }
export type TeamRunAgreementPreview = TeamPreview<{ configuration: TeamRunConfiguration; accountId: string; members: TeamMemberSnapshot[] }>;
export interface TeamRunControlInput { requestKey: string; expectedRevision: number }
/** Passed only inside trusted server code; never accepted from an HTTP request body. */
export interface TeamRunAuthority { agreementId: string; revision: number; cycleId: string }
