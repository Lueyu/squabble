/**
 * @file api/model-connections.ts
 * @description 模型连接（LLM 供应商凭据）的 CRUD 与连通性测试 API 封装。
 *
 * 职责边界：
 *  - 只封装模型连接的增删改查与测试；连接表单 UI 在 pages/Settings/ModelConnectionsPanel
 * 上下游：
 *  - 上游（谁调用这里）：pages/Settings/ModelConnectionsPanel.tsx、pages/Council/CouncilPage.tsx、
 *    pages/Council/useCouncilModels.ts
 *  - 下游（本文件调用谁）：./http（axios 实例）
 * 关键约定：
 *  - 所有路径走 BASE_URL = '/api/settings/model-connections'；id 一律 encodeURIComponent 后拼路径
 */
import http from './http';
import type { IntegrationTestResult } from '@shared/api.interface';
import type { ModelConnection, SaveModelConnection } from '@shared/model-connections.interface';

// 共享类型的再导出：页面可直接从本模块 import type。
export type { ModelConnection, SaveModelConnection } from '@shared/model-connections.interface';

/** 模型连接后端路由的公共前缀。 */
const BASE_URL = '/api/settings/model-connections';

/**
 * 列出全部模型连接。
 * 对应 GET /api/settings/model-connections；ModelConnectionsPanel 与 Council 的
 * 模型选择（useCouncilModels）加载列表时调用。
 * @returns 模型连接数组。
 */
export async function fetchModelConnections(): Promise<ModelConnection[]> {
  const response = await http.get<{ items: ModelConnection[] }>(BASE_URL);
  return response.data.items;
}

/**
 * 新建一个模型连接。
 * 对应 POST /api/settings/model-connections；ModelConnectionsPanel 提交新建表单时调用。
 * @param request - 连接配置（供应商、baseUrl、apiKey 等）。
 * @returns 新建的连接。
 */
export async function createModelConnection(
  request: SaveModelConnection,
): Promise<ModelConnection> {
  const response = await http.post<ModelConnection>(BASE_URL, request);
  return response.data;
}

/**
 * 更新已有模型连接（整份 PUT）。
 * 对应 PUT /api/settings/model-connections/{id}；ModelConnectionsPanel 保存编辑时调用。
 * @param id - 连接主键。
 * @param request - 新的完整连接配置。
 * @returns 更新后的连接。
 */
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

/**
 * 按 id 删除模型连接。
 * 对应 DELETE /api/settings/model-connections/{id}；ModelConnectionsPanel 删除连接时调用。
 * @param id - 连接主键。
 */
export async function removeModelConnection(id: string): Promise<void> {
  await http.delete(`${BASE_URL}/${encodeURIComponent(id)}`);
}

/**
 * 对指定连接发起连通性测试。
 * 对应 POST /api/settings/model-connections/{id}/test；ModelConnectionsPanel
 * 点击"测试"时调用（Council 页也会触达）。
 * @param id - 连接主键。
 * @param language - 测试结果的展示语言。
 * @returns 测试结果（成功/失败与原因）。
 */
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
