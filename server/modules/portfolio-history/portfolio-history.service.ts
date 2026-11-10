import { BadRequestException, Injectable } from '@nestjs/common';
import type { PortfolioComparisonPeriod } from '../../../shared/portfolio-comparison.interface';
import type { PortfolioHistoryView } from '../../../shared/portfolio-history.interface';
import { PortfolioHistoryHoldings } from './portfolio-history.holdings';
import { PortfolioHistoryCache } from './portfolio-history.cache';
import { referencePoints, utcDay } from './portfolio-history.rules';

@Injectable()
export class PortfolioHistoryService {
  constructor(private readonly holdings: PortfolioHistoryHoldings, private readonly cache: PortfolioHistoryCache) {}

  /** Import hooks may await this in their background task; foreground reads never wait for providers. */
  async prefetch(owner: string): Promise<void> {
    const portfolios = await this.holdings.read(owner);
    await this.cache.prefetch(portfolios.flatMap(row => row.positions), new Date(), portfolios.flatMap(row => row.cash.map(cash => cash.currency)));
  }

  async read(owner: string, periodInput = '1M', accountIds?: string, at = new Date()): Promise<PortfolioHistoryView> {
    const periods: PortfolioComparisonPeriod[] = ['1D', '1W', '1M', '3M', 'YTD', 'ALL'];
    if (!periods.includes(periodInput as PortfolioComparisonPeriod)) throw new BadRequestException('COMPARISON_PERIOD_INVALID');
    const period = periodInput as PortfolioComparisonPeriod;
    const days = { '1D': 1, '1W': 7, '1M': 30, '3M': 90, 'ALL': 365, 'YTD': Math.floor((at.getTime() - Date.UTC(at.getUTCFullYear(), 0, 1)) / 86_400_000) }[period];
    const to = utcDay(at), from = utcDay(new Date(Date.parse(to) - days * 86_400_000));
    const selection = accountIds ? [...new Set(accountIds.split(',').filter(Boolean))] : undefined;
    const portfolios = await this.holdings.read(owner, selection), positions = portfolios.flatMap(row => row.positions);
    const saved = await this.cache.read(positions, utcDay(new Date(Date.parse(from) - 7 * 86_400_000)), to, at);
    void this.cache.prefetch(positions, at);
    return { basis: 'current_positions_historical_prices', currency: 'USD', period, maximumDays: 365, from, to, readAt: at.toISOString(),
      refreshing: saved.refreshing, includesCash: false, priceBasis: 'provider_close', corporateActions: 'not_reconstructed',
      gaps: [...(period === 'ALL' ? ['HISTORY_LIMITED_TO_365_DAYS'] : []), ...saved.gaps],
      series: portfolios.map(portfolio => {
        const points = referencePoints(portfolio.positions, saved.prices, saved.fx, from, to), latest = points.at(-1)!;
        return { accountId: portfolio.accountId, name: portfolio.name, kind: portfolio.kind, holdingsAsOf: at.toISOString(), points,
          coverage: { completePoints: points.filter(point => point.valueUsd !== null).length, totalPoints: points.length,
            coveredPositions: latest.coveredPositions, totalPositions: latest.totalPositions },
          gaps: [...new Set(points.flatMap(point => point.gaps))] };
      }) };
  }
}
