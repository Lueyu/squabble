/**
 * @file utils/agent-api.ts
 * @description 挂在 `window.__pt` 上的嵌入式多智能体桥接 API。
 *
 * 本地浏览器集成（如内嵌的智能体运行时）可以用这套稳定接口读写组合数据，
 * 而无需知道后端 URL。`initAgentAPI` 负责把它安装到 `window.__pt` 上，
 * 并与已有字段合并，因此可以安全地多次调用。
 *
 * 这里的方法刻意与后端 `/api/agent/*` 路由一一对应，且是跨进程调用的；
 * SPA 自身的 UI 应优先使用 `api/index.ts` 里的类型化函数。
 *
 * 职责边界：
 *  - 只做"桥接面"安装与转发；页面内部的 API 调用不走这里
 * 上下游：
 *  - 上游（谁调用这里）：app.tsx 在应用挂载时调用 initAgentAPI
 *  - 下游（本文件调用谁）：../api/http（axios 实例）、./logger；
 *    另外行情 hook（use-market-quotes）会向 window.__pt 追加 getMarketStatus
 * 关键约定：
 *  - window.__pt 已存在的字段不会被覆盖（合并安装）
 *  - 深度报告的 url 一律用 resolveAppUrl 拼同源绝对地址，供 SPA 之外使用
 */
import http from '../api/http';
/** 拼接同源绝对 URL，供 SPA 外部（智能体进程）使用的链接。 */
const resolveAppUrl = (path: string) => `${window.location.origin}${path}`;
import { logger } from './logger';

declare global {
  interface Window {
    /** 暴露给嵌入式智能体运行时的桥接面。 */
    __pt?: PortfolioTerminalAPI;
  }
}

/**
 * 安装到 `window.__pt` 上的智能体桥接接口形状。
 * 所有方法都是异步的，后端出错时 reject；读方法返回后端原始负载，
 * 写方法返回落库后的记录。
 */
interface PortfolioTerminalAPI {
  getState: () => Promise<unknown>;
  getHistory: () => Promise<unknown>;
  saveDailyAnalysis: (date: string, items: unknown[]) => Promise<unknown>;
  applyHoldingRatings: (items: unknown[]) => Promise<unknown>;
  addWatchItems: (items: unknown[]) => Promise<unknown>;
  removeWatchItems: (tickers: string[]) => Promise<unknown>;
  saveJournal: (data: unknown) => Promise<unknown>;
  getJournal: (date?: string) => Promise<unknown>;
  saveSnapshot: (data: unknown) => Promise<unknown>;
  getSnapshots: (limit?: number) => Promise<unknown>;
  saveDeepReport: (input: unknown) => Promise<unknown>;
  getStrategyRules: () => Promise<unknown>;
  getLatestDeepReport: (ticker: string) => Promise<unknown>;
  listDeepReports: () => Promise<unknown>;
  getMarketStatus?: () => {
    utcNow: string;
    markets: Record<
      string,
      {
        phase: string;
        timezone: string;
        localTime: string;
        weekday: number;
        nextRefresh: number;
        lastUpdated: Date | null;
        error: boolean;
        tickerCount: number;
      }
    >;
  };
}

/**
 * 把智能体桥接安装到 `window.__pt` 上。
 * 可安全地多次调用：`window.__pt` 上已有的字段会被保留并与 API 面合并。
 * SSR 环境下是空操作。
 */
export function initAgentAPI() {
  if (typeof window === 'undefined') return;

  const api: PortfolioTerminalAPI = {
    // 读取多智能体运行状态。
    async getState() {
      try {
        const response = await http.get('/api/agent/state');
        return response.data;
      } catch (error) {
        logger.error('agent getState failed', error);
        throw error;
      }
    },

    // 读取多智能体运行历史。
    async getHistory() {
      try {
        const response = await http.get('/api/agent/history');
        return response.data;
      } catch (error) {
        logger.error('agent getHistory failed', error);
        throw error;
      }
    },

    // 保存某天的每日分析快照。
    async saveDailyAnalysis(date: string, items: unknown[]) {
      try {
        const response = await http.post('/api/agent/daily-analysis', {
          date,
          items,
        });
        return response.data;
      } catch (error) {
        logger.error('agent saveDailyAnalysis failed', error);
        throw error;
      }
    },

    // 把评级批量应用到持仓。
    async applyHoldingRatings(items: unknown[]) {
      try {
        const response = await http.post('/api/agent/holding-ratings', {
          items,
        });
        return response.data;
      } catch (error) {
        logger.error('agent applyHoldingRatings failed', error);
        throw error;
      }
    },

    // 批量新增自选条目。
    async addWatchItems(items: unknown[]) {
      try {
        const response = await http.post('/api/agent/watch-items/add', {
          items,
        });
        return response.data;
      } catch (error) {
        logger.error('agent addWatchItems failed', error);
        throw error;
      }
    },

    // 按 ticker 批量移除自选条目。
    async removeWatchItems(tickers: string[]) {
      try {
        const response = await http.post('/api/agent/watch-items/remove', { tickers });
        return response.data;
      } catch (error) {
        logger.error('agent removeWatchItems failed', error);
        throw error;
      }
    },

    // 保存交易日志（Journal）。
    async saveJournal(data: unknown) {
      try {
        const response = await http.post('/api/agent/journal', data);
        return response.data;
      } catch (error) {
        logger.error('agent saveJournal failed', error);
        throw error;
      }
    },

    // 读取交易日志，可按日期过滤。
    async getJournal(date?: string) {
      try {
        // 有 date 时拼查询参数，否则请求全量端点。
        const url = date ? `/api/agent/journal?date=${date}` : '/api/agent/journal';
        const response = await http.get(url);
        return response.data;
      } catch (error) {
        logger.error('agent getJournal failed', error);
        throw error;
      }
    },

    // 保存一份组合快照。
    async saveSnapshot(data: unknown) {
      try {
        const response = await http.post('/api/agent/snapshot', data);
        return response.data;
      } catch (error) {
        logger.error('agent saveSnapshot failed', error);
        throw error;
      }
    },

    // 读取历史组合快照，可用 limit 限制条数。
    async getSnapshots(limit?: number) {
      try {
        // 有 limit 时拼查询参数，否则请求全量端点。
        const url = limit ? `/api/agent/snapshots?limit=${limit}` : '/api/agent/snapshots';
        const response = await http.get(url);
        return response.data;
      } catch (error) {
        logger.error('agent getSnapshots failed', error);
        throw error;
      }
    },

    // 保存深度报告，并附上可分享的同源绝对链接。
    async saveDeepReport(input: unknown) {
      try {
        const response = await http.post('/api/agent/deep-report', input);
        const data = response.data;
        // 用返回的 runId 拼报告页地址。
        const url = resolveAppUrl(`/analysis/deep-report/${data.runId}`);
        return { ...data, url };
      } catch (error) {
        logger.error('agent saveDeepReport failed', error);
        throw error;
      }
    },

    // 读取策略规则列表。
    async getStrategyRules() {
      try {
        const response = await http.get('/api/agent/strategy-rules');
        return response.data;
      } catch (error) {
        logger.error('agent getStrategyRules failed', error);
        throw error;
      }
    },

    // 读取某 ticker 的最新深度报告，有 runId 时附上绝对链接。
    async getLatestDeepReport(ticker: string) {
      try {
        const response = await http.get(`/api/agent/deep-report/latest?ticker=${ticker}`);
        const data = response.data;
        // 存在 runId 才拼链接；否则原样返回。
        if (data && data.runId) {
          const url = resolveAppUrl(`/analysis/deep-report/${data.runId}`);
          return { ...data, url };
        }
        return data;
      } catch (error) {
        logger.error('agent getLatestDeepReport failed', error);
        throw error;
      }
    },

    // 列出全部深度报告，每条都附上同源绝对链接。
    async listDeepReports() {
      try {
        const response = await http.get('/api/agent/deep-reports');
        // 兼容非数组响应：一律回退空数组再逐条补链接。
        const items = Array.isArray(response.data) ? response.data : [];
        return items.map((item: { runId: string }) => ({
          ...item,
          url: resolveAppUrl(`/analysis/deep-report/${item.runId}`),
        }));
      } catch (error) {
        logger.error('agent listDeepReports failed', error);
        throw error;
      }
    },
  };

  // 合并安装：保留 __pt 上已有字段（例如行情 hook 注入的 getMarketStatus）。
  const existing = window.__pt ?? {};
  window.__pt = { ...existing, ...api };
  logger.info('Portfolio Terminal agent API initialized');
}
