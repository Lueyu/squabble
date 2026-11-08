import http from './http';
import type { Market } from '@shared/api.interface';
import type { AiInvestmentView, AiInvestmentPreview, InvestmentConstraint, InvestmentPolicy, InvestmentStartRequest } from '@shared/investment-policy.interface';
import type { ActualExecutor } from '@shared/simple-conversation.interface';
import type { ReportReference } from '@shared/research-document.interface';

export interface ConstraintProposal {
  id: string; accountId: string; expectedPolicyRevision: number; constraint: InvestmentConstraint | null;
  text: string; impact: string; needsInput: string[]; expiresAt: string; state: string;
}
export interface InvestmentDecision {
  strategy?: { id: string; revision: number; title: string; entryId: string; text: string; route: string | null } | null;
  actualExecutors: ActualExecutor[]; evidence: ReportReference[]; discussionId: string | null;
  actualResearch: Array<{ ticker: string; reason?: string;
    drafts?: Array<{ memberId: string; draft: { summary: string; unresolvedDisagreements?: string[] } }>;
    reviews?: Array<{ memberId: string; summary: string; unresolvedDisagreements: string[]; completedAt?: string }> }>;
}
export const fetchAiInvestment = async (): Promise<AiInvestmentView> => (await http.get('/api/ai-investment')).data;
export const fetchInvestmentDecision = async (id: string): Promise<InvestmentDecision> =>
  (await http.get(`/api/ai-investment/decisions/${encodeURIComponent(id)}`)).data;
export const previewAiInvestment = async (input: { origin: 'holdings' | 'cash'; cash?: { amount: number; currency: 'USD' | 'HKD' | 'CNY' }; requestKey: string }): Promise<AiInvestmentPreview> =>
  (await http.post('/api/ai-investment/preview', input, input.origin === 'holdings' ? { timeout: 60_000 } : undefined)).data;
export const startAiInvestment = async (input: InvestmentStartRequest): Promise<{ status: string; policy: InvestmentPolicy; evaluationState: string }> =>
  (await http.post('/api/ai-investment/start', input)).data;
export const restartAiInvestment = async (input: InvestmentStartRequest & { expectedAccountId: string }) =>
  (await http.post('/api/ai-investment/restart', input)).data;
export const pauseAiInvestment = async (input: { expectedRevision: number; requestKey: string }) =>
  (await http.post('/api/ai-investment/pause', input)).data;
export const resumeAiInvestment = async (input: { expectedRevision: number; requestKey: string }) =>
  (await http.post('/api/ai-investment/resume', input)).data;
export const pauseLegacyInvestment = async (accountId: string, requestKey: string) =>
  (await http.post(`/api/ai-investment/legacy/${encodeURIComponent(accountId)}/pause`, { requestKey })).data;
export const proposeInvestmentConstraint = async (input: { text: string; requestKey: string; sessionId?: string; constraint?: InvestmentConstraint }): Promise<ConstraintProposal> =>
  (await http.post('/api/ai-investment/constraints/propose', input)).data;
export const confirmInvestmentConstraint = async (id: string, input: { expectedPolicyRevision: number; requestKey: string }) =>
  (await http.post(`/api/ai-investment/constraints/${encodeURIComponent(id)}/confirm`, input)).data;
export const revokeInvestmentConstraint = async (id: string, input: { expectedPolicyRevision: number; requestKey: string }) =>
  (await http.post(`/api/ai-investment/constraints/${encodeURIComponent(id)}/revoke`, input)).data;

export const marketLabel = (market: Market, zh: boolean) => ({ US: zh ? '美股' : 'US', HK: zh ? '港股' : 'Hong Kong', CN: zh ? 'A股' : 'China A' })[market];

export const applyInvestmentStrategy = async (input: { strategyId: string; expectedRevision: number; previewHash: string; expectedCurrentId: string | null; requestKey: string }) =>
  (await http.post('/api/ai-investment/apply-strategy', input)).data;

/** One-click: ensure the simulation account exists, import the report strategy and apply it. */
export const quickApplyReport = async (input: { versionId: string; requestKey: string }): Promise<{ status: string; policy: InvestmentPolicy; evaluationState: string }> =>
  (await http.post('/api/ai-investment/quick-apply', input)).data;
