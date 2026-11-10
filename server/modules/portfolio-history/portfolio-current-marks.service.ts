import { Inject, Injectable } from '@nestjs/common';
import { and, gte, lte } from 'drizzle-orm';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '../../common/platform';
import { fxRates } from '../../database/schema';
import type { PortfolioCurrentMark } from '../../../shared/portfolio-comparison.interface';
import { PortfolioHistoryHoldings } from './portfolio-history.holdings';
import { PortfolioHistoryCache } from './portfolio-history.cache';
import { currentMark, utcDay, type HistoryFx } from './portfolio-history.rules';

@Injectable()
export class PortfolioCurrentMarksService {
  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly holdings: PortfolioHistoryHoldings, private readonly cache: PortfolioHistoryCache) {}

  async read(owner: string, accountIds?: string[], at = new Date()): Promise<Record<string, PortfolioCurrentMark>> {
    const portfolios = await this.holdings.read(owner, accountIds), positions = portfolios.flatMap(row => row.positions);
    const currencies = portfolios.flatMap(row => row.cash.map(cash => cash.currency));
    const to = utcDay(at), from = utcDay(new Date(at.getTime() - 7 * 86_400_000));
    const [saved, currentFx] = await Promise.all([
      this.cache.read(positions, from, to, at, currencies),
      this.db.select().from(fxRates).where(and(gte(fxRates.rateDate, from), lte(fxRates.rateDate, to))),
    ]);
    void this.cache.prefetch(positions, at, currencies);
    const rates: HistoryFx[] = [...saved.fx, ...currentFx.flatMap(row => {
      const rate = Number(row.rate);
      if (!Number.isFinite(rate) || rate <= 0 || row.base !== 'USD' && row.quote !== 'USD') return [];
      return [{ currency: row.base === 'USD' ? row.quote : row.base, rateDate: row.rateDate,
        usdRate: String(row.base === 'USD' ? 1 / rate : rate), source: 'recorded-fx' }];
    })];
    return Object.fromEntries(portfolios.map(portfolio => [portfolio.accountId, currentMark(portfolio.positions, portfolio.cash, saved.prices, rates, at, portfolio.cashScopeKnown)]));
  }
}
