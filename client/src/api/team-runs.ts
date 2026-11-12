import http from './http';
import type { TeamRunStatus, TeamRunAgreementInput, TeamRunAgreementPreview, TeamRunAgreement, TeamRunControlInput } from '@shared/team-run.interface';
import type { ConfirmPreview } from '@shared/team-workspace.interface';
const base = (id: string) => `/api/teams/${encodeURIComponent(id)}/run-agreement`;
export const teamRunsApi = {
  status: async (id: string) => (await http.get<TeamRunStatus>(base(id))).data,
  preview: async (id: string, input: TeamRunAgreementInput) => (await http.post<TeamRunAgreementPreview>(`${base(id)}/preview`, input)).data,
  confirm: async (id: string, input: ConfirmPreview) => (await http.post<TeamRunAgreement>(`${base(id)}/confirm`, input)).data,
  start: async (id: string, input: TeamRunControlInput) => (await http.post<TeamRunAgreement>(`${base(id)}/start`, input)).data,
  pause: async (id: string, input: TeamRunControlInput) => (await http.post<TeamRunAgreement>(`${base(id)}/pause`, input)).data,
  resume: async (id: string, input: TeamRunControlInput) => (await http.post<TeamRunAgreement>(`${base(id)}/resume`, input)).data,
};
