/**
 * @file api/builder.ts
 * @description 智能体 Builder（自动构建交易策略档案）的配置与提案 API 封装。
 *
 * 职责边界：
 *  - 只封装 Builder 档案（profiles）与提案（proposals）的 CRUD/运行调用
 *  - Builder 向导的状态机与表单逻辑在 pages/AgentBuilder，不在本文件
 * 上下游：
 *  - 上游（谁调用这里）：pages/AgentBuilder/AgentBuilderPage.tsx、BuilderWizard.tsx；
 *    fetchBuilderProfiles 另被 pages/Council/CouncilPage.tsx 复用
 *  - 下游（本文件调用谁）：./http（axios 实例）
 * 关键约定：
 *  - 所有路径走 BASE_URL = '/api/agent-builder'；id 一律 encodeURIComponent 后拼路径
 */
import http from './http';
import type {
  BuilderConfig,
  BuilderPreview,
  BuilderProfile,
  BuilderProposal,
  RecordBuilderFillDto,
} from '@shared/api.interface';

// 共享类型的再导出：页面可直接从本模块 import type。
export type {
  BuilderConfig,
  BuilderPreview,
  BuilderProfile,
  BuilderProposal,
} from '@shared/api.interface';

/** Builder 立即运行一次的执行结果（扫描数、信号、下单/拒绝数）。 */
export interface BuilderRunResult {
  scanned: number;
  signals: Array<{ ticker: string; side: 'buy' | 'sell'; reason: string }>;
  placed: number;
  rejected: number;
}

/** Builder 后端路由的公共前缀。 */
const BASE_URL = '/api/agent-builder';

/**
 * 列出全部 Builder 档案。
 * 对应 GET /api/agent-builder/profiles；AgentBuilderPage 加载列表、CouncilPage 复用时调用。
 * @returns Builder 档案数组。
 */
export async function fetchBuilderProfiles(): Promise<BuilderProfile[]> {
  const response = await http.get<{ items: BuilderProfile[] }>(`${BASE_URL}/profiles`);
  return response.data.items;
}

/**
 * 新建一个 Builder 档案。
 * 对应 POST /api/agent-builder/profiles；BuilderWizard 完成配置后保存时调用。
 * @param config - Builder 配置（universe、阈值、调度等）。
 * @returns 新建的档案。
 */
export async function createBuilderProfile(config: BuilderConfig): Promise<BuilderProfile> {
  const response = await http.post<BuilderProfile>(`${BASE_URL}/profiles`, { config });
  return response.data;
}

/**
 * 更新已有 Builder 档案（整份 PUT）。
 * 对应 PUT /api/agent-builder/profiles/{id}；BuilderWizard 编辑已有档案保存时调用。
 * @param id - 档案主键。
 * @param config - 新的完整配置。
 * @returns 更新后的档案。
 */
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

/**
 * 启用（激活）一个 Builder 档案。
 * 对应 POST /api/agent-builder/profiles/{id}/activate；AgentBuilderPage 档案开关时调用。
 * @param id - 档案主键。
 * @returns 更新后的档案。
 */
export async function activateBuilderProfile(id: string): Promise<BuilderProfile> {
  const response = await http.post<BuilderProfile>(
    `${BASE_URL}/profiles/${encodeURIComponent(id)}/activate`,
  );
  return response.data;
}

/**
 * 暂停一个 Builder 档案。
 * 对应 POST /api/agent-builder/profiles/{id}/pause；AgentBuilderPage 档案开关时调用。
 * @param id - 档案主键。
 * @returns 更新后的档案。
 */
export async function pauseBuilderProfile(id: string): Promise<BuilderProfile> {
  const response = await http.post<BuilderProfile>(
    `${BASE_URL}/profiles/${encodeURIComponent(id)}/pause`,
  );
  return response.data;
}

/**
 * 立即运行一次 Builder 档案（手动触发扫描+下单）。
 * 对应 POST /api/agent-builder/profiles/{id}/run；AgentBuilderPage 点击"运行"时调用。
 * @param id - 档案主键。
 * @returns 本轮执行结果（扫描数、信号、下单/拒绝数）。
 */
export async function runBuilderProfile(id: string): Promise<BuilderRunResult> {
  const response = await http.post<BuilderRunResult>(
    `${BASE_URL}/profiles/${encodeURIComponent(id)}/run`,
  );
  return response.data;
}

/**
 * 用给定配置做一次预演（不落库、不下单）。
 * 对应 POST /api/agent-builder/preview；BuilderWizard 在保存前预览效果时调用。
 * @param config - 待预览的 Builder 配置。
 * @returns 预览结果。
 */
export async function previewBuilder(config: BuilderConfig): Promise<BuilderPreview> {
  const response = await http.post<BuilderPreview>(`${BASE_URL}/preview`, { config });
  return response.data;
}

/**
 * 列出 Builder 生成的待处理提案。
 * 对应 GET /api/agent-builder/proposals；AgentBuilderPage 加载提案列表时调用。
 * @returns 提案数组。
 */
export async function fetchBuilderProposals(): Promise<BuilderProposal[]> {
  const response = await http.get<{ items: BuilderProposal[] }>(`${BASE_URL}/proposals`);
  return response.data.items;
}

/**
 * 跳过一条提案（不再推荐）。
 * 对应 POST /api/agent-builder/proposals/{id}/skip；AgentBuilderPage 提案"跳过"按钮时调用。
 * @param id - 提案主键。
 * @returns 更新后的提案。
 */
export async function skipBuilderProposal(id: string): Promise<BuilderProposal> {
  const response = await http.post<BuilderProposal>(
    `${BASE_URL}/proposals/${encodeURIComponent(id)}/skip`,
  );
  return response.data;
}

/**
 * 采纳提案并按用户填写的内容落地。
 * 对应 POST /api/agent-builder/proposals/{id}/fill；AgentBuilderPage 提案"采纳"表单提交时调用。
 * @param id - 提案主键。
 * @param fill - 用户补全/调整的字段。
 * @returns 更新后的提案。
 */
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
