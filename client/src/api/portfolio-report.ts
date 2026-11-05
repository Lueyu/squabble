import http from './http';
import type { ModelRoute } from '@shared/model-route.interface';
import type { PortfolioReportRun } from '@shared/portfolio-report.interface';

const BASE = '/api/multi-agent/portfolio-runs';

export async function createPortfolioReportRun(language: 'zh-CN' | 'en', route?: ModelRoute): Promise<PortfolioReportRun> {
  const response = await http<PortfolioReportRun>({
    url: BASE, method: 'POST', data: { language, ...(route ? { route } : {}) },
  });
  return response.data;
}

export async function listPortfolioReportRuns(limit = 5): Promise<{ items: PortfolioReportRun[] }> {
  const response = await http<{ items: PortfolioReportRun[] }>({
    url: BASE, method: 'GET', params: { limit },
  });
  return response.data;
}

export async function getPortfolioReportRun(id: string): Promise<PortfolioReportRun> {
  const response = await http<PortfolioReportRun>({
    url: `${BASE}/${encodeURIComponent(id)}`, method: 'GET',
  });
  return response.data;
}

export async function cancelPortfolioReportRun(id: string): Promise<void> {
  await http({ url: `${BASE}/${encodeURIComponent(id)}/cancel`, method: 'POST' });
}
