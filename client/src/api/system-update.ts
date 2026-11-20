/**
 * @file api/system-update.ts
 * @description 系统自更新（Web 版在线升级）状态查询与触发 API 封装。
 *
 * 职责边界：
 *  - 只封装"查询更新状态 / 启动更新"两个调用；更新流程 UI 在 pages/Settings/SystemUpdateCard
 * 上下游：
 *  - 上游（谁调用这里）：pages/Settings/SystemUpdateCard.tsx
 *  - 下游（本文件调用谁）：./http（axios 实例）
 * 关键约定：
 *  - phase 的取值 idle/backingUp/updating/failed 由后端推进，前端仅展示
 */
import http from './http';

/** 系统自更新的状态快照。 */
export interface WebUpdateStatus {
  enabled: boolean;
  currentVersion: string;
  available: { version: string; releaseUrl: string } | null;
  phase: 'idle' | 'backingUp' | 'updating' | 'failed';
  error?: string;
}

/**
 * 查询系统自更新状态（是否启用、当前版本、可用更新、进行阶段）。
 * 对应 GET /api/system/update；SystemUpdateCard 轮询/加载时调用。
 * @returns 更新状态快照。
 */
export async function fetchWebUpdateStatus(): Promise<WebUpdateStatus> {
  const response = await http.get<WebUpdateStatus>('/api/system/update');
  return response.data;
}

/**
 * 启动一次系统自更新（后端会先做备份再升级）。
 * 对应 POST /api/system/update；SystemUpdateCard 点击"立即更新"时调用。
 * @returns `{ started: true, backup }`：backup 为备份目录标识。
 */
export async function startWebUpdate(): Promise<{ started: true; backup: string }> {
  const response = await http.post<{ started: true; backup: string }>('/api/system/update');
  return response.data;
}
