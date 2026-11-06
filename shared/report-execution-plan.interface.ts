import type { StrategyDraftInput, StrategyExecutionPreview } from './user-investment-strategy.interface';

/** Proposed investor parameters, never an execution authorization or a statement of observed market facts. */
export interface ReportExecutionPlanInput {
  schemaVersion: 1;
  parameterOrigin: 'ai_proposed';
  strategy: StrategyDraftInput;
  evidenceIds: string[];
  gaps: string[];
  noTradeReason?: string;
}

/** Readiness means structurally reviewable. Only an explicit investor confirmation can authorize execution. */
export interface ReportExecutionPlan extends ReportExecutionPlanInput {
  readiness: 'ready' | 'needs_info' | 'no_trade';
  preview: StrategyExecutionPreview;
}
