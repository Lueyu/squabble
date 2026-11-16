/**
 * @file api/analysis-runner.ts
 * @description 触发与查询多智能体研究 run 的分析入口封装（Analysis 页面专用）。
 *
 * 职责边界：
 *  - 只封装"发起分析 / 拉取近期 run / 取消 run"三类调用，run 列表的通用查询在 api/index.ts
 * 上下游：
 *  - 上游（谁调用这里）：pages/Analysis/AnalysisRunner.tsx（单票分析、全组合分析、
 *    最近 run 列表 queryFn、取消 run mutationFn）
 *  - 下游（本文件调用谁）：./http（axios 实例）
 * 关键约定：
 *  - fetchRecentAnalysisRuns 一次并发 3 个查询（近期/活跃/待人工审核）后合并排序，
 *    修改排序逻辑前先看后端 total 语义
 */
import http from './http';
import type {
  AgentRunWithRating,
  BatchRunRequest,
  BatchRunResult,
  DailyBatchResult,
} from '@shared/api.interface';

/**
 * 对整个组合触发一次每日批量分析。
 * 对应 POST /api/multi-agent/daily-batch；AnalysisRunner 点击"全组合分析"时调用。
 * @param language - 报告语言（zh-CN 或 en）。
 * @returns 批量登记结果（创建的 run 概览）。
 */
export async function runPortfolioAnalysis(language: 'zh-CN' | 'en'): Promise<DailyBatchResult> {
  const response = await http<DailyBatchResult>({
    url: '/api/multi-agent/daily-batch',
    method: 'POST',
    data: { language },
  });
  return response.data;
}

/**
 * 对一组 ticker 触发批量分析 run。
 * 对应 POST /api/multi-agent/runs/batch；AnalysisRunner 点击"单票分析"时调用。
 * @param request - 批量请求（scope、tiered、tickers）。
 * @returns 批量登记结果。
 */
export async function runStockAnalysis(request: BatchRunRequest): Promise<BatchRunResult> {
  const response = await http<BatchRunResult>({
    url: '/api/multi-agent/runs/batch',
    method: 'POST',
    data: request,
  });
  return response.data;
}

/**
 * 拉取 Analysis 页"最近分析"列表：并发查询最近完成、活跃中、待人工审核
 * 三类 run，合并去重后按"活跃优先、再按创建时间倒序"排序。
 * 对应 GET /api/multi-agent/runs（3 次并发查询）；
 * AnalysisRunner 以本函数作为 useQuery 的 queryFn 调用。
 * @returns `{ items, activeTotal }`：合并后的 run 列表与活跃 run 总数。
 */
export async function fetchRecentAnalysisRuns(): Promise<{
  items: AgentRunWithRating[];
  activeTotal: number;
}> {
  // 步骤 1：并发发 3 个查询 —— 最近 12 条、活跃 run（上限 100）、待人工审核（上限 100）。
  const [recent, active, awaiting] = await Promise.all([
    http<{ items: AgentRunWithRating[] }>({
      url: '/api/multi-agent/runs',
      method: 'GET',
      params: { limit: 12 },
    }),
    http<{ items: AgentRunWithRating[]; total: number }>({
      url: '/api/multi-agent/runs',
      method: 'GET',
      params: { activeOnly: true, limit: 100 },
    }),
    http<{ items: AgentRunWithRating[] }>({
      url: '/api/multi-agent/runs',
      method: 'GET',
      params: { status: 'awaiting_human', limit: 100 },
    }),
  ]);

  // 步骤 2：以 id 为键合并去重；后写入的（活跃/待审核）覆盖同 id 的旧快照。
  const merged = new Map(recent.data.items.map((run) => [run.id, run]));
  active.data.items.forEach((run) => merged.set(run.id, run));
  awaiting.data.items.forEach((run) => merged.set(run.id, run));

  // 步骤 3：活跃 run 排前面，同组内按创建时间倒序。
  const activeIds = new Set(active.data.items.map((run) => run.id));
  const items = [...merged.values()].sort((a, b) => {
    return (
      Number(activeIds.has(b.id)) - Number(activeIds.has(a.id)) ||
      Date.parse(b.createdAt) - Date.parse(a.createdAt)
    );
  });

  // 步骤 4：activeTotal 取自活跃查询的 total（可能与 items 长度不同）。
  return { items, activeTotal: active.data.total };
}

/**
 * 取消一个还在排队/运行中的研究 run。
 * 对应 POST /api/multi-agent/runs/{id}/cancel；AnalysisRunner 取消按钮的 mutationFn 调用。
 * @param id - run 主键。
 */
export async function cancelAnalysisRun(id: string): Promise<void> {
  await http({ url: `/api/multi-agent/runs/${id}/cancel`, method: 'POST' });
}
