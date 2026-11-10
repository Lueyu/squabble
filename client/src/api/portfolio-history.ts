import http from './http';
import type { PortfolioComparisonPeriod } from '@shared/portfolio-comparison.interface';
import type { PortfolioHistoryView } from '@shared/portfolio-history.interface';

export async function fetchPortfolioHistory(
  period: PortfolioComparisonPeriod,
  accountIds?: string[],
): Promise<PortfolioHistoryView> {
  const response = await http.get<PortfolioHistoryView>(
    '/api/portfolio-history',
    {
      params: {
        period,
        ...(accountIds ? { accountIds: accountIds.join(',') } : {}),
      },
    },
  );
  return response.data;
}
