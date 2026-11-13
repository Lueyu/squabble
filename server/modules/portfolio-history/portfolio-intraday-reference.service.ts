import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '../../common/platform';
import { portfolioValuePoints } from '../../database/portfolio-value-points.schema';
import { paperEquityObservations } from '../../database/portfolio-observations.schema';
import type { HistoryObservedQuote } from './portfolio-intraday-reference.rules';

/** Reads only owned retained quote facts; it neither requests quotes nor writes observations. */
@Injectable()
export class PortfolioIntradayReferenceService {
  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase) {}

  async read(owner: string, accountIds: string[], from: Date, to: Date): Promise<HistoryObservedQuote[]> {
    const ids = accountIds.filter(id => id !== 'real');
    // DISTINCT happens inside PostgreSQL so repeated closed-market captures do
    // not send the same provider fact back to the client for every sample slot.
    const [real, paper] = await Promise.all([
      accountIds.includes('real') ? this.db.execute<{ quote: HistoryObservedQuote }>(sql`
        SELECT DISTINCT quote.value AS quote FROM ${portfolioValuePoints}
        CROSS JOIN LATERAL jsonb_array_elements(${portfolioValuePoints.marketQuotes}) AS quote(value)
        WHERE ${and(eq(portfolioValuePoints.owner, owner), gte(portfolioValuePoints.capturedAt, from), lte(portfolioValuePoints.capturedAt, to))}
      `) : [],
      ids.length ? this.db.execute<{ quote: HistoryObservedQuote }>(sql`
        SELECT DISTINCT quote.value AS quote FROM ${paperEquityObservations}
        CROSS JOIN LATERAL jsonb_array_elements(${paperEquityObservations.marketQuotes}) AS quote(value)
        WHERE ${and(eq(paperEquityObservations.owner, owner), inArray(paperEquityObservations.accountId, ids),
          gte(paperEquityObservations.capturedAt, from), lte(paperEquityObservations.capturedAt, to))}
      `) : [],
    ]);
    return [...real, ...paper].map(row => row.quote).filter(quote => quote && typeof quote.ticker === 'string'
      && typeof quote.market === 'string' && typeof quote.currency === 'string'
      && (typeof quote.price === 'number' || typeof quote.price === 'string')
      && typeof quote.quoteAt === 'string' && typeof quote.source === 'string');
  }
}
