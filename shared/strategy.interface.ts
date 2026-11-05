import type { Market, PaperSide } from './api.interface';

/** Explicit opt-in. Existing Builder profiles retain their previous execution mode. */
export interface StrategyAutomationConfig {
  enabled: boolean;
  preOpenMinutes: number;
  monitorSeconds: number;
  eventReplanCooldownMinutes: number;
  maxEventReplansPerDay: number;
  notifyClosingSummary: boolean;
  /** Independent reviewer; omitted uses the account's fast model connection. */
  fastReviewer?: import('./council.interface').CouncilMember;
}
export const DEFAULT_STRATEGY_AUTOMATION: StrategyAutomationConfig = {
  enabled: false, preOpenMinutes: 60, monitorSeconds: 60,
  eventReplanCooldownMinutes: 120, maxEventReplansPerDay: 1, notifyClosingSummary: false,
};
export const STRATEGY_TRIGGER_KINDS = ['price_above', 'price_below', 'sma20_above', 'sma20_below',
  'rsi14_above', 'rsi14_below', 'volume_ratio_above'] as const;
export type StrategyTriggerKind = typeof STRATEGY_TRIGGER_KINDS[number];
export interface StrategyRule {
  /** A bounded daily review may suspend an entry without discarding its protective stop. */
  dailySuspended?: boolean;
  id: string;
  ticker: string;
  side: PaperSide;
  trigger: { kind: StrategyTriggerKind; value: number };
  referencePrice: number;
  minPrice: number;
  maxPrice: number;
  maxPositionPct: number;
  stopLossPrice: number;
  expiresAt: string;
  evidenceIds: string[];
  rationale: string;
}
export interface DailyStrategyPlan {
  parentPolicyId?: string; parentPolicyRevision?: number; cycleId?: string;
  accountId?: string | null;
  mandateId?: string | null;
  mandateVersion?: number | null;
  memoryInventory?: import('./research-monitor.interface').StrategyMemoryInventory | null;
  id: string; profileId: string; profileVersion: number; version: number;
  market: Market; marketDate: string; status: 'active' | 'superseded' | 'expired';
  rules: StrategyRule[]; sessionIds: string[]; reportIds: string[];
  summary: string; createdAt: string; expiresAt: string;
}
export interface StrategyMarketRuntime {
  market: Market; marketDate: string | null;
  state: 'waiting' | 'discussing' | 'ready' | 'monitoring' | 'blocked' | 'stopped';
  nextDiscussionAt: string | null; lastCheckAt: string | null;
  lastQuoteAt: string | null; reason: string; currentPlan: DailyStrategyPlan | null;
}
export interface StrategyRuntime {
  enabled: boolean; profileId: string; profileVersion: number;
  markets: StrategyMarketRuntime[];
  notification: { pending: number; failed: number; lastDeliveredAt: string | null };
}
export interface StrategyCandidate {
  parentPolicyId?: string; parentPolicyRevision?: number; cycleId?: string;
  accountId?: string;
  mandateId?: string;
  mandateVersion?: number;
  notionalUsd?: number;
  signalId: string; planId: string; planVersion: number; ruleId: string;
  ticker: string; market: Market; side: PaperSide; quantity: number;
  price: number; quoteAt: string; protectiveStop: boolean; reason: string;
  protectionId?: string;
  protectionVersion?: number;
  reviewAttempt?: number;
}
