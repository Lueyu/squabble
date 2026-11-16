/**
 * @file api/settings.ts
 * @description 集成设置（LLM / 行情财经数据源）的读写与测试 API 封装。
 *
 * 职责边界：
 *  - 只封装集成设置（integrations）的读取、保存、移除与连通性测试
 *  - 设置面板 UI 在 pages/Settings/IntegrationSettingsPanel
 * 上下游：
 *  - 上游（谁调用这里）：pages/Settings/IntegrationSettingsPanel.tsx、
 *    pages/Analysis/AnalysisRunner.tsx、pages/Council/CouncilPage.tsx、useCouncilModels.ts
 *  - 下游（本文件调用谁）：./http（axios 实例）
 * 关键约定：
 *  - 所有路径走 BASE_URL = '/api/settings/integrations'；llm 与 financial 两个子域路径对称
 */
import http from './http';
import type {
  IntegrationSettings,
  IntegrationTestResult,
  UpdateFinancialIntegrationRequest,
  UpdateLlmIntegrationRequest,
} from '@shared/api.interface';

// 共享类型的再导出：页面可直接从本模块 import type。
export type {
  IntegrationSettings,
  IntegrationTestResult,
  UpdateFinancialIntegrationRequest,
  UpdateLlmIntegrationRequest,
} from '@shared/api.interface';

/** 集成设置后端路由的公共前缀。 */
const BASE_URL = '/api/settings/integrations';

/**
 * 读取当前集成设置（LLM + 财经数据源）。
 * 对应 GET /api/settings/integrations；IntegrationSettingsPanel 加载时调用。
 * @returns 集成设置对象。
 */
export async function fetchIntegrationSettings(): Promise<IntegrationSettings> {
  const response = await http.get<IntegrationSettings>(BASE_URL);
  return response.data;
}

/**
 * 保存 LLM 集成配置。
 * 对应 PUT /api/settings/integrations/llm；IntegrationSettingsPanel 提交 LLM 表单时调用。
 * @param request - LLM 集成配置。
 * @returns 保存后的完整集成设置。
 */
export async function saveLlmIntegration(
  request: UpdateLlmIntegrationRequest,
): Promise<IntegrationSettings> {
  const response = await http.put<IntegrationSettings>(`${BASE_URL}/llm`, request);
  return response.data;
}

/**
 * 移除 LLM 集成配置。
 * 对应 DELETE /api/settings/integrations/llm；IntegrationSettingsPanel 清除 LLM 配置时调用。
 * @returns 移除后的完整集成设置。
 */
export async function removeLlmIntegration(): Promise<IntegrationSettings> {
  const response = await http.delete<IntegrationSettings>(`${BASE_URL}/llm`);
  return response.data;
}

/**
 * 对 LLM 集成发起连通性测试。
 * 对应 POST /api/settings/integrations/llm/test；IntegrationSettingsPanel
 * 点击"测试"时调用。
 * @param language - 测试结果的展示语言。
 * @returns 测试结果（成功/失败与原因）。
 */
export async function testLlmIntegration(
  language?: 'zh-CN' | 'en',
): Promise<IntegrationTestResult> {
  const response = await http.post<IntegrationTestResult>(`${BASE_URL}/llm/test`, { language });
  return response.data;
}

/**
 * 保存财经数据源集成配置。
 * 对应 PUT /api/settings/integrations/financial；IntegrationSettingsPanel 提交财经表单时调用。
 * @param request - 财经集成配置。
 * @returns 保存后的完整集成设置。
 */
export async function saveFinancialIntegration(
  request: UpdateFinancialIntegrationRequest,
): Promise<IntegrationSettings> {
  const response = await http.put<IntegrationSettings>(`${BASE_URL}/financial`, request);
  return response.data;
}

/**
 * 移除财经数据源集成配置。
 * 对应 DELETE /api/settings/integrations/financial；IntegrationSettingsPanel 清除配置时调用。
 * @returns 移除后的完整集成设置。
 */
export async function removeFinancialIntegration(): Promise<IntegrationSettings> {
  const response = await http.delete<IntegrationSettings>(`${BASE_URL}/financial`);
  return response.data;
}

/**
 * 对财经数据源集成发起连通性测试。
 * 对应 POST /api/settings/integrations/financial/test；IntegrationSettingsPanel
 * 点击"测试"时调用。
 * @returns 测试结果（成功/失败与原因）。
 */
export async function testFinancialIntegration(): Promise<IntegrationTestResult> {
  const response = await http.post<IntegrationTestResult>(`${BASE_URL}/financial/test`);
  return response.data;
}
