import { isAxiosError } from 'axios';
import { teamRunsApi } from '@/api/team-runs';
import { readTabRecovery, workspaceOwnerScope, writeTabRecovery } from '@/utils/workspace-tab-recovery';
import type { TeamRunAgreement, TeamRunAgreementInput, TeamRunAgreementPreview } from '@shared/team-run.interface';

export interface RunSetupRecord {
  key: string;
  payload: Omit<TeamRunAgreementInput, 'requestKey'>;
  preview?: TeamRunAgreementPreview;
  agreement?: TeamRunAgreement;
  authorized?: boolean;
  reviewRequired?: boolean;
}

export function readRunSetup(teamId: string): RunSetupRecord | null {
  const record = readTabRecovery(`team-run.${teamId}`) as RunSetupRecord | null;
  if (typeof record?.key !== 'string' || typeof record.payload?.teamVersionId !== 'string'
    || typeof record.payload.bindingId !== 'string' || !record.payload.budget) return null;
  return record;
}

export function saveRunSetup(teamId: string, record: RunSetupRecord | null): void {
  if (!writeTabRecovery(`team-run.${teamId}`, record) && record) {
    throw new Error('This browser could not retain the team startup request');
  }
}

export function runSetupOutcomeUnknown(error: unknown): boolean {
  if (!isAxiosError(error)) return false;
  const status = error.response?.status;
  return status === undefined || status === 408 || status === 429 || status >= 500;
}

export function runSetupNeedsReview(error: unknown): boolean {
  const data = (error as { response?: { data?: { code?: string; message?: string; error?: { code?: string; message?: string } } | string } })?.response?.data;
  const code = typeof data === 'string' ? data : data?.error?.code ?? data?.code ?? data?.error?.message ?? data?.message;
  return ['TEAM_PREVIEW_STALE', 'TEAM_PREVIEW_CONSUMED', 'PREVIEW_EXPIRED', 'SOURCE_CHANGED_REPREVIEW',
    'TEAM_REAPPROVAL_REQUIRED', 'TEAM_REVISION_CONFLICT'].includes(code ?? '');
}

export async function fetchRunSetupPreview(teamId: string, record: RunSetupRecord): Promise<RunSetupRecord> {
  const owner = workspaceOwnerScope();
  saveRunSetup(teamId, record);
  record.preview ??= await teamRunsApi.preview(teamId, { ...record.payload, requestKey: `${record.key}:preview` });
  if (workspaceOwnerScope() !== owner) throw new Error('Workspace session changed');
  saveRunSetup(teamId, record);
  return record;
}

/** Called from the explicit consent action. Checkpoint confirmation before sending start. */
export async function executeRunSetup(
  teamId: string,
  record: RunSetupRecord,
  api: Pick<typeof teamRunsApi, 'confirm' | 'start'> = teamRunsApi,
  retain: (record: RunSetupRecord) => void = next => saveRunSetup(teamId, next),
): Promise<TeamRunAgreement> {
  if (!record.preview || record.reviewRequired) throw new Error('Review the actual run rules first');
  const owner = workspaceOwnerScope();
  record.authorized = true;
  retain(record);
  if (!record.agreement) {
    record.agreement = await api.confirm(teamId, {
      requestKey: `${record.key}:confirm`,
      previewId: record.preview.previewId,
      previewHash: record.preview.previewHash,
    });
    if (workspaceOwnerScope() !== owner) throw new Error('Workspace session changed');
    retain(record);
  }
  const started = await api.start(teamId, { requestKey: `${record.key}:start`, expectedRevision: record.agreement.revision });
  if (workspaceOwnerScope() !== owner) throw new Error('Workspace session changed');
  return started;
}
