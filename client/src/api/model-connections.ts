import http from './http';
import type { IntegrationTestResult } from '@shared/api.interface';
import type { ModelConnection, SaveModelConnection } from '@shared/model-connections.interface';

export type { ModelConnection, SaveModelConnection } from '@shared/model-connections.interface';

const BASE_URL = '/api/settings/model-connections';

export async function fetchModelConnections(): Promise<ModelConnection[]> {
  const response = await http.get<{ items: ModelConnection[] }>(BASE_URL);
  return response.data.items;
}

export async function createModelConnection(
  request: SaveModelConnection,
): Promise<ModelConnection> {
  const response = await http.post<ModelConnection>(BASE_URL, request);
  return response.data;
}

export async function updateModelConnection(
  id: string,
  request: SaveModelConnection,
): Promise<ModelConnection> {
  const response = await http.put<ModelConnection>(
    `${BASE_URL}/${encodeURIComponent(id)}`,
    request,
  );
  return response.data;
}

export async function removeModelConnection(id: string): Promise<void> {
  await http.delete(`${BASE_URL}/${encodeURIComponent(id)}`);
}

export async function testModelConnection(
  id: string,
  language?: 'zh-CN' | 'en',
): Promise<IntegrationTestResult> {
  const response = await http.post<IntegrationTestResult>(
    `${BASE_URL}/${encodeURIComponent(id)}/test`,
    { language },
  );
  return response.data;
}
