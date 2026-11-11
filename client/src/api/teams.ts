import http from './http';
import type { BindingPreviewInput, CommissionPreviewInput, ConfirmPreview, CreateTeamInput, DecisionInput, RecoveryInput, TeamArchivePreviewInput, TeamBinding, TeamBudgetLimitInput, TeamCommission, TeamCommissionDetail, TeamConnectionCheck, TeamConnectionCheckInput, TeamDecision, TeamDetail, TeamDisplayInput, TeamDraftInput, TeamLayoutInput, TeamListResult, TeamPage, TeamPreview, TeamPublishPreviewInput, TeamRevisionInput, TeamSourceGrant, TeamSourceGrantInput, TeamVersion } from '@shared/team-workspace.interface';

export interface TeamListFilters { q?: string; filter?: string; status?: string; cursor?: string; limit?: number }
export interface TeamCommandResult { commissionId: string; state: TeamCommission['state']; rootBudgetTaskId?: string; commissionRevision?: number; requestKey: string }
export interface TeamSourceGrantResult { grant: TeamSourceGrant; scopeRevision: number; requestKey: string }
export interface TeamBindingResult { team: TeamDetail; binding: TeamBinding | null; requestKey: string }
export interface TeamPublishResult { team: TeamDetail; version: TeamVersion; requestKey: string }
const base = '/api/teams';
function teamPath(id: string): string { if (!id.trim()) throw new Error('An explicit team is required.'); return `${base}/${encodeURIComponent(id)}`; }
function commissionPath(teamId: string, id: string): string { if (!id.trim()) throw new Error('An explicit commission is required.'); return `${teamPath(teamId)}/commissions/${encodeURIComponent(id)}`; }
export const teamKeys = {
  all: ['teams'] as const,
  list: (filters: TeamListFilters = {}) => ['teams', 'list', filters] as const,
  detail: (id: string) => ['teams', id, 'detail'] as const,
  versions: (id: string) => ['teams', id, 'versions'] as const,
  commissions: (id: string) => ['teams', id, 'commissions'] as const,
  commission: (id: string, commissionId: string) => ['teams', id, 'commission', commissionId] as const,
  decisions: (id: string) => ['teams', id, 'decisions'] as const,
  sources: (id: string) => ['teams', id, 'source-grants'] as const,
};
export const teamsApi = {
  list: async (params: TeamListFilters = {}) => (await http.get<TeamListResult>(base, { params })).data,
  detail: (id: string): Promise<TeamDetail> => { const path = teamPath(id); return http.get<TeamDetail>(path).then(response => response.data); },
  create: async (input: CreateTeamInput & { templateId?: string }) => (await http.post<TeamDetail>(base, input)).data,
  saveDisplay: async (id: string, input: TeamDisplayInput) => (await http.patch<TeamDetail>(`${teamPath(id)}/display`, input)).data,
  saveLayout: async (id: string, input: TeamLayoutInput) => (await http.put<TeamDetail>(`${teamPath(id)}/layout`, input)).data,
  saveDraft: async (id: string, input: TeamDraftInput) => (await http.put<TeamDetail>(`${teamPath(id)}/draft`, input)).data,
  versions: async (id: string, cursor?: string) => (await http.get<TeamPage<TeamVersion>>(`${teamPath(id)}/versions`, { params: { cursor } })).data,
  version: async (id: string, versionId: string) => (await http.get<TeamVersion>(`${teamPath(id)}/versions/${encodeURIComponent(versionId)}`)).data,
  checkConnections: async (id: string, input: TeamConnectionCheckInput) => (await http.post<{ items: TeamConnectionCheck[] }>(`${teamPath(id)}/connection-check`, input)).data,
  publishPreview: async (id: string, input: TeamPublishPreviewInput) => (await http.post<TeamPreview>(`${teamPath(id)}/publish-preview`, input)).data,
  publish: async (id: string, input: ConfirmPreview) => (await http.post<TeamPublishResult>(`${teamPath(id)}/publish`, input)).data,
  bindingPreview: async (id: string, input: BindingPreviewInput) => (await http.post<TeamPreview>(`${teamPath(id)}/binding-preview`, input)).data,
  binding: async (id: string, input: ConfirmPreview) => (await http.post<TeamBindingResult>(`${teamPath(id)}/binding`, input)).data,
  archivePreview: async (id: string, input: TeamArchivePreviewInput) => (await http.post<TeamPreview>(`${teamPath(id)}/archive-preview`, input)).data,
  archive: async (id: string, input: ConfirmPreview) => (await http.post<TeamBindingResult>(`${teamPath(id)}/archive`, input)).data,
  commissionPreview: async (id: string, input: CommissionPreviewInput) => (await http.post<TeamPreview>(`${teamPath(id)}/commission-preview`, input)).data,
  startCommission: async (id: string, input: ConfirmPreview) => (await http.post<TeamCommandResult>(`${teamPath(id)}/commissions`, input)).data,
  commissions: async (id: string, cursor?: string) => (await http.get<TeamPage<TeamCommission>>(`${teamPath(id)}/commissions`, { params: { cursor } })).data,
  commission: async (id: string, commissionId: string) => (await http.get<TeamCommissionDetail>(commissionPath(id, commissionId))).data,
  cancelCommission: async (id: string, commissionId: string, input: { requestKey: string; expectedCommissionRevision: number; reason: string }) => (await http.post<TeamCommandResult>(`${commissionPath(id, commissionId)}/cancel`, input)).data,
  recoverCommission: async (id: string, commissionId: string, input: RecoveryInput) => (await http.post<TeamCommandResult>(`${commissionPath(id, commissionId)}/recover`, input)).data,
  tightenBudget: async (id: string, commissionId: string, input: TeamBudgetLimitInput) => (await http.patch<TeamCommission>(`${commissionPath(id, commissionId)}/budget-limit`, input)).data,
  decisions: async (id: string, cursor?: string, proposalId?: string) => (await http.get<TeamPage<TeamDecision>>(`${teamPath(id)}/decisions`, { params: { cursor, proposalId } })).data,
  decide: async (id: string, input: DecisionInput) => (await http.post<TeamDecision>(`${teamPath(id)}/decisions`, input)).data,
  sources: async (id: string, cursor?: string) => (await http.get<TeamPage<TeamSourceGrant>>(`${teamPath(id)}/source-grants`, { params: { cursor } })).data,
  grantSource: async (id: string, input: TeamSourceGrantInput) => (await http.post<TeamSourceGrantResult>(`${teamPath(id)}/source-grants`, input)).data,
  revokeSource: async (id: string, grantId: string, input: TeamRevisionInput) => (await http.post<TeamSourceGrantResult>(`${teamPath(id)}/source-grants/${encodeURIComponent(grantId)}/revoke`, input)).data,
};
