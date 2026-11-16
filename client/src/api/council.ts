/**
 * @file api/council.ts
 * @description Council（多智能体委员会）会话与 LLM 预算的 API 封装。
 *
 * 职责边界：
 *  - 只封装会话 CRUD/消息/运行控制与预算读写；会话状态机在 hooks/use-council.ts 与
 *    utils/council-state.ts，页面组装在 pages/Council
 * 上下游：
 *  - 上游（谁调用这里）：hooks/use-council.ts → pages/Council/CouncilPage.tsx
 *  - 下游（本文件调用谁）：./http（axios 实例）
 * 关键约定：
 *  - postCouncilMessage 只投递用户消息；是否随后自动触发 run 由前端 council-state 决定
 */
import http from './http';
import type {
  CouncilSession,
  CreateCouncilSession,
  LlmBudgetSettings,
  LlmBudgetUsage,
} from '@shared/council.interface';

/**
 * 列出全部 Council 会话。
 * 对应 GET /api/council/sessions；CouncilPage 加载会话列表（useCouncilSessions）时调用。
 * @returns 会话数组。
 */
export async function fetchCouncilSessions(): Promise<CouncilSession[]> {
  const response = await http.get<{ items: CouncilSession[] }>('/api/council/sessions');
  return response.data.items;
}

/**
 * 按 id 获取单个会话（含消息历史）。
 * 对应 GET /api/council/sessions/{id}；CouncilPage 选中会话（useCouncilSession）时调用。
 * @param id - 会话主键。
 * @returns 会话详情。
 */
export async function fetchCouncilSession(id: string): Promise<CouncilSession> {
  const response = await http.get<CouncilSession>(
    `/api/council/sessions/${encodeURIComponent(id)}`,
  );
  return response.data;
}

/**
 * 新建一个 Council 会话。
 * 对应 POST /api/council/sessions；CouncilPage / CouncilNewDialog 创建会话时调用。
 * @param request - 会话创建参数（成员、话题等）。
 * @returns 新建的会话。
 */
export async function createCouncilSession(request: CreateCouncilSession): Promise<CouncilSession> {
  const response = await http.post<CouncilSession>('/api/council/sessions', request);
  return response.data;
}

/**
 * 向会话投递一条用户消息。
 * 对应 POST /api/council/sessions/{id}/messages；CouncilPage 发送消息
 * （useCouncilActions，经 shouldSendCouncilMessage 校验）时调用。
 * @param id - 会话主键。
 * @param content - 消息正文。
 * @returns 更新后的会话。
 */
export async function postCouncilMessage(id: string, content: string): Promise<CouncilSession> {
  const response = await http.post<CouncilSession>(
    `/api/council/sessions/${encodeURIComponent(id)}/messages`,
    { content },
  );
  return response.data;
}

/**
 * 让会话立即执行一轮委员发言（run）。
 * 对应 POST /api/council/sessions/{id}/run；CouncilPage 触发发言
 * （useCouncilActions，经 shouldStartCouncilAfterMessage 校验）时调用。
 * @param id - 会话主键。
 * @returns 更新后的会话。
 */
export async function runCouncilSession(id: string): Promise<CouncilSession> {
  const response = await http.post<CouncilSession>(
    `/api/council/sessions/${encodeURIComponent(id)}/run`,
  );
  return response.data;
}

/**
 * 暂停一个运行中的会话。
 * 对应 POST /api/council/sessions/{id}/pause；CouncilPage 暂停按钮时调用。
 * @param id - 会话主键。
 * @returns 更新后的会话。
 */
export async function pauseCouncilSession(id: string): Promise<CouncilSession> {
  const response = await http.post<CouncilSession>(
    `/api/council/sessions/${encodeURIComponent(id)}/pause`,
  );
  return response.data;
}

/**
 * 读取 LLM 预算设置（月度上限等）。
 * 对应 GET /api/llm-budget；Settings/BudgetPanel 加载时调用。
 * @returns 预算设置。
 */
export async function fetchLlmBudget(): Promise<LlmBudgetSettings> {
  const response = await http.get<LlmBudgetSettings>('/api/llm-budget');
  return response.data;
}

/**
 * 读取 LLM 预算的当前用量。
 * 对应 GET /api/llm-budget/usage；Settings/BudgetPanel 展示用量条时调用。
 * @returns 预算用量。
 */
export async function fetchLlmBudgetUsage(): Promise<LlmBudgetUsage> {
  const response = await http.get<LlmBudgetUsage>('/api/llm-budget/usage');
  return response.data;
}

/**
 * 保存 LLM 预算设置（整份 PUT）。
 * 对应 PUT /api/llm-budget；Settings/BudgetPanel 提交表单时调用。
 * @param settings - 新的预算设置。
 * @returns 保存后的预算设置。
 */
export async function saveLlmBudget(settings: LlmBudgetSettings): Promise<LlmBudgetSettings> {
  const response = await http.put<LlmBudgetSettings>('/api/llm-budget', settings);
  return response.data;
}
