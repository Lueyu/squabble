import http from './http';
import type { AgentRunWithRating, BatchRunRequest, BatchRunResult } from '@shared/api.interface';

export async function runStockAnalysis(request: BatchRunRequest): Promise<BatchRunResult> {
  const response = await http<BatchRunResult>({
    url: '/api/multi-agent/runs/batch', method: 'POST', data: request,
  });
  return response.data;
}

export async function fetchRecentAnalysisRuns(): Promise<{ items: AgentRunWithRating[]; activeTotal: number }> {
  const [recent, active, awaiting] = await Promise.all([
    http<{ items: AgentRunWithRating[] }>({ url: '/api/multi-agent/runs', method: 'GET', params: { limit: 12 } }),
    http<{ items: AgentRunWithRating[]; total: number }>({ url: '/api/multi-agent/runs', method: 'GET', params: { activeOnly: true, limit: 100 } }),
    http<{ items: AgentRunWithRating[] }>({ url: '/api/multi-agent/runs', method: 'GET', params: { status: 'awaiting_human', limit: 100 } }),
  ]);
  const merged = new Map(recent.data.items.map(run => [run.id, run]));
  active.data.items.forEach(run => merged.set(run.id, run));
  awaiting.data.items.forEach(run => merged.set(run.id, run));
  const activeIds = new Set(active.data.items.map(run => run.id));
  const items = [...merged.values()].sort((a, b) => {
    return Number(activeIds.has(b.id)) - Number(activeIds.has(a.id))
      || Date.parse(b.createdAt) - Date.parse(a.createdAt);
  });
  return { items, activeTotal: active.data.total };
}

export async function cancelAnalysisRun(id: string): Promise<void> {
  await http({ url: `/api/multi-agent/runs/${id}/cancel`, method: 'POST' });
}
