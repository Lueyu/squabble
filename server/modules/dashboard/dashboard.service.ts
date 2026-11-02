/**
 * Dashboard service.
 *
 * Aggregates the user's portfolio into a single overview: it refreshes latest
 * quotes, sums holdings market value/cost and cash balances per currency, converts
 * everything to a chosen base currency via `FxService`, and builds per-market
 * group summaries. It also serves the daily P&L time series from snapshots. FX
 * conversions fall back to a 1:1 pass-through (logged) when a rate is missing.
 */
import { Injectable, Inject, Logger, forwardRef } from '@nestjs/common';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '../../common/platform';
import { eq, desc, and, gte, sql } from 'drizzle-orm';
import { holdings, cashAccounts, snapshots } from '@server/database/schema';
import type { DashboardOverview, GroupSummary, Currency, Market } from '@shared/api.interface';
import { FxService } from '../fx/fx.service';
import { QuoteService } from '../quote/quote.service';

/** Chinese display names for each supported market. */
const MARKET_NAMES: Record<Market, string> = {
  US: '美股',
  HK: '港股',
  CN: 'A股',
};

/** A holdings row projected for dashboard aggregation. */
interface HoldingRow {
  id: string;
  ticker: string;
  shares: string;
  buyPrice: string | null;
  currentPrice: string | null;
  market: string;
  currency: string;
}

/** A cash account row projected for the dashboard. */
interface CashRow {
  currency: string;
  balance: string;
}

/** A snapshot row projected for the dashboard. */
interface SnapshotRow {
  snapshotDate: string;
  accountValue: string | null;
  totalMv: string | null;
  cash: string | null;
  dailyPl: string | null;
  dailyPct: string | null;
}

/**
 * Provides the portfolio overview and daily P&L series. Depends on the Drizzle
 * database, `FxService` (injected via `forwardRef`), and `QuoteService`.
 */
@Injectable()
export class DashboardService {
  private readonly logger = new Logger(DashboardService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    @Inject(forwardRef(() => FxService)) private readonly fxService: FxService,
    private readonly quoteService: QuoteService,
  ) {}

  /**
   * Converts an amount between currencies, returning the amount unchanged (and
   * logging) if the rate lookup fails.
   *
   * @param amount Amount to convert.
   * @param from   Source currency.
   * @param to     Target currency.
   * @param date   Optional rate date.
   */
  private async safeConvert(amount: number, from: string, to: string, date?: string): Promise<number> {
    if (from.toUpperCase() === to.toUpperCase()) return amount;
    try {
      return await this.fxService.convert(amount, from, to, date);
    } catch (err) {
      this.logger.warn(
        `fx convert failed ${from}->${to}${date ? ` @${date}` : ''}, fallback to 1: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return amount;
    }
  }

  /**
   * Builds the portfolio overview. Refreshes quotes, aggregates holdings and cash
   * per currency and market, converts to the base currency, and computes totals and
   * P&L.
   *
   * @param userId       Owner id.
   * @param baseCurrency Target currency for the aggregated totals.
   */
  async getOverview(userId: string, baseCurrency: string = 'USD'): Promise<DashboardOverview> {
    const base = baseCurrency.toUpperCase();

    try {
      // Refresh latest prices for the user's holdings/watchlist first.
      await this.quoteService.batchRefreshPrices(userId);
    } catch (err) {
      this.logger.warn(
        `batch refresh prices failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Holdings rows.
    const holdingRows = await this.db
      .select({
        id: holdings.id,
        ticker: holdings.ticker,
        shares: holdings.shares,
        buyPrice: holdings.buyPrice,
        currentPrice: holdings.currentPrice,
        market: holdings.market,
        currency: holdings.currency,
      })
      .from(holdings)
      .where(sql`${holdings.owner} = ${userId}`);

    const items: HoldingRow[] = holdingRows.map((row) => ({
      id: row.id,
      ticker: row.ticker,
      shares: String(row.shares),
      buyPrice: row.buyPrice ? String(row.buyPrice) : null,
      currentPrice: row.currentPrice ? String(row.currentPrice) : null,
      market: row.market ?? 'US',
      currency: row.currency ?? 'USD',
    }));

    // Cash accounts
    const cashRows = await this.db
      .select({
        currency: cashAccounts.currency,
        balance: cashAccounts.balance,
      })
      .from(cashAccounts)
      .where(sql`${cashAccounts.owner} = ${userId}`);

    const cashItems: CashRow[] = cashRows.map((row) => ({
      currency: row.currency,
      balance: String(row.balance),
    }));

    // Aggregate by currency (holdings)
    const mvByCurrency: Record<string, number> = { USD: 0, HKD: 0, CNY: 0 };
    const costByCurrency: Record<string, number> = { USD: 0, HKD: 0, CNY: 0 };
    const cashByCurrencyNum: Record<string, number> = { USD: 0, HKD: 0, CNY: 0 };

    // Aggregate by market
    const marketMap = new Map<
      string,
      { count: number; mv: number; cost: number; currency: string }
    >();

    for (const h of items) {
      const shares = parseFloat(h.shares);
      const current = h.currentPrice ? parseFloat(h.currentPrice) : 0;
      const buy = h.buyPrice ? parseFloat(h.buyPrice) : 0;
      const mv = shares * current;
      const cost = shares * buy;
      const cur = h.currency.toUpperCase();
      const mkt = h.market.toUpperCase();

      if (mvByCurrency[cur] !== undefined) {
        mvByCurrency[cur] += mv;
        costByCurrency[cur] += cost;
      } else {
        mvByCurrency[cur] = mv;
        costByCurrency[cur] = cost;
      }

      const existing = marketMap.get(mkt);
      if (existing) {
        existing.count += 1;
        existing.mv += mv;
        existing.cost += cost;
      } else {
        marketMap.set(mkt, { count: 1, mv, cost, currency: cur });
      }
    }

    for (const c of cashItems) {
      const cur = c.currency.toUpperCase();
      const bal = parseFloat(c.balance);
      if (cashByCurrencyNum[cur] !== undefined) {
        cashByCurrencyNum[cur] += bal;
      } else {
        cashByCurrencyNum[cur] = bal;
      }
    }

    // Convert to base currency
    const allCurrencies = new Set<string>([
      ...Object.keys(mvByCurrency).filter((k) => mvByCurrency[k] > 0 || costByCurrency[k] > 0),
      ...Object.keys(cashByCurrencyNum).filter((k) => cashByCurrencyNum[k] > 0),
      base,
    ]);

    const rateCache = new Map<string, number>();
    for (const cur of allCurrencies) {
      if (cur === base) {
        rateCache.set(cur, 1);
      } else {
        try {
          const converted = await this.fxService.convert(1, cur, base);
          rateCache.set(cur, converted);
        } catch (err) {
          this.logger.warn(
            `fx rate missing ${cur}->${base}, fallback to 1: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
          rateCache.set(cur, 1);
        }
      }
    }

    const getRate = (cur: string): number => rateCache.get(cur.toUpperCase()) ?? 1;

    // Totals in base currency
    let totalMvBase = 0;
    let totalCostBase = 0;
    let totalCashBase = 0;

    for (const cur of Object.keys(mvByCurrency)) {
      const rate = getRate(cur);
      totalMvBase += mvByCurrency[cur] * rate;
      totalCostBase += costByCurrency[cur] * rate;
    }
    for (const cur of Object.keys(cashByCurrencyNum)) {
      const rate = getRate(cur);
      totalCashBase += cashByCurrencyNum[cur] * rate;
    }

    const accountValueBase = totalMvBase + totalCashBase;
    const totalPlBase = totalMvBase - totalCostBase;
    const totalPctBase = totalCostBase > 0 ? (totalPlBase / totalCostBase) * 100 : 0;

    // Group summaries (converted to base currency)
    const groupSummaries: GroupSummary[] = [];
    for (const [mkt, g] of marketMap) {
      const rate = getRate(g.currency);
      const mvBase = g.mv * rate;
      const costBase = g.cost * rate;
      const plBase = mvBase - costBase;
      const returnPct = g.cost > 0 ? (plBase / costBase) * 100 : 0;
      const weight = totalMvBase > 0 ? (mvBase / totalMvBase) * 100 : 0;
      const marketKey = mkt as Market;
      groupSummaries.push({
        groupId: mkt,
        groupName: MARKET_NAMES[marketKey] ?? mkt,
        groupColor: null,
        count: g.count,
        marketValue: mvBase.toFixed(2),
        cost: costBase.toFixed(2),
        pl: plBase.toFixed(2),
        returnPct: returnPct.toFixed(2),
        weight: weight.toFixed(2),
      });
    }
    groupSummaries.sort((a, b) => parseFloat(b.marketValue) - parseFloat(a.marketValue));

    // Latest snapshot for dailyPl
    const latestSnapshots = await this.db
      .select({
        snapshotDate: snapshots.snapshotDate,
        accountValue: snapshots.accountValue,
        totalMv: snapshots.totalMv,
        cash: snapshots.cash,
        dailyPl: snapshots.dailyPl,
        dailyPct: snapshots.dailyPct,
      })
      .from(snapshots)
      .where(sql`${snapshots.owner} = ${userId}`)
      .orderBy(desc(snapshots.snapshotDate))
      .limit(1);

    let dailyPlBase = 0;
    let dailyPctBase = 0;

    if (latestSnapshots.length > 0 && latestSnapshots[0].dailyPl != null) {
      const snap = latestSnapshots[0];
      const snapDailyPl = parseFloat(String(snap.dailyPl));
      const snapDailyPct = snap.dailyPct != null ? parseFloat(String(snap.dailyPct)) : 0;
      dailyPlBase = await this.safeConvert(snapDailyPl, 'USD', base, String(snap.snapshotDate));
      dailyPctBase = snapDailyPct;
    }

    const totalMvByCurrency: Record<string, string> = {
      USD: mvByCurrency.USD.toFixed(2),
      HKD: mvByCurrency.HKD.toFixed(2),
      CNY: mvByCurrency.CNY.toFixed(2),
    };

    const cashByCurrency: Record<string, string> = {
      USD: cashByCurrencyNum.USD.toFixed(2),
      HKD: cashByCurrencyNum.HKD.toFixed(2),
      CNY: cashByCurrencyNum.CNY.toFixed(2),
    };

    return {
      accountValue: accountValueBase.toFixed(2),
      totalMv: totalMvBase.toFixed(2),
      cost: totalCostBase.toFixed(2),
      cash: totalCashBase.toFixed(2),
      totalPl: totalPlBase.toFixed(2),
      totalPct: totalPctBase.toFixed(2),
      baseCurrency: base as Currency,
      totalMvByCurrency,
      cashByCurrency,
      dailyPl: dailyPlBase.toFixed(2),
      dailyPct: dailyPctBase.toFixed(2),
      groups: groupSummaries,
    };
  }

  /**
   * Returns the daily P&L series for the last N days from snapshots. Snapshot
   * values are stored in USD; if a non-USD base is requested, each day's account
   * value and P&L are converted at that day's rate.
   *
   * @param userId       Owner id.
   * @param days         Number of days to include (clamped 1..365).
   * @param baseCurrency Target currency.
   */
  async getDailyPlSeries(
    userId: string,
    days: number = 30,
    baseCurrency: string = 'USD',
  ): Promise<{ date: string; accountValue: string; dailyPl: string; dailyPct: string }[]> {
    const base = baseCurrency.toUpperCase();
    const daysNum = Math.max(1, Math.min(365, Math.floor(days)));

    // Compute start date.
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(endDate.getDate() - daysNum + 1);
    const startStr = startDate.toISOString().slice(0, 10);

    const rows = await this.db
      .select({
        snapshotDate: snapshots.snapshotDate,
        accountValue: snapshots.accountValue,
        totalMv: snapshots.totalMv,
        cash: snapshots.cash,
        dailyPl: snapshots.dailyPl,
        dailyPct: snapshots.dailyPct,
      })
      .from(snapshots)
      .where(
        and(
          sql`${snapshots.owner} = ${userId}`,
          gte(snapshots.snapshotDate, startStr),
        ),
      )
      .orderBy(snapshots.snapshotDate);

    // Snapshot currency: assumed USD historically (single-currency era).
    // For multi-currency, snapshot fields are stored in the user's base at snapshot time.
    // We treat them as USD and convert if base differs.
    const result: { date: string; accountValue: string; dailyPl: string; dailyPct: string }[] = [];

    for (const row of rows) {
      const dateStr =
        typeof row.snapshotDate === 'string'
          ? row.snapshotDate
          : (row.snapshotDate as Date).toISOString().slice(0, 10);

      const av = row.accountValue != null ? parseFloat(String(row.accountValue)) : 0;
      const dp = row.dailyPl != null ? parseFloat(String(row.dailyPl)) : 0;
      const dPct = row.dailyPct != null ? parseFloat(String(row.dailyPct)) : 0;

      let avBase = av;
      let dpBase = dp;
      const dPctBase = dPct;

      if (base !== 'USD') {
        try {
          avBase = await this.fxService.convert(av, 'USD', base, dateStr);
          dpBase = await this.fxService.convert(dp, 'USD', base, dateStr);
        } catch (err) {
          this.logger.warn(
            `fx convert failed for snapshot ${dateStr} USD->${base}, fallback to 1`,
          );
        }
      }

      result.push({
        date: dateStr,
        accountValue: avBase.toFixed(2),
        dailyPl: dpBase.toFixed(2),
        dailyPct: dPctBase.toFixed(2),
      });
    }

    return result;
  }

  /**
   * Refreshes FX rates from the upstream provider.
   *
   * @returns Always true on success.
   */
  async refreshRates(): Promise<boolean> {
    await this.fxService.refreshRates();
    return true;
  }
}
