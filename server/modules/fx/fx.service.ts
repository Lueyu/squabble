/**
 * fx.service.ts — 汇率服务：存储/查询汇率（USD→HKD、USD→CNY）并在币种间换算金额。
 *
 * 职责边界：
 *  - 负责汇率落库（fxRates 表）、按日期/最新查询、直接对与反向对（1/rate）解析、金额换算。
 *  - 上游汇率源为 Frankfurter（.../v1/latest?base=USD&symbols=HKD,CNY），
 *    只覆盖 USD→HKD 与 USD→CNY 两组基准汇率。
 * 上下游：
 *  - 上游：FxController（/api/fx 路由）；DashboardService、SnapshotsService、
 *    PaperTradingService、multi-agent 的 PortfolioContextService 注入复用。
 *  - 下游：Drizzle 数据库（fxRates 表）与 @nestjs/axios 的 HttpService（Frankfurter API）。
 * 关键约定：
 *  - 刷新节流：refreshRates 进入即把下次允许刷新推迟 5 分钟（5 * 60 * 1000），
 *    成功 upsert 至少一条后再推迟到 60 分钟（60 * 60 * 1000）；失败返回 0。
 *  - 汇率新鲜度窗口：汇率日期距今 -1 天 ～ +7 天（-86_400_000 ～ 7 * 86_400_000）
 *    之内视为可用（recentRateDate），窗口外的旧汇率不参与查询结果。
 *  - 单飞刷新：getLatestRate 过了节流点时用 refreshInFlight 合并并发刷新。
 *  - 同币种直接返回 '1'；货币代码须匹配 ^[A-Za-z]{3}$（不区分大小写，查询前统一大写）。
 *  - HTTP 超时 8000ms；上游响应要求 date 为 YYYY-MM-DD 且汇率数值有效（> 0）。
 *  - fxRates 以 (rateDate, base, quote) 为冲突目标（唯一键）做 upsert。
 */
import { Injectable, Inject, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '../../common/platform';
import { eq, desc, sql } from 'drizzle-orm';
import { firstValueFrom } from 'rxjs';
import { fxRates } from '@server/database/schema';
import type { FxRate, Currency } from '@shared/api.interface';

/**
 * 提供汇率查询与币种换算。依赖 Drizzle 数据库连接与 Axios 的 HttpService。
 */
@Injectable()
export class FxService {
  private readonly logger = new Logger(FxService.name);
  private refreshAfter = 0;
  private refreshInFlight: Promise<number> | null = null;

  // 判断汇率日期是否落在可用窗口内（距今 -1 天 ～ +7 天）。
  private recentRateDate(value: string | Date): boolean {
    const date = typeof value === 'string' ? value : value.toISOString().slice(0, 10);
    const age = Date.now() - Date.parse(`${date}T00:00:00Z`);
    return Number.isFinite(age) && age >= -86_400_000 && age <= 7 * 86_400_000;
  }

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly httpService: HttpService,
  ) {}

  /**
   * 返回某基础/报价货币对的最新汇率。同币种返回 '1'。
   * 先尝试直接对，再尝试反向对（取 1/rate）。
   *
   * @param base  基础货币
   * @param quote 报价货币
   * @returns 汇率字符串；库里没有可用汇率时返回 null
   */
  async getLatestRate(base: string, quote: string): Promise<string | null> {
    // 参数守卫：两个货币代码都必须是 3 个字母。
    if (
      typeof base !== 'string' ||
      typeof quote !== 'string' ||
      !/^[A-Za-z]{3}$/.test(base) ||
      !/^[A-Za-z]{3}$/.test(quote)
    )
      return null;
    const baseUpper = base.toUpperCase();
    const quoteUpper = quote.toUpperCase();

    // 同币种换算恒为 1，直接短路返回。
    if (baseUpper === quoteUpper) return '1';
    // 过了节流点就触发一次刷新；并发调用共享同一个进行中的刷新 Promise。
    if (Date.now() >= this.refreshAfter) {
      this.refreshInFlight ??= this.refreshRates().finally(() => {
        this.refreshInFlight = null;
      });
      await this.refreshInFlight;
    }

    // 先查直接对（base -> quote），取汇率日期最新的一条。
    const directRow = await this.db
      .select({ rate: fxRates.rate, date: fxRates.rateDate })
      .from(fxRates)
      .where(sql`${fxRates.base} = ${baseUpper} AND ${fxRates.quote} = ${quoteUpper}`)
      .orderBy(desc(fxRates.rateDate))
      .limit(1);

    // 直接对命中且日期在可用窗口内：原样返回汇率。
    if (
      directRow.length > 0 &&
      this.recentRateDate(directRow[0].date) &&
      directRow[0].rate !== null &&
      directRow[0].rate !== undefined
    ) {
      return String(directRow[0].rate);
    }

    // 再查反向对（quote -> base）并取倒数（1/rate）。
    const reverseRow = await this.db
      .select({ rate: fxRates.rate, date: fxRates.rateDate })
      .from(fxRates)
      .where(sql`${fxRates.base} = ${quoteUpper} AND ${fxRates.quote} = ${baseUpper}`)
      .orderBy(desc(fxRates.rateDate))
      .limit(1);

    // 反向对命中且日期在窗口内：汇率必须大于 0 才能取倒数。
    if (
      reverseRow.length > 0 &&
      this.recentRateDate(reverseRow[0].date) &&
      reverseRow[0].rate !== null &&
      reverseRow[0].rate !== undefined
    ) {
      const rate = parseFloat(String(reverseRow[0].rate));
      if (rate > 0) {
        return (1 / rate).toString();
      }
    }

    return null;
  }

  /**
   * 列出给定日期记录的全部汇率。
   *
   * @param date 汇率日期（YYYY-MM-DD）
   */
  async getRatesForDate(date: string): Promise<FxRate[]> {
    // 按日期精确过滤，按 (base, quote) 排序保证输出稳定。
    const rows = await this.db
      .select({
        date: fxRates.rateDate,
        base: fxRates.base,
        quote: fxRates.quote,
        rate: fxRates.rate,
      })
      .from(fxRates)
      .where(eq(fxRates.rateDate, date))
      .orderBy(fxRates.base, fxRates.quote);

    // 统一映射为 API 形状：日期归一化为 YYYY-MM-DD，汇率以字符串承载。
    return rows.map((row) => ({
      date: typeof row.date === 'string' ? row.date : (row.date as Date).toISOString().slice(0, 10),
      base: row.base as Currency,
      quote: row.quote as Currency,
      rate: String(row.rate),
    }));
  }

  /**
   * 抓取上游的带日期 USD→HKD 与 USD→CNY 汇率并 upsert 进 fxRates 表
   * （以日期+base+quote 为键）。失败仅记日志并返回 0。
   *
   * @returns 成功 upsert 的汇率条数
   */
  async refreshRates(): Promise<number> {
    // 节流检查：距上次尝试不足 5 分钟直接跳过。
    if (Date.now() < this.refreshAfter) return 0;
    this.refreshAfter = Date.now() + 5 * 60 * 1000;
    try {
      // 请求 Frankfurter 的 USD→HKD/CNY 最新汇率（8 秒超时）。
      const url = 'https://api.frankfurter.dev/v1/latest?base=USD&symbols=HKD,CNY';
      const response = await firstValueFrom(this.httpService.get(url, { timeout: 8000 }));

      // 校验响应结构：date 必须是 YYYY-MM-DD 且 rates 是对象。
      const data = response.data;
      if (
        !data ||
        !/^\d{4}-\d{2}-\d{2}$/.test(data.date) ||
        !data.rates ||
        typeof data.rates !== 'object'
      ) {
        this.logger.warn('refreshRates: invalid response from Frankfurter');
        return 0;
      }
      // 上游日期同样要落在可用窗口（-1 ～ +7 天）内，否则放弃本次刷新。
      const providerDate = data.date as string;
      const providerAge = Date.now() - Date.parse(`${providerDate}T00:00:00Z`);
      if (
        !Number.isFinite(providerAge) ||
        providerAge < -86_400_000 ||
        providerAge > 7 * 86_400_000
      )
        return 0;
      // 组装待入库汇率列表：只收 USD→HKD 与 USD→CNY，数值必须为正。
      const rates: Array<{ base: string; quote: string; rate: string }> = [];

      const hkdRate = data.rates.HKD;
      const cnyRate = data.rates.CNY;

      if (typeof hkdRate === 'number' && !isNaN(hkdRate) && hkdRate > 0) {
        rates.push({ base: 'USD', quote: 'HKD', rate: hkdRate.toString() });
      }
      if (typeof cnyRate === 'number' && !isNaN(cnyRate) && cnyRate > 0) {
        rates.push({ base: 'USD', quote: 'CNY', rate: cnyRate.toString() });
      }

      if (rates.length === 0) return 0;

      // 按 (date, base, quote) 唯一键逐条 upsert；单条失败不影响其余条目。
      let updated = 0;
      for (const r of rates) {
        try {
          await this.db
            .insert(fxRates)
            .values({
              rateDate: providerDate,
              base: r.base,
              quote: r.quote,
              rate: r.rate,
            })
            .onConflictDoUpdate({
              target: [fxRates.rateDate, fxRates.base, fxRates.quote],
              set: { rate: r.rate },
            });
          updated += 1;
        } catch (insertError) {
          this.logger.warn(
            `refreshRates: upsert failed for ${r.base}/${r.quote}: ${insertError instanceof Error ? insertError.message : String(insertError)}`,
          );
        }
      }

      // 至少成功一条才把节流窗口延长到 60 分钟。
      if (updated > 0) this.refreshAfter = Date.now() + 60 * 60 * 1000;
      return updated;
    } catch (error) {
      this.logger.warn(
        `refreshRates failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 0;
    }
  }

  /**
   * 把一笔金额从一个币种换算到另一个币种。给了日期则优先用该日期的汇率
   * （先直接对，再反向对）；否则用最新汇率。
   *
   * @param amount 待换算金额
   * @param from   源币种
   * @param to     目标币种
   * @param date   可选的汇率日期（YYYY-MM-DD）
   * @returns 换算后的金额
   * @throws Error 当没有可用汇率或汇率无效时抛出
   */
  async convert(amount: number, from: string, to: string, date?: string): Promise<number> {
    // 币种统一大写后比较；同币种原样返回金额。
    const fromUpper = from.toUpperCase();
    const toUpper = to.toUpperCase();

    if (fromUpper === toUpper) return amount;

    let rateStr: string | null = null;

    // 指定了日期：先查该日期的直接对。
    if (date) {
      // 先查指定日期的直接对。
      const directRow = await this.db
        .select({ rate: fxRates.rate })
        .from(fxRates)
        .where(
          sql`${fxRates.base} = ${fromUpper} AND ${fxRates.quote} = ${toUpper} AND ${fxRates.rateDate} = ${date}`,
        )
        .limit(1);

      if (directRow.length > 0 && directRow[0].rate != null) {
        rateStr = String(directRow[0].rate);
      } else {
        // 再查指定日期的反向对，命中则取倒数（1/rate）。
        const reverseRow = await this.db
          .select({ rate: fxRates.rate })
          .from(fxRates)
          .where(
            sql`${fxRates.base} = ${toUpper} AND ${fxRates.quote} = ${fromUpper} AND ${fxRates.rateDate} = ${date}`,
          )
          .limit(1);

        if (reverseRow.length > 0 && reverseRow[0].rate != null) {
          const r = parseFloat(String(reverseRow[0].rate));
          if (r > 0) rateStr = (1 / r).toString();
        }
      }
    }

    // 兜底：改用最新可用汇率。
    if (rateStr === null) {
      rateStr = await this.getLatestRate(fromUpper, toUpper);
    }

    // 无任何可用汇率：抛出带币种对的错误。
    if (rateStr === null) {
      throw new Error(`No exchange rate available for ${fromUpper} -> ${toUpper}`);
    }

    // 汇率字符串必须是可解析的数字，否则视为无效。
    const rate = parseFloat(rateStr);
    if (isNaN(rate)) {
      throw new Error(`Invalid exchange rate for ${fromUpper} -> ${toUpper}`);
    }

    return amount * rate;
  }
}
