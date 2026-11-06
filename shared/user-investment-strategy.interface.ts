import type { MandateRule, StrategyMandateInput } from './strategy-mandate.interface';
import type { ReportExecutionPlan } from './report-execution-plan.interface';

export type StrategySourceInput = { kind: 'report'; versionId: string; sectionId?: string } | { kind: 'message'; messageId: string };
/** Copied once from an owned, published report or released discussion message. */
export interface StrategySourceSnapshot {
  key: string; kind: StrategySourceInput['kind']; versionId?: string; sectionId?: string; messageId?: string; sessionId?: string;
  title: string; content: string; readableContent?: string; contentHash: string; ticker: string | null; createdAt: string; capturedAt: string;
  /** Revalidated proposal copied only from the owned immutable execution-strategy section. */
  executionPlan?: ReportExecutionPlan;
}
export interface StrategyNumericEvidence { field: string; value: number; quote: string }
/** Investor intent. Technical quote/slippage guards are supplied by the execution bridge, never invented as investment advice. */
export interface StrategyDirective {
  ticker: string; side: 'buy' | 'sell';
  trigger: { kind: 'price_lte' | 'price_gte' | 'always' | 'semantic'; price?: number; text?: string };
  /** Exact shares, or the TOTAL account position after the action; never an incremental order percentage. */
  quantity?: number; positionPct?: number; minPrice?: number; maxPrice?: number; stopLossPrice?: number;
  semanticAuthorized?: boolean;
  /** Exact editable entry text reviewed together with these fields. Any edit invalidates this binding. */
  reviewedText: string; numericEvidence: StrategyNumericEvidence[];
}
export interface StrategyEntry {
  id: string; text: string; ticker?: string; sourceKeys: string[];
  startsAt?: string; endsAt?: string; timezone?: string;
  directive?: StrategyDirective;
  /** Compatibility for an explicitly authored legacy measurable rule. */
  mandateRule?: MandateRule; mandateReviewedText?: string;
}
export interface StrategyDraftInput {
  title: string; body: string; timezone: string; startsAt: string; endsAt: string;
  entries: StrategyEntry[]; limits?: StrategyMandateInput['limits'];
}
export interface StrategyValidationIssue {
  code: string; entryIds: string[]; severity: 'error' | 'warning'; message: { en: string; 'zh-CN': string };
}
export interface CompiledStrategyDirective extends StrategyDirective {
  entryId: string; startsAt: string; endsAt: string; timezone: string; sourceKeys: string[]; route: 'direct' | 'ai';
}
export interface StrategyExecutionEntry {
  id: string; ticker: string | null; state: 'observation' | 'needs_review' | 'executable' | 'expired';
  startsAt: string; endsAt: string; timezone: string; explanation: { en: string; 'zh-CN': string };
}
export interface StrategyExecutionPreview {
  revision: number; contentHash: string; generatedAt: string; canConfirm: boolean;
  entries: StrategyExecutionEntry[]; directives: CompiledStrategyDirective[]; mandateRules: MandateRule[]; issues: StrategyValidationIssue[];
}
export interface UserInvestmentStrategy {
  id: string; revision: number; parentId: string | null; status: 'draft' | 'confirmed';
  content: StrategyDraftInput; sources: StrategySourceSnapshot[]; preview: StrategyExecutionPreview | null;
  createdAt: string; updatedAt: string; confirmedAt: string | null;
}
export interface StrategyPreparationError {
  code: string; message: { en: string; 'zh-CN': string };
}
/** Sanitized terminal failure stored in the existing preparation result JSON. */
export interface StrategyPreparationFailure { kind: 'preparation_failure'; error: StrategyPreparationError }
export type StrategyPreparationStatus = { status: 'none' }
  | { status: 'pending'; requestKey: string }
  | { status: 'succeeded'; requestKey: string; result: UserInvestmentStrategy }
  | { status: 'failed'; requestKey: string; error: StrategyPreparationError };
export interface ConfirmedInvestmentStrategy extends UserInvestmentStrategy {
  status: 'confirmed'; preview: StrategyExecutionPreview; confirmedAt: string;
}
export interface UserInvestmentStrategyWorkspace {
  current: ConfirmedInvestmentStrategy | null; drafts: UserInvestmentStrategy[]; history: UserInvestmentStrategy[];
  draftsCursor: string | null; historyCursor: string | null;
}
export interface UserInvestmentStrategyPage { items: UserInvestmentStrategy[]; nextCursor: string | null }
export interface UserInvestmentStrategyRevisionPage { items: UserInvestmentStrategy[]; nextBefore: number | null }
export interface StrategySourceAddition { source: StrategySourceSnapshot; entries: StrategyEntry[]; alreadyAdded: boolean }
