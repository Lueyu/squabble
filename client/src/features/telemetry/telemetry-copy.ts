import type { TelemetryStatus } from '@shared/telemetry.interface';

export function statusLabel(status: TelemetryStatus, zh: boolean): string {
  const labels: Record<TelemetryStatus, [string, string]> = {
    queued: ['排队中', 'Queued'], running: ['运行中', 'Running'], completed: ['已完成', 'Completed'],
    failed: ['失败', 'Failed'], cancelled: ['已取消', 'Cancelled'], unknown: ['未知状态', 'Unknown status'],
  };
  return labels[status][zh ? 0 : 1];
}

export function sceneLabel(scene: string, zh: boolean): string {
  const labels: Record<string, [string, string]> = {
    council: ['研究室', 'Research room'], research: ['研究任务', 'Research'],
    daily: ['投资日报', 'Daily report'], portfolio: ['持仓研究', 'Portfolio research'],
    channel: ['股友频道', 'Companion channel'], model: ['模型请求', 'Model request'],
    native: ['本地 Agent', 'Native agent'],
  };
  return labels[scene]?.[zh ? 0 : 1] ?? scene;
}
