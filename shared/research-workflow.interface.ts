import type { CouncilResponse } from './council.interface';
import type { MemoryContextInventory, ResearchMemoryRecall, ThesisCandidateInput } from './research-memory.interface';
import type { ResearchToolResult } from './research-tools.interface';

export type ResearchGoal = 'comprehensive' | 'financials' | 'peers' | 'valuation';
export type ResearchTaskKind = 'financials' | 'business' | 'valuation' | 'challenge' | 'summary';
export type ResearchTaskState = 'queued' | 'running' | 'submitted' | 'accepted' | 'needs_revision'
  | 'failed' | 'blocked' | 'cancelled' | 'uncertain';
export interface ResearchSkillPin { id: string; version: string; hash: string; context: string }
export interface ResearchWorkflowConfig {
  goal: ResearchGoal; peers: string[]; parallelism: 1 | 2; recallEnabled: boolean;
  memory?: ResearchMemoryRecall; reset?: boolean;
}
export interface ResearchDelivery {
  thesisCandidates?: ThesisCandidateInput[];
  valuation?: ResearchToolResult;
  researchStance?: 'positive' | 'balanced' | 'cautious';
  conclusion: string; evidenceIds: string[]; asOf: string; currency: string | null; units: string;
  assumptions: string[]; gaps: string[]; skillVersions: Array<{ id: string; version: string; hash: string }>;
  response: CouncilResponse;
}
export interface ResearchTaskAttempt {
  memory?: MemoryContextInventory;
  id: string; revision: number; kind: 'work' | 'review'; startedAt: string; finishedAt?: string;
  state: 'running' | 'succeeded' | 'failed' | 'cancelled' | 'uncertain';
  messageId: string; dispatched?: boolean; remoteTaskId?: string; remoteContextId?: string;
  reviewGroupId?: string;
  tokens?: number; externalAgent?: boolean; externalUsageUnknown?: boolean; error?: string;
  delivery?: ResearchDelivery; review?: { accepted: boolean; feedback: string };
}
export interface ResearchTask {
  id: string; key: ResearchTaskKind; sessionId: string; cycleId: string; revision: number; position: number;
  memberId: string; dependencies: ResearchTaskKind[]; state: ResearchTaskState; reason: string | null;
  attempts: ResearchTaskAttempt[]; delivery: ResearchDelivery | null; skills: ResearchSkillPin[];
  reworks: number; acceptedAttemptId: string | null; updatedAt: string;
}
export interface ResearchCoverage {
  /** Separate delivered-member coverage from the completeness of their original wire input. */
  independentDeliveriesComplete?: boolean;
  inputCorrection?: import('./simple-conversation.interface').DailyReportInputCorrection;
  executionPlan?: import('./report-execution-plan.interface').ReportExecutionPlan;
  executionPlanError?: 'missing' | 'invalid';
  reverseCheck?: import('./council.interface').DailyReverseCheck;
  goal: ResearchGoal; cycleId: string; revision: number; complete: boolean;
  tasks: Array<{ id: string; key: ResearchTaskKind; state: ResearchTaskState; acceptedAttemptId: string | null }>;
}
export interface ResearchWorkflowView {
  goal: ResearchGoal; peers: string[]; parallelism: 1 | 2; recallEnabled: boolean; memoryCount: number;
  tasks: ResearchTask[];
}
