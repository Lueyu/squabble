import type { Market } from './api.interface';
import type { MandateRule, StrategyMandateInput } from './strategy-mandate.interface';

export type InvestmentStatus = 'not_started' | 'needs_information' | 'needs_confirmation' | 'running' | 'paused' | 'attention_required';
export type InvestmentConstraint =
  | { kind: 'no_buy' | 'no_sell'; ticker: string; expiresAt: string | null }
  | { kind: 'no_increase'; expiresAt: string | null }
  | { kind: 'position_cap'; ticker: string; percent: number; expiresAt: string | null }
  | { kind: 'cash_floor'; percent: number; expiresAt: string | null }
  | { kind: 'markets'; markets: Market[]; expiresAt: string | null };
export interface InvestmentConstraintRecord {
  id: string; proposalId: string; createdAt: string; revokedAt: string | null;
  status: 'active' | 'expired' | 'revoked'; constraint: InvestmentConstraint;
}
export interface InvestmentConfig {
  /** Server-frozen starting securities for adopted legacy ledgers without a simulation seed. */
  initialTickers?: string[];
  markets: Market[]; assetTypes: Array<'stock' | 'etf'>; timezone: string;
  limits: { maxPositionPct: number; maxOrderPct: number; maxDailyIncreasePct: number;
    maxDailyTurnoverPct: number; maxGrossExposurePct: number; minCashPct: number; dailyLossLimitPct: number };
  budget: { dailyTasks: number; maxCallsPerTask: number; maxDiscoveryCandidates: number; maxDeepResearchCandidates: number };
  noBuy: string[]; noSell: string[]; noIncrease: boolean; positionCaps: Record<string, number>;
}
export interface InvestmentPolicy {
  id: string; accountId: string; revision: number; status: 'running' | 'paused' | 'archived';
  baseConfig: InvestmentConfig; effectiveConfig: InvestmentConfig; constraintRecords: InvestmentConstraintRecord[];
  confirmedAt: string; updatedAt: string;
}
export interface InvestmentStartRequest {
  previewId: string; requestKey: string; markets?: Market[]; limits?: Partial<InvestmentConfig['limits']>;
  confirmNoCash?: boolean; cashAvailable?: Record<string, number>; sellableShares?: Record<string, number>;
  adoptAccountId?: string;
}
export interface AiInvestmentView {
  status: InvestmentStatus;
  account: { id: string; name: string; isActive: boolean; botEnabled: boolean; initialCash: string; cashBalance: string } | null;
  policy: InvestmentPolicy | null; needsInput: string[]; limits: InvestmentConfig['limits'];
  constraints: InvestmentConstraintRecord[]; currentThinking: string | null;
  actions: Array<{ id: string; ticker: string; side: string; quantity: string; status: string; reason: string | null; createdAt: string }>;
  holdings: Array<{ id: string; ticker: string; shares: string; avgCost: string; market: string; currency: string }>;
  performance: { returnPct: string | null; profitUsd: string | null; excessReturnPct: string | null; gaps: string[] } | null;
  lastHeartbeatAt: string | null;
  legacyAccounts: Array<{ id: string; name: string; active: boolean; botEnabled: boolean }>;
  cycles: Array<{ id: string; state: string; market: string; reason: string | null }>;
}
export interface AiInvestmentPreview {
  id: string; previewId: string; seed: import('./simulation-experiment.interface').SimulationSeed;
  sourceRevision: string; expiresAt: string; needsInput: string[]; markets: Market[];
  limits: InvestmentConfig['limits']; budget: InvestmentConfig['budget']; inheritedConcentration: string[];
}
export interface VerifiedInvestmentSecurity {
  ticker: string; market: Market; currency: 'USD' | 'HKD' | 'CNY'; assetType: 'stock' | 'etf';
  identitySourceUrl: string; sourceUrl: string; observedAt: string; summary: string;
  providerSymbol: string; lotSize: number; leveraged: false; inverse: false;
}
export interface InvestmentResearchReview {
  memberId: string; executorIdentity: string; executorVerified: boolean; completedAt: string;
  conclusion: 'approve' | 'observe' | 'research_more'; unresolvedDisagreements: string[];
  evidenceIds: string[]; rules: unknown[]; summary: string;
}
export interface AutonomousMandateRule extends MandateRule {
  executionTaskId?: string;
  market: Market; marketSessionDate: string; validUntil: string; sourceCycleId: string;
  security: VerifiedInvestmentSecurity; executorIdentities: string[]; requiresIndependentReview: boolean;
}
export interface AutonomousMandateInput extends StrategyMandateInput {
  parentPolicyId: string; parentPolicyRevision: number; cycleId: string; rules: AutonomousMandateRule[];
}
