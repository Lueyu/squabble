import { BadRequestException, Injectable, Optional } from '@nestjs/common';
import type { PortfolioComparisonPeriod } from '../../../shared/portfolio-comparison.interface';
import type { PortfolioHistoryView } from '../../../shared/portfolio-history.interface';
import { PortfolioHistoryHoldings } from './portfolio-history.holdings';
import { PortfolioHistoryCache } from './portfolio-history.cache';
import { referenceCohort, referencePoints, utcDay } from './portfolio-history.rules';
import { PortfolioIntradayReferenceService } from './portfolio-intraday-reference.service';
import { intradayReferencePoints } from './portfolio-intraday-reference.rules';
import { combineReferencePoints } from './portfolio-history-merge';

@Injectable()
export class PortfolioHistoryService {
  constructor(private readonly holdings: PortfolioHistoryHoldings, private readonly cache: PortfolioHistoryCache,
    @Optional() private readonly intraday?: PortfolioIntradayReferenceService) {}

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
    const granularity = period === '1M' ? 'hourly' : 'observations';
    const quoteFacts = this.intraday && ['1D', '1W', '1M'].includes(period)
      ? await this.intraday.read(owner, portfolios.map(portfolio => portfolio.accountId), new Date(Date.parse(from) - 7 * 86_400_000), at) : [];
    void this.cache.prefetch(positions, at);
    let observedCount = 0, dailyCount = 0;
    const series = portfolios.map(portfolio => {
        const originalObserved = intradayReferencePoints(portfolio.positions, quoteFacts, saved.fx, from, at.toISOString(), granularity);
        const cohort = referenceCohort(originalObserved);
        const originalDaily = referencePoints(portfolio.positions, saved.prices, saved.fx, from, to);
        // Revalue both sources from per-ticker facts. An old full/partial sum
        // cannot be relabelled as the latest comparable covered subset.
        const daily = cohort ? referencePoints(portfolio.positions, saved.prices, saved.fx, from, to, cohort) : originalDaily;
        let observed = cohort ? intradayReferencePoints(portfolio.positions, quoteFacts, saved.fx, from, at.toISOString(), granularity, cohort)
          : originalObserved;
        const originalBoundary = combineReferencePoints(originalDaily, originalObserved).find(point => point.timestamp);
        const boundaryRisks = originalBoundary?.gaps.filter(gap => gap.startsWith('PRICE_BASIS_CHANGED:')
          || gap.startsWith('PRICE_DISCONTINUITY_UNVERIFIED:')) ?? [];
        if (cohort && originalBoundary?.timestamp && boundaryRisks.length) {
          // Keep the original source-transition evidence even if this cohort's
          // hourly sampling would omit its genuine observation time. Revalue
          // that time from facts; never reuse the old full-portfolio subtotal.
          const timestamp = originalBoundary.timestamp;
          const projected = observed.find(point => point.timestamp === timestamp)
            ?? intradayReferencePoints(portfolio.positions, quoteFacts, saved.fx, timestamp, timestamp, 'observations', cohort).at(-1);
          if (projected) {
            const retained = { ...projected, valueUsd: null, gaps: [...new Set([...projected.gaps, ...boundaryRisks])] };
            observed = [...observed.filter(point => point.timestamp !== timestamp), retained]
              .sort((left, right) => Date.parse(left.timestamp!) - Date.parse(right.timestamp!));
          }
        }
        // Daily fallback covers only earlier dates. A close and a live quote
        // never become two contradictory samples for the same calendar day.
        const points = combineReferencePoints(daily, observed), latest = points.at(-1)!;
        observedCount += observed.length; dailyCount += points.length - observed.length;
        return { accountId: portfolio.accountId, name: portfolio.name, kind: portfolio.kind, holdingsAsOf: at.toISOString(), points,
          coverage: { completePoints: points.filter(point => point.valueUsd !== null).length, totalPoints: points.length,
            coveredPositions: latest.coveredPositions, totalPositions: latest.totalPositions },
          gaps: [...new Set(points.flatMap(point => point.gaps))] };
      });
    return { basis: 'current_positions_historical_prices', currency: 'USD', period, maximumDays: 365, from, to, readAt: at.toISOString(),
      refreshing: saved.refreshing, includesCash: false, priceBasis: observedCount ? dailyCount ? 'mixed_close_and_quote' : 'provider_quote' : 'provider_close',
      ...(observedCount ? { intradayGranularity: granularity } : {}), corporateActions: 'not_reconstructed',
      gaps: [...(period === 'ALL' ? ['HISTORY_LIMITED_TO_365_DAYS'] : []), ...saved.gaps], series };
  }
}
