import type { AiInvestmentView, InvestmentPolicy, InvestmentStartRequest } from './investment-policy.interface';
import type { ConfirmedInvestmentStrategy } from './user-investment-strategy.interface';

/** Enabled combinations share the execution profile's bounded symbol capacity. */
export const PORTFOLIO_COMBINATION_MAX_SECURITIES = 100;

/** A companion is presentation metadata, never investment or execution authority. */
export const PORTFOLIO_COMPANION_IDS = ['value', 'growth', 'risk', 'technical', 'news', 'macro', 'moderator'] as const;
export type PortfolioCompanionId = typeof PORTFOLIO_COMPANION_IDS[number];
export interface PortfolioCompanionRequest {
  companionId: PortfolioCompanionId;
  expectedRevision: number;
  requestKey: string;
}
export interface PortfolioCompanionResult {
  accountId: string;
  companionId: PortfolioCompanionId;
  companionRevision: number;
}

export interface PortfolioAllocationInput {
  strategyId: string;
  strategyRevision: number;
  allocationPct: number;
  enabled: boolean;
}
export interface PortfolioStrategyAssignment extends PortfolioAllocationInput {
  snapshot: ConfirmedInvestmentStrategy;
}
export interface PortfolioAccountSummary {
  id: string;
  colorIndex: number;
  name: string;
  status: 'running' | 'paused' | 'archived';
  createdAt: string;
  policyRevision: number | null;
  equityUsd: string | null;
  cashBalance: string;
  strategyCount: number;
  companionId?: PortfolioCompanionId | null;
  companionRevision?: number;
}
export interface PortfolioAccountDetail extends PortfolioAccountSummary {
  investment: AiInvestmentView;
  combination: PortfolioCombination;
}
export interface CreatePortfolioAccountRequest extends InvestmentStartRequest {
  name: string;
}
export interface PortfolioAccountMutationRequest {
  expectedPolicyRevision: number;
  requestKey: string;
}
export interface ArchivePortfolioAccountRequest {
  expectedPolicyRevision: number | null;
  requestKey: string;
}
export interface ArchivePortfolioAccountResult {
  accountId: string;
  status: 'archived';
  policyRevision: number | null;
}
export interface RenamePortfolioAccountRequest extends PortfolioAccountMutationRequest {
  name: string;
}
export interface PortfolioCombinationRequest extends PortfolioAccountMutationRequest {
  allocations: PortfolioAllocationInput[];
}
export interface ApplyPortfolioCombinationRequest extends PortfolioCombinationRequest {
  previewHash: string;
}
export interface PortfolioCombinationIssue {
  code: string;
  strategyIds: string[];
  entryIds: string[];
  message: { en: string; 'zh-CN': string };
}
export interface PortfolioCombinationDraft {
  allocations: PortfolioAllocationInput[];
  expectedPolicyRevision: number;
  updatedAt: string;
}
export interface PortfolioCombination {
  accountId: string;
  policyRevision: number;
  allocations: PortfolioStrategyAssignment[];
  draft: PortfolioCombinationDraft | null;
  cashFloorPct: number;
}
export interface PortfolioCombinationPreview {
  accountId: string;
  expectedPolicyRevision: number;
  previewHash: string;
  expiresAt: string;
  canApply: boolean;
  allocations: PortfolioStrategyAssignment[];
  issues: PortfolioCombinationIssue[];
  cashFloorPct: number;
  allocatedPct: number;
}
export interface PortfolioAccountMutationResult {
  accountId: string;
  status: 'running' | 'paused' | 'archived';
  policy: InvestmentPolicy;
}
