import type { Market } from './api.interface';

/** Data only. Source, owner and authorship are assigned by the server. */
export interface MonitorCondition {
  conditionIndex: number;
  metric: 'price' | 'sma20' | 'rsi14' | 'volumeRatio';
  unit: 'USD' | 'HKD' | 'CNY' | 'points' | 'ratio';
  operator: 'lt' | 'lte' | 'gt' | 'gte';
  threshold: number; validFrom: string; validUntil: string;
  evidenceIds: string[]; rationale: string;
}
export interface ThesisReplacement { thesisId: string; version: number; reason: string }
export interface ResearchMonitorRule {
  id: string; thesisId: string; thesisVersion: number; version: number;
  ticker: string; market: Market; origin: 'agent-reviewed' | 'user';
  reportId: string; reportVersion: number; condition: MonitorCondition; enabled: boolean;
  lastObservation?: MonitorObservation | null;
  lastValidObservation?: MonitorObservation | null;
}
export interface MonitorObservation {
  state: 'clear' | 'breached' | 'unknown'; reason: string | null;
  observedAt: string | null; value: number | null; observationKey: string;
}
export interface ResearchMonitorEvent extends MonitorObservation {
  id: string; ruleId: string; ruleVersion: number; thesisVersion: number; createdAt: string;
}
export interface ResearchMonitorView {
  scope: 'enabled-paper-strategies';
  executionEligible: boolean;
  rules: ResearchMonitorRule[]; events: ResearchMonitorEvent[]; breached: boolean;
  configuration: 'configured' | 'unconfigured';
  unsupportedConditions: number[];
  replacement: ThesisReplacement | null;
  replacementState: 'none' | 'proposed' | 'reviewed' | 'stale';
}
export interface StrategyThesisDependency {
  thesisId: string; version: number; ticker: string; market: Market;
  origin: 'current-report' | 'recalled-memory' | 'previous-plan';
  previousPlanId?: string;
  replacementId?: string;
}
export interface StrategyMemoryInventory {
  state: 'ready' | 'legacy-no-structure' | 'archive-pending' | 'archive-failed' | 'archive-disabled' | 'unknown';
  dependencies: StrategyThesisDependency[];
  reason?: string;
}
