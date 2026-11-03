import http from './http';
import type { StrategyRuntime } from '@shared/strategy.interface';
import type {
  BuilderConfig,
  BuilderPreview,
  BuilderProfile,
  BuilderProposal,
  RecordBuilderFillDto,
} from '@shared/api.interface';

export type { BuilderConfig, BuilderPreview, BuilderProfile, BuilderProposal } from '@shared/api.interface';

export interface BuilderRunResult {
  automation?: boolean;
  runtime?: StrategyRuntime;
  scanned: number;
  signals: Array<{ ticker: string; side: 'buy' | 'sell'; reason: string }>;
  placed: number;
  rejected: number;
}

const BASE_URL = '/api/agent-builder';

export async function fetchStrategyRuntime(id: string): Promise<StrategyRuntime> {
  const response = await http.get<StrategyRuntime>(`${BASE_URL}/profiles/${encodeURIComponent(id)}/automation`);
  return response.data;
}

export async function fetchBuilderProfiles(): Promise<BuilderProfile[]> {
  const response = await http.get<{ items: BuilderProfile[] }>(`${BASE_URL}/profiles`);
  return response.data.items;
}

export async function createBuilderProfile(config: BuilderConfig): Promise<BuilderProfile> {
  const response = await http.post<BuilderProfile>(`${BASE_URL}/profiles`, { config });
  return response.data;
}

export async function updateBuilderProfile(
  id: string,
  config: BuilderConfig,
): Promise<BuilderProfile> {
  const response = await http.put<BuilderProfile>(
    `${BASE_URL}/profiles/${encodeURIComponent(id)}`,
    { config },
  );
  return response.data;
}

export async function activateBuilderProfile(id: string): Promise<BuilderProfile> {
  const response = await http.post<BuilderProfile>(
    `${BASE_URL}/profiles/${encodeURIComponent(id)}/activate`,
  );
  return response.data;
}

export async function pauseBuilderProfile(id: string): Promise<BuilderProfile> {
  const response = await http.post<BuilderProfile>(
    `${BASE_URL}/profiles/${encodeURIComponent(id)}/pause`,
  );
  return response.data;
}

export async function runBuilderProfile(id: string): Promise<BuilderRunResult> {
  const response = await http.post<BuilderRunResult>(
    `${BASE_URL}/profiles/${encodeURIComponent(id)}/run`,
  );
  return response.data;
}

export async function previewBuilder(config: BuilderConfig): Promise<BuilderPreview> {
  const response = await http.post<BuilderPreview>(`${BASE_URL}/preview`, { config });
  return response.data;
}

export async function fetchBuilderProposals(): Promise<BuilderProposal[]> {
  const response = await http.get<{ items: BuilderProposal[] }>(`${BASE_URL}/proposals`);
  return response.data.items;
}

export async function skipBuilderProposal(id: string): Promise<BuilderProposal> {
  const response = await http.post<BuilderProposal>(
    `${BASE_URL}/proposals/${encodeURIComponent(id)}/skip`,
  );
  return response.data;
}

export async function fillBuilderProposal(
  id: string,
  fill: RecordBuilderFillDto,
): Promise<BuilderProposal> {
  const response = await http.post<BuilderProposal>(
    `${BASE_URL}/proposals/${encodeURIComponent(id)}/fill`,
    fill,
  );
  return response.data;
}
