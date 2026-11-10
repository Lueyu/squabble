import type { StrategyDirective, UserInvestmentStrategy } from './user-investment-strategy.interface';

export type StrategyInterviewField = 'idea' | 'security' | 'condition' | 'amount' | 'frequency' | 'period';
export type InterviewText = { en: string; 'zh-CN': string };
/** Values become confirmed only through an explicit accept request. Free text is retained verbatim. */
export type StrategyInterviewValue =
  | { kind: 'idea'; text: string }
  | { kind: 'security'; ticker: string; side: 'buy' | 'sell' }
  | { kind: 'condition'; trigger: StrategyDirective['trigger'] }
  | { kind: 'amount'; quantity?: number; positionPct?: number }
  | { kind: 'frequency'; frequency: 'once' | 'per_trading_day' }
  | { kind: 'period'; startsAt: string; endsAt: string; timezone: string };
export interface StrategyInterviewMessage {
  id: string; role: 'user' | 'assistant'; text: string; field: StrategyInterviewField;
  localizedText?: InterviewText;
  createdAt: string; supersedesMessageId?: string;
}
export interface StrategyInterviewAnswer {
  field: StrategyInterviewField; value: StrategyInterviewValue; quote: string; sourceMessageId: string; confirmedAt: string;
}
export interface StrategyInterviewSuggestion {
  id: string; field: StrategyInterviewField; value: StrategyInterviewValue;
  quote: string; sourceMessageId: string; explanation: InterviewText;
}
export interface StrategyInterviewQuestion {
  field: StrategyInterviewField; text: InterviewText; help: InterviewText;
}
export interface StrategyInterviewExample {
  id: string; scenario: InterviewText; outcome: 'plan' | 'no_action' | 'wait'; explanation: InterviewText;
}
export interface StrategyInterviewState {
  messages: StrategyInterviewMessage[];
  confirmed: StrategyInterviewAnswer[];
  suggestions: StrategyInterviewSuggestion[];
  pending: StrategyInterviewQuestion[];
  currentQuestion: StrategyInterviewQuestion | null;
  review: { strategyId: string; strategyRevision: number; previewHash: string; interviewRevision: number } | null;
}
export interface StrategyInterviewView extends StrategyInterviewState {
  id: string; revision: number; accountId: string; baseStrategyId: string | null;
  status: 'draft' | 'review_ready'; createdAt: string; updatedAt: string;
  account: { id: string; name: string; policyRevision: number; limits: Record<string, number> };
}
export interface CreateStrategyInterviewInput {
  accountId: string; baseStrategyId?: string; message: string; requestKey: string;
}
export interface StrategyInterviewMutationInput { expectedRevision: number; requestKey: string }
export interface AnswerStrategyInterviewInput extends StrategyInterviewMutationInput {
  field: StrategyInterviewField; message: string;
}
export interface AcceptStrategyInterviewInput extends StrategyInterviewMutationInput { suggestionId: string }
export interface PreviewStrategyInterviewInput extends StrategyInterviewMutationInput { observationOnly?: boolean }
export interface StrategyInterviewPreview {
  interview: StrategyInterviewView; strategy: UserInvestmentStrategy; examples: StrategyInterviewExample[];
}
