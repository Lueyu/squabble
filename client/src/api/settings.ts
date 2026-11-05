import http from './http';
import type {
  IntegrationSettings,
  IntegrationTestResult,
  ModelRoute,
  UpdateFinancialIntegrationRequest,
  UpdateLlmIntegrationRequest,
} from '@shared/api.interface';

export type {
  IntegrationSettings,
  IntegrationTestResult,
  ModelRoute,
  UpdateFinancialIntegrationRequest,
  UpdateLlmIntegrationRequest,
} from '@shared/api.interface';

const BASE_URL = '/api/settings/integrations';

export async function fetchIntegrationSettings(): Promise<IntegrationSettings> {
  const response = await http.get<IntegrationSettings>(BASE_URL);
  return response.data;
}

export async function saveLlmIntegration(
  request: UpdateLlmIntegrationRequest,
): Promise<IntegrationSettings> {
  const response = await http.put<IntegrationSettings>(`${BASE_URL}/llm`, request);
  return response.data;
}

export async function saveLlmRoute(route: ModelRoute): Promise<IntegrationSettings> {
  const response = await http.put<IntegrationSettings>(`${BASE_URL}/llm-route`, route);
  return response.data;
}

export async function removeLlmIntegration(): Promise<IntegrationSettings> {
  const response = await http.delete<IntegrationSettings>(`${BASE_URL}/llm`);
  return response.data;
}

export async function testLlmIntegration(language?: 'zh-CN' | 'en'): Promise<IntegrationTestResult> {
  const response = await http.post<IntegrationTestResult>(`${BASE_URL}/llm/test`, { language });
  return response.data;
}

export async function saveFinancialIntegration(
  request: UpdateFinancialIntegrationRequest,
): Promise<IntegrationSettings> {
  const response = await http.put<IntegrationSettings>(`${BASE_URL}/financial`, request);
  return response.data;
}

export async function removeFinancialIntegration(): Promise<IntegrationSettings> {
  const response = await http.delete<IntegrationSettings>(`${BASE_URL}/financial`);
  return response.data;
}

export async function testFinancialIntegration(): Promise<IntegrationTestResult> {
  const response = await http.post<IntegrationTestResult>(`${BASE_URL}/financial/test`);
  return response.data;
}
