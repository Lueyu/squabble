/**
 * @file api/local-agents.ts
 * @description 本地智能体（本机运行的 companion/agent）连接与配对的 API 封装。
 *
 * 职责边界：
 *  - 只封装本地智能体的列表/状态/连接/断开/登录/配对调用
 *  - 设置面板的 UI 在 pages/Settings/LocalAgentsPanel，配对状态存取见
 *    utils/local-agent-settings.ts
 * 上下游：
 *  - 上游（谁调用这里）：pages/Settings/LocalAgentsPanel.tsx、pages/Council/useCouncilModels.ts、
 *    CouncilPage.tsx、CouncilNewDialog.tsx
 *  - 下游（本文件调用谁）：./http（axios 实例）
 * 关键约定：
 *  - 所有路径走 BASE_URL = '/api/settings/local-agents'；id 一律 encodeURIComponent 后拼路径
 */
import type {
  LocalAgentConnection,
  LocalAgentPairing,
  LocalAgentsStatus,
} from '@shared/local-agents.interface';
import http from './http';

// 共享类型的再导出：页面可直接从本模块 import type。
export type { LocalAgentConnection } from '@shared/local-agents.interface';

/** 本地智能体后端路由的公共前缀。 */
const BASE_URL = '/api/settings/local-agents';

/**
 * 列出已注册的本地智能体连接。
 * 对应 GET /api/settings/local-agents；LocalAgentsPanel 与 Council 的模型选择
 * （useCouncilModels）加载列表时调用。
 * @returns 本地智能体连接数组。
 */
export async function fetchLocalAgents(): Promise<LocalAgentConnection[]> {
  const response = await http.get<{ items: LocalAgentConnection[] }>(BASE_URL);
  return response.data.items;
}

/**
 * 读取本地智能体子系统状态（服务是否在线等）。
 * 对应 GET /api/settings/local-agents/status；LocalAgentsPanel 展示健康状态时调用。
 * @returns 状态对象。
 */
export async function fetchLocalAgentsStatus(): Promise<LocalAgentsStatus> {
  const response = await http.get<LocalAgentsStatus>(`${BASE_URL}/status`);
  return response.data;
}

/**
 * 连接一个本地智能体。
 * 对应 POST /api/settings/local-agents/{id}/connect；LocalAgentsPanel 点击连接时调用。
 * @param id - 智能体主键。
 * @returns `{ ok: true }` 表示连接指令已受理。
 */
export async function connectLocalAgent(id: string): Promise<{ ok: true }> {
  const response = await http.post<{ ok: true }>(`${BASE_URL}/${encodeURIComponent(id)}/connect`);
  return response.data;
}

/**
 * 断开一个本地智能体。
 * 对应 POST /api/settings/local-agents/{id}/disconnect；LocalAgentsPanel 点击断开时调用。
 * @param id - 智能体主键。
 * @returns `{ ok: true }` 表示断开指令已受理。
 */
export async function disconnectLocalAgent(id: string): Promise<{ ok: true }> {
  const response = await http.post<{ ok: true }>(
    `${BASE_URL}/${encodeURIComponent(id)}/disconnect`,
  );
  return response.data;
}

/**
 * 触发本地智能体的登录流程（如 OAuth/配对码）。
 * 对应 POST /api/settings/local-agents/{id}/login；LocalAgentsPanel 需要重新登录时调用。
 * @param id - 智能体主键。
 * @returns `{ ok: true }` 表示登录流程已启动。
 */
export async function loginLocalAgent(id: string): Promise<{ ok: true }> {
  const response = await http.post<{ ok: true }>(`${BASE_URL}/${encodeURIComponent(id)}/login`);
  return response.data;
}

/**
 * 创建一个新的本地 companion 配对请求。
 * 对应 POST /api/settings/local-agents/pairing；LocalAgentsPanel 生成配对码时调用。
 * @returns 配对信息（配对码/有效期）。
 */
export async function createLocalAgentPairing(): Promise<LocalAgentPairing> {
  const response = await http.post<LocalAgentPairing>(`${BASE_URL}/pairing`);
  return response.data;
}

/**
 * 断开已配对的本地 companion。
 * 对应 DELETE /api/settings/local-agents/companion；LocalAgentsPanel 解除配对时调用。
 * @returns `{ ok: true }` 表示解除成功。
 */
export async function disconnectLocalCompanion(): Promise<{ ok: true }> {
  const response = await http.delete<{ ok: true }>(`${BASE_URL}/companion`);
  return response.data;
}
