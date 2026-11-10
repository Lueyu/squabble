import http from './http';
import type { PortfolioComparisonPeriod, PortfolioComparisonView } from '@shared/portfolio-comparison.interface';

export async function fetchPortfolioComparison(period: PortfolioComparisonPeriod = '1M', accountIds?: string[]): Promise<PortfolioComparisonView> {
  const response = await http.get<PortfolioComparisonView>('/api/ai-investment/comparison', {
    params: { period, ...(accountIds ? { accountIds: accountIds.join(',') } : {}) },
  });
  return response.data;
}
