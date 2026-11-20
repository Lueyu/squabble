/**
 * dashboard.service.ts — 仪表盘（Dashboard）的聚合业务逻辑。
 *
 * 职责边界：
 *  - 把用户的持仓、现金账户、快照聚合成一份总览：先刷新最新行情，
 *    按币种汇总市值/成本/现金，再统一折算到指定基准币种，并生成
 *    按市场分组的概要；另提供每日盈亏时间序列与汇率刷新入口。
 *  - 不做任何写入；行情刷新与汇率换算分别委托 QuoteService 与 FxService。
 * 上下游：
 *  - 上游：DashboardController 的 overview、daily-pl 和 refresh-rates 端点。
 *  - 下游：Drizzle 数据库（holdings、cashAccounts、snapshots 只读）、
 *    QuoteService.batchRefreshPrices、FxService.convert / refreshRates。
 * 关键约定：
 *  - 基准币种默认 USD（getOverview/getDailyPlSeries 的参数默认值）。
 *  - getDailyPlSeries 的 days 默认 30，钳制到 1..365。
 *  - 汇率缺失/换算失败时一律按 1:1 兜底并打 warn 日志（不抛错、不中断聚合）。
 *  - getOverview 的日盈亏取自最新快照（快照以 USD 记账），按快照日汇率折算。
 *  - 数值输出统一 toFixed(2) 字符串。
 */
import { Injectable, Inject, Logger, forwardRef } from '@nestjs/common';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '../../common/platform';
import { eq, desc, and, gte, sql } from 'drizzle-orm';
import { holdings, cashAccounts, snapshots } from '@server/database/schema';
import type { DashboardOverview, GroupSummary, Currency, Market } from '@shared/api.interface';
import { FxService } from '../fx/fx.service';
import { QuoteService } from '../quote/quote.service';

/** 各支持市场的中文显示名。 */
const MARKET_NAMES: Record<Market, string> = {
  US: '美股',
  HK: '港股',
  CN: 'A股',
};

/** 仪表盘聚合所用的持仓行投影。 */
interface HoldingRow {
  id: string;
  ticker: string;
  shares: string;
  buyPrice: string | null;
  currentPrice: string | null;
  market: string;
  currency: string;
}

/** 仪表盘所用的现金账户行投影。 */
interface CashRow {
  currency: string;
  balance: string;
}

/** 仪表盘所用的快照行投影。 */
interface SnapshotRow {
  snapshotDate: string;
  accountValue: string | null;
  totalMv: string | null;
  cash: string | null;
  dailyPl: string | null;
  dailyPct: string | null;
}

/**
 * 提供组合总览与每日盈亏序列。依赖 Drizzle 数据库、FxService
 * （forwardRef 注入）与 QuoteService。
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
   * 币种间换算的安全封装：同币种直接原样返回；换算失败时记录警告
   * 并按 1:1 原值返回。
   *
   * @param amount 待换算金额
   * @param from   源币种
   * @param to     目标币种
   * @param date   可选的汇率取值日期
   */
  private async safeConvert(
    amount: number,
    from: string,
    to: string,
    date?: string,
  ): Promise<number> {
    // 同币种无需换算。
    if (from.toUpperCase() === to.toUpperCase()) return amount;
    try {
      return await this.fxService.convert(amount, from, to, date);
    } catch (err) {
      // 换算失败时按 1:1 兜底，不中断聚合。
      this.logger.warn(
        `fx convert failed ${from}->${to}${date ? ` @${date}` : ''}, fallback to 1: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return amount;
    }
  }

  /**
   * 构建组合总览。先刷新行情，再按币种与市场聚合持仓与现金，折算到
   * 基准币种，最后计算合计与盈亏。
   *
   * @param userId       归属用户 id
   * @param baseCurrency 合计值的目标币种
   */
  async getOverview(userId: string, baseCurrency: string = 'USD'): Promise<DashboardOverview> {
    const base = baseCurrency.toUpperCase();

    try {
      // 先刷新该用户持仓/自选的最新价格。
      await this.quoteService.batchRefreshPrices(userId);
    } catch (err) {
      // 行情刷新失败不阻断总览，按现有库内价格继续聚合。
      this.logger.warn(
        `batch refresh prices failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // 取全部持仓行（只选聚合所需的列）。
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

    // 取全部现金账户行。
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

    // 按币种聚合持仓市值/成本。
    const mvByCurrency: Record<string, number> = { USD: 0, HKD: 0, CNY: 0 };
    const costByCurrency: Record<string, number> = { USD: 0, HKD: 0, CNY: 0 };
    // 按币种聚合现金余额。
    const cashByCurrencyNum: Record<string, number> = { USD: 0, HKD: 0, CNY: 0 };

    // 按市场分组的聚合容器。
    const marketMap = new Map<
      string,
      { count: number; mv: number; cost: number; currency: string }
    >();

    // 逐条持仓：算市值/成本，累进币种桶与市场分组。
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

    // 逐条现金账户累进币种桶。
    for (const c of cashItems) {
      const cur = c.currency.toUpperCase();
      const bal = parseFloat(c.balance);
      if (cashByCurrencyNum[cur] !== undefined) {
        cashByCurrencyNum[cur] += bal;
      } else {
        cashByCurrencyNum[cur] = bal;
      }
    }

    // 收集出现过的全部币种（有余额/有成本的，加上基准币种本身）。
    const allCurrencies = new Set<string>([
      ...Object.keys(mvByCurrency).filter((k) => mvByCurrency[k] > 0 || costByCurrency[k] > 0),
      ...Object.keys(cashByCurrencyNum).filter((k) => cashByCurrencyNum[k] > 0),
      base,
    ]);

    // 一次性取齐各币种 → 基准币种的汇率；缺失时按 1 兜底。
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

    // 折算成基准币种的合计值。
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

    // 按市场生成分组概要（折算到基准币种）。
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
    // 分组按市值从大到小排序。
    groupSummaries.sort((a, b) => parseFloat(b.marketValue) - parseFloat(a.marketValue));

    // 取最新一份快照用于日盈亏。
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
      // 快照以 USD 记账：按快照日汇率折算到基准币种。
      dailyPlBase = await this.safeConvert(snapDailyPl, 'USD', base, String(snap.snapshotDate));
      dailyPctBase = snapDailyPct;
    }

    // 组装按币种明细的输出（固定三个币种键）。
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
   * 返回最近 N 天的每日盈亏序列（来自快照）。快照值按 USD 存账；若请求
   * 非 USD 基准，则每日的账户总值与盈亏按当日汇率换算。
   *
   * @param userId       归属用户 id
   * @param days         包含的天数（钳制 1..365）
   * @param baseCurrency 目标币种
   */
  async getDailyPlSeries(
    userId: string,
    days: number = 30,
    baseCurrency: string = 'USD',
  ): Promise<{ date: string; accountValue: string; dailyPl: string; dailyPct: string }[]> {
    const base = baseCurrency.toUpperCase();
    // 天数钳制到 1..365。
    const daysNum = Math.max(1, Math.min(365, Math.floor(days)));

    // 以今天为终点倒推起始日期。
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(endDate.getDate() - daysNum + 1);
    const startStr = startDate.toISOString().slice(0, 10);

    // 取起始日期之后的全部快照，按日期升序。
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
      .where(and(sql`${snapshots.owner} = ${userId}`, gte(snapshots.snapshotDate, startStr)))
      .orderBy(snapshots.snapshotDate);

    // 快照币种的历史约定：单币种时代一律假设为 USD；多币种之后快照字段
    // 按快照当时的用户基准币种存储。这里一律按 USD 处理，基准不同则换算。
    const result: { date: string; accountValue: string; dailyPl: string; dailyPct: string }[] = [];

    // 逐行换算并组装输出；缺数值的列按 0 处理。
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
          // 换算失败时按 1:1 兜底（该行保持 USD 原值）。
          this.logger.warn(`fx convert failed for snapshot ${dateStr} USD->${base}, fallback to 1`);
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
   * 从上游数据源刷新汇率。
   *
   * @returns 成功时恒为 true
   */
  async refreshRates(): Promise<boolean> {
    await this.fxService.refreshRates();
    return true;
  }
}
