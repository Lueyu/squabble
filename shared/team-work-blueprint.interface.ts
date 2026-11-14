/**
 * Versioned research-division blueprint.
 * This is a publishable data contract: the server-side pure compiler
 * (server/modules/teams/team-work-blueprint.ts) is the only interpreter.
 * A blueprint never grants data, tool or trading authority by itself.
 */
import type { ResearchSourceRef } from './team-workspace.interface';

export const TEAM_BLUEPRINT_TASK_KINDS = ['financials', 'business', 'valuation', 'challenge', 'specialist'] as const;
export type TeamBlueprintTaskKind = (typeof TEAM_BLUEPRINT_TASK_KINDS)[number];
export type TeamBlueprintReviewMode = 'independent' | 'self_check';
export interface TeamBlueprintWork {
  workId: string;
  roleId: string;
  taskKind: TeamBlueprintTaskKind;
  objective: string;
  expectedOutput: string;
  dependencyWorkIds: string[];
  reviewerRoleId: string;
  reviewMode: TeamBlueprintReviewMode;
}
export interface TeamWorkBlueprint {
  schemaVersion: 1;
  works: TeamBlueprintWork[];
  summary: { reviewerRoleId: string; reviewMode: TeamBlueprintReviewMode; expectedOutput: string };
}
export type TeamWorkPlanMode = 'blueprint_v1' | 'manual_custom' | 'legacy_run_v1';
export interface TeamWorkPlanProof {
  mode: TeamWorkPlanMode;
  compilerVersion: string;
  semanticHash: string;
  blueprintHash: string | null;
}
/** Bounded, field-level structural findings for the draft preview. */
export interface BlueprintDiagnostic {
  code: string; field: string; message: string;
  roleId?: string; workId?: string; relationId?: string;
}
/** A structurally compiled research item; keys are stable aliases until the final input snapshot is frozen. */
export interface CompiledBlueprintWork {
  workKey: string;
  roleId: string;
  taskKind: 'financials' | 'business' | 'valuation' | 'challenge' | 'summary' | 'specialist';
  objective: string;
  expectedOutput: string;
  dependencyWorkKeys: string[];
  reviewerRoleId: string;
  reviewMode: TeamBlueprintReviewMode;
  inputRefs: [];
  requestedByRoleIds: string[];
}
export interface CompiledBlueprint {
  participantRoleIds: string[];
  leadRoleId: string;
  work: CompiledBlueprintWork[];
  minimumCallCount: number;
  unusedReviewRelationIds: string[];
  nonParticipatingRoleIds: string[];
  blueprintHash: string;
}
