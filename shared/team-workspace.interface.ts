/** Team workspace wire contract. UI geometry never conveys execution authority. */
export const TEAM_STATUSES = ['active', 'archived'] as const;
export type TeamStatus = (typeof TEAM_STATUSES)[number];
export const TEAM_COMMISSION_STATES = ['queued', 'running', 'awaiting_review', 'completed', 'partial', 'blocked', 'failed', 'cancelling', 'cancelled', 'uncertain'] as const;
export type TeamCommissionState = (typeof TEAM_COMMISSION_STATES)[number];
export type TeamExecutionChoice = 'keep_confirmed_rules' | 'pause_all';
export interface TeamMoney { amount: string | null; currency: string }
export type TeamExecutor =
  | { executionMode: 'model'; connectionId: string; model: string; tier?: string; settings: Record<string, unknown> }
  | { executionMode: 'local'; localAgentId: string; settings: Record<string, unknown> };
export interface TeamDepartment { id: string; parentDepartmentId: string | null; purpose: string }
export interface TeamRole {
  id: string; departmentId: string | null; participation: 'placeholder' | 'enabled';
  responsibility: string; expectedOutput: string; executor: TeamExecutor | null;
  allowedToolIds: string[]; sourceGrantIds: string[];
}
export interface TeamRelation {
  id: string; fromRoleId: string; toRoleId: string;
  kind: 'reports_to' | 'delegates_to' | 'reviews'; responsibilityScope: string;
}
export interface TeamSemanticConfig {
  schemaVersion: 1; departments: TeamDepartment[]; roles: TeamRole[]; relations: TeamRelation[];
  defaults: { leadRoleId: string | null; parallelism: 1 | 2 };
}
export interface TeamDisplay {
  name: string; avatar: string | null;
  departmentLabels: Record<string, string>; roleLabels: Record<string, string>;
}
export interface TeamLayout {
  schemaVersion: 1;
  positions: Record<string, { x: number; y: number; width?: number; height?: number }>;
  collapsedDepartmentIds: string[]; viewport: { x: number; y: number; zoom: number };
}
export interface TeamGuardSet {
  semanticRevision: number; currentVersionId: string | null;
  bindingRevision: number; bindingId: string | null; scopeRevision: number;
  accountPolicyRevision: number | null; accountAssignmentRevision: number | null;
  capabilityFingerprint: string | null;
  sourceFingerprints: { sourceId: string; revision: string; fingerprint: string }[];
  executorFingerprints: { roleId: string; fingerprint: string }[];
}
export interface TeamPreview<T = Record<string, unknown>> {
  previewId: string; previewHash: string; expiresAt: string; compilerVersion: string;
  guards: TeamGuardSet; result: T;
  warnings: { code: string; message: string; roleId?: string }[];
}
export interface ConfirmPreview { requestKey: string; previewId: string; previewHash: string }
export interface TeamVersion {
  id: string; teamId: string; version: number; semanticRevision: number;
  semanticHash: string; config: TeamSemanticConfig; displaySnapshot: TeamDisplay; createdAt: string;
}
export interface TeamDraft { semanticRevision: number; baseVersionId: string | null; config: TeamSemanticConfig }
export interface TeamBinding {
  id: string; teamId: string; accountId: string; bindingRevision: number; teamVersionId: string;
  state: 'active' | 'superseded' | 'released' | 'archived'; previousBindingId: string | null;
  effectiveFrom: string; effectiveTo: string | null; executionChoice: TeamExecutionChoice;
}
export interface TeamCapabilities { workspaceEnabled: boolean; researchEnabled: boolean }
export interface TeamCostSummary {
  confirmed: TeamMoney; reserved: TeamMoney; estimatedMaximum: TeamMoney;
  externalUsageUnknown: boolean; unknownAttemptIds: string[];
}
export interface TeamSummary {
  id: string; name: string; description: string; avatar: string | null; status: TeamStatus;
  displayRevision: number; layoutRevision: number; semanticRevision: number;
  bindingRevision: number; scopeRevision: number; currentVersionId: string | null;
  currentVersion: number | null; accountId: string | null; binding: TeamBinding | null;
  roleCount: number; departmentCount: number; runningCommissionCount: number;
  hasDraft: boolean; connectionCount: number;
  cost: TeamCostSummary; equityUsd: string | null; createdAt: string; updatedAt: string;
}
export interface TeamDetail extends TeamSummary {
  display: TeamDisplay; layout: TeamLayout; draft: TeamDraft;
  publishedVersion: TeamVersion | null; capabilities: TeamCapabilities;
}
export interface TeamPage<T> { items: T[]; nextCursor: string | null }
export interface TeamListResult extends TeamPage<TeamSummary> { capabilities: TeamCapabilities }
export interface CreateTeamInput {
  requestKey: string; name: string; description?: string; avatar?: string | null; copyFromTeamVersionId?: string; templateId?: string;
}
export interface TeamDisplayInput { requestKey: string; expectedDisplayRevision: number; display: TeamDisplay }
export interface TeamLayoutInput { requestKey: string; expectedLayoutRevision: number; layout: TeamLayout }
export interface TeamDraftInput { requestKey: string; expectedSemanticRevision: number; config: TeamSemanticConfig }
export interface TeamPublishPreviewInput { requestKey: string; expectedSemanticRevision: number }
export interface TeamConnectionCheckInput { requestKey: string; semanticRevision: number; roleIds: string[] }
export interface TeamConnectionCheck {
  roleId: string; status: 'supported' | 'unsupported' | 'unknown' | 'offline';
  checkedAt: string; fingerprint: string | null; capabilities: string[]; evidence: string;
}
export interface BindingPreviewInput {
  requestKey: string; action: 'assign' | 'release'; accountId: string; teamVersionId: string;
  expectedBindingRevision: number; expectedAccountBindingId: string | null;
  executionChoice: TeamExecutionChoice; acknowledgePendingReapproval: true;
}
export interface TeamArchivePreviewInput {
  requestKey: string; expectedBindingRevision: number; expectedCurrentVersionId: string | null;
  executionChoice?: TeamExecutionChoice;
}
export interface ResearchSourceRef {
  kind: 'report_version' | 'thesis_version' | 'document_version' | 'data_snapshot';
  id: string; revision: string; availability: 'available' | 'revoked' | 'deleted' | 'missing';
}
export interface TeamWorkItem {
  workKey: string; roleId: string;
  taskKind: 'financials' | 'business' | 'valuation' | 'challenge' | 'summary' | 'specialist';
  objective: string; expectedOutput: string; dependencyWorkKeys: string[];
  reviewerRoleId: string; reviewMode: 'independent' | 'self_check';
  inputRefs: ResearchSourceRef[]; requestedByRoleIds: string[];
}
export interface TeamBudget {
  budgetMode: 'cost_and_calls' | 'calls_only'; ceiling: TeamMoney;
  callLimit: number; paidRevisionLimit: number;
}
export interface TeamCommissionPlan {
  schemaVersion: 1; leadRoleId: string; participantRoleIds: string[];
  objective: string; expectedOutput: string; dataCutoffAt: string; deadlineAt: string;
  supervisorRoleIds: string[]; work: TeamWorkItem[]; parallelism: 1 | 2;
  conflictResolutions: { instructionIds: string[]; choice: string; reason: string }[];
  budget: TeamBudget;
}
export interface CommissionPreviewInput extends Omit<TeamCommissionPlan, 'schemaVersion' | 'dataCutoffAt'> {
  requestKey: string; teamVersionId: string; bindingId: string; expectedBindingRevision: number;
  dataCutoffAt: string | null; inputRefs: ResearchSourceRef[];
}
export interface TeamMemberSnapshot {
  roleId: string; memberId: string; teamVersionId: string; label: string;
  responsibility: string; expectedOutput: string; executor: TeamExecutor;
  executorConfigRevision: string; capabilityFingerprint: string;
  allowedToolIds: string[]; sourceGrantIds: string[]; scopeRevision: number;
}
export interface TeamExecutionContext {
  audience: 'team'; ownerId: string; teamId: string; teamVersionId: string;
  commissionId: string; accountId: string; bindingId: string; bindingRevision: number;
  scopeRevision: number; deadlineAt: string; dataCutoffAt: string;
  plan: TeamCommissionPlan; members: TeamMemberSnapshot[]; inputSnapshot: Record<string, unknown>;
}
export interface TeamResearchLink {
  id: string; kind: 'task' | 'attempt' | 'report_version' | 'thesis_version' | 'strategy_revision' | 'signal' | 'order' | 'trade';
  targetId: string; targetRevision: string | null;
  relation: 'produced' | 'reviewed' | 'used' | 'derived' | 'executed';
  workKey: string | null; attemptId: string | null; metadata: Record<string, unknown>;
}
export interface TeamCommission {
  id: string; teamId: string; accountId: string; bindingId: string; bindingRevision: number;
  teamVersionId: string; scopeRevision: number; commissionRevision: number;
  state: TeamCommissionState; plan: TeamCommissionPlan; inputSnapshot: Record<string, unknown>;
  members: TeamMemberSnapshot[]; rootBudgetTaskId: string; sessionId: string | null; cycleId: string | null;
  budgetLimit: TeamBudget; budgetLimitRevision: number; cost: TeamCostSummary;
  lastError: Record<string, unknown> | null; cancelRequestedAt: string | null;
  completedAt: string | null; createdAt: string; updatedAt: string;
}
export interface TeamCommissionDetail extends TeamCommission { links: TeamResearchLink[]; decisions: TeamDecision[]; tasks?: import('./research-workflow.interface').ResearchTask[] }
export type RecoveryInput = { requestKey: string; expectedCommissionRevision: number } & (
  | { action: 'check_existing'; workKey?: string; attemptId?: string }
  | { action: 'reparse_existing'; workKey: string; attemptId: string }
  | { action: 'retry_work' | 'retry_review'; workKey: string; attemptId: string; acknowledgePaidRetry: true; reason: string }
);
export interface TeamBudgetLimitInput { requestKey: string; expectedCommissionRevision: number; ceiling?: TeamMoney; callLimit?: number }
export interface TeamDecisionBasis {
  teamVersionId: string; bindingId: string; bindingRevision: number; commissionId: string;
  sessionId: string; cycleId: string; workKey: string; acceptedAttemptId: string;
  reportVersionId: string | null; thesisVersions: { thesisId: string; versionId: string }[];
  sourceRefs: ResearchSourceRef[];
}
export interface TeamDecisionRef { proposalId: string; proposalRevision: number; decisionId: string }
export interface DecisionInput {
  requestKey: string; proposalId?: string; expectedProposalRevision: number; commissionId: string;
  event: 'propose' | 'observe' | 'defer' | 'reject' | 'adopt'; basis: TeamDecisionBasis;
  reason: string; proposedPolicyDraftId?: string;
}
export interface TeamDecision {
  id: string; teamId: string; accountId: string; commissionId: string | null;
  proposalId: string; proposalRevision: number;
  event: DecisionInput['event'] | 'requires_reapproval' | 'applied' | 'continue_policy';
  actorType: 'user' | 'agent' | 'system'; actorId: string; basis: TeamDecisionBasis;
  reason: string; policyContext: Record<string, unknown> | null; createdAt: string;
}
export interface TeamSourceGrant {
  id: string; teamId: string; sourceRef: ResearchSourceRef; state: 'active' | 'revoked';
  grantedAt: string; revokedAt: string | null; reason: string | null;
}
export interface TeamSourceGrantInput { requestKey: string; expectedScopeRevision: number; sourceRef: ResearchSourceRef }
export interface TeamRevisionInput { requestKey: string; expectedScopeRevision: number; reason: string }
export const TEAM_ERROR_CODES = ['TEAM_INVALID_INPUT', 'TEAM_GRAPH_INVALID', 'TEAM_NOT_FOUND', 'TEAM_REFERENCE_NOT_FOUND', 'TEAM_REVISION_CONFLICT', 'TEAM_REQUEST_KEY_CONFLICT', 'TEAM_PREVIEW_STALE', 'TEAM_PREVIEW_CONSUMED', 'TEAM_BINDING_CONFLICT', 'TEAM_REAPPROVAL_REQUIRED', 'TEAM_EXECUTION_UNCERTAIN', 'TEAM_CAPABILITY_UNAVAILABLE', 'TEAM_PLAN_INVALID', 'TEAM_SOURCE_UNAVAILABLE', 'TEAM_SCOPE_REVOKED', 'TEAM_BUDGET_BLOCKED', 'TEAM_DEPENDENCY_UNAVAILABLE'] as const;
export type TeamErrorCode = (typeof TEAM_ERROR_CODES)[number];
