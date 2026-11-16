/**
 * quote.service.ts — 美股 / 港股 / A 股行情的抓取、缓存与代码搜索。
 *
 * 职责边界：
 *  - detectMarket 从代码拼写推断市场/币种/显示代码；按市场分别从免费
 *    公共源抓取实时报价：腾讯 qt.gtimg.cn（主源，美股/港股/A 股），失败时
 *    美股回退 Yahoo、港股/A 股回退新浪 hq.sinajs.cn（港股再退 Yahoo）。
 *  - 提供内存 TTL 缓存、批量报价、代码搜索（先匹配用户自己的持仓/自选，
 *    不足再查腾讯 smartbox），以及把最新价写回持仓/自选行的批量刷新。
 *  - 不管汇率换算（FxService）与页面聚合（DashboardService）。
 * 上下游：
 *  - 上游：QuoteController 暴露 /api/quote 路由；QuoteService 被全仓 10+
 *    模块消费（dashboard、market-overview、holdings、watchlist、import、mcp、
 *    multi-agent evidence、paper-trading、research-tools、settings、transactions）。
 *  - 下游：HttpService（qt.gtimg.cn / hq.sinajs.cn / smartbox.gtimg.cn /
 *    query1.finance.yahoo.com）；Drizzle 数据库（holdings、watchlist 表）。
 * 关键约定：
 *  - 内存缓存键为 displaySymbol，TTL 60 秒（CACHE_TTL_MS = 60_000），
 *    只缓存成功结果。
 *  - 单次批量请求最多解析 30 个代码（MAX_BATCH_SIZE = 30）。
 *  - 上游 HTTP 超时 8000ms（smartbox 搜索为 5000ms）。
 *  - 腾讯/新浪返回 GBK 文本（decodeGbk 失败退 UTF-8、再退 null）。
 *  - 所有报价一律标记 delayed: true（延迟行情，非实时）。
 *  - 港股上游代码为 5 位补零形态；显示形态去前导零（00700 → 700.HK）。
 *  - A 股上游前缀：.SH/.SS → sh、.SZ → sz、.BJ → bj。
 */
import { Injectable, Inject, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '../../common/platform';
import { eq, sql } from 'drizzle-orm';
import { firstValueFrom } from 'rxjs';
import { holdings, watchlist } from '@server/database/schema';
import type { QuoteResponse, Market, Currency } from '@shared/api.interface';

/** 由代码推导出的市场/币种/代码元数据。 */
interface MarketInfo {
  /** 目标市场：US、HK 或 CN。 */
  market: Market;
  /** 该市场的报价币种（USD/HKD/CNY）。 */
  currency: Currency;
  /** 用户可见的显示代码（如 `AAPL`、`700.HK`、`600519.SH`）。 */
  displaySymbol: string;
  /** 上游 API 调用使用的原生代码。 */
  symbolNative: string;
}

/** 带绝对过期时间戳的缓存条目。 */
interface CacheEntry {
  /** 缓存的报价数据。 */
  value: QuoteResponse;
  /** 超过该 Unix 毫秒时间戳即视为过期。 */
  expiresAt: number;
}

/** 单次批量请求可解析的最大代码数。 */
const MAX_BATCH_SIZE = 30;
/** 抓取到的报价在内存缓存中的存留时长。 */
const CACHE_TTL_MS = 60_000;

/**
 * 跨市场抓取并缓存股票报价。依赖 Drizzle 数据库（用于搜索与价格回写）
 * 和 Axios `HttpService`（用于上游调用）。
 */
@Injectable()
export class QuoteService {
  private readonly logger = new Logger(QuoteService.name);
  /** 按 `MarketInfo.displaySymbol` 作键的内存 TTL 缓存。 */
  private readonly quoteCache = new Map<string, CacheEntry>();

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly httpService: HttpService,
  ) {}

  /**
   * 仅凭代码拼写推断市场、币种与显示/原生代码：显式后缀（.HK/.SH/.SZ/.BJ）
   * 优先，其次按纯数字形态启发判断（4~5 位 → HK；6 位按首位数字选 A 股
   * 交易所），默认归入美股/USD。
   *
   * @param symbol 用户输入的代码。
   * @returns 解析得到的市场元数据。
   */
  detectMarket(symbol: string): MarketInfo {
    const upper = symbol.toUpperCase().trim();

    // 显式后缀识别。
    if (upper.endsWith('.HK')) {
      const codePart = upper.slice(0, -3);
      const numeric = codePart.replace(/\D/g, '');
      // 港股原生代码补零至 5 位。
      const symbolNative = numeric.padStart(5, '0');
      return {
        market: 'HK',
        currency: 'HKD',
        displaySymbol: upper,
        symbolNative,
      };
    }

    if (upper.endsWith('.SH') || upper.endsWith('.SS')) {
      const codePart = upper.slice(0, -3);
      return {
        market: 'CN',
        currency: 'CNY',
        displaySymbol: upper,
        symbolNative: codePart,
      };
    }

    if (upper.endsWith('.SZ')) {
      const codePart = upper.slice(0, -3);
      return {
        market: 'CN',
        currency: 'CNY',
        displaySymbol: upper,
        symbolNative: codePart,
      };
    }

    if (upper.endsWith('.BJ')) {
      const codePart = upper.slice(0, -3);
      return {
        market: 'CN',
        currency: 'CNY',
        displaySymbol: upper,
        symbolNative: codePart,
      };
    }

    // 纯数字形态识别。
    if (/^\d+$/.test(upper)) {
      // 4 位 → 港股（如 0700，本应用持仓的存储形态）。
      // 5 位 → 港股（如 00700，上游原生形态）。
      if (upper.length === 4 || upper.length === 5) {
        const padded = upper.padStart(5, '0');
        const displayCode = padded.startsWith('0') ? padded.slice(1) : padded;
        return {
          market: 'HK',
          currency: 'HKD',
          displaySymbol: `${displayCode}.HK`,
          symbolNative: padded,
        };
      }
      // 6 位 → A 股；首位数字决定交易所。
      if (upper.length === 6) {
        if (upper.startsWith('6')) {
          return {
            market: 'CN',
            currency: 'CNY',
            displaySymbol: `${upper}.SH`,
            symbolNative: upper,
          };
        }
        if (upper.startsWith('0') || upper.startsWith('3')) {
          return {
            market: 'CN',
            currency: 'CNY',
            displaySymbol: `${upper}.SZ`,
            symbolNative: upper,
          };
        }
        if (upper.startsWith('8') || upper.startsWith('4')) {
          return {
            market: 'CN',
            currency: 'CNY',
            displaySymbol: `${upper}.BJ`,
            symbolNative: upper,
          };
        }
      }
    }

    // 默认：美股。
    return {
      market: 'US',
      currency: 'USD',
      displaySymbol: upper,
      symbolNative: upper,
    };
  }

  /**
   * 返回某个代码的最新报价：缓存仍新鲜时直接命中，否则按市场选择
   * 对应数据源抓取。
   *
   * @param symbol 待解析的代码。
   * @returns 报价数据；全部数据源失败时返回 null。
   */
  async getQuote(symbol: string): Promise<QuoteResponse | null> {
    const info = this.detectMarket(symbol);
    const cacheKey = info.displaySymbol;

    // 缓存仍新鲜时直接返回缓存值。
    const cached = this.quoteCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    try {
      let result: QuoteResponse | null = null;
      if (info.market === 'US') {
        result = await this.fetchUsQuote(info.symbolNative);
      } else if (info.market === 'HK') {
        result = await this.fetchHkQuote(info.symbolNative);
      } else if (info.market === 'CN') {
        // A 股上游端点需要 sh/sz/bj 前缀。
        const prefix =
          info.displaySymbol.endsWith('.SH') || info.displaySymbol.endsWith('.SS')
            ? 'sh'
            : info.displaySymbol.endsWith('.SZ')
              ? 'sz'
              : 'bj';
        result = await this.fetchCnQuote(info.symbolNative, prefix);
      }

      // 只缓存成功结果。
      if (result) {
        this.quoteCache.set(cacheKey, {
          value: result,
          expiresAt: Date.now() + CACHE_TTL_MS,
        });
      }
      return result;
    } catch (error) {
      this.logger.warn(
        `getQuote failed for ${symbol}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  /**
   * 并行解析多个代码的报价：先去重，再截断到 `MAX_BATCH_SIZE`。
   *
   * @param symbols 代码列表。
   * @returns 解析成功的报价（失败的代码直接跳过）。
   */
  async getBatchQuotes(symbols: string[]): Promise<QuoteResponse[]> {
    const unique = Array.from(new Set(symbols.map((s: string) => s.trim()).filter(Boolean))).slice(
      0,
      MAX_BATCH_SIZE,
    );
    const results: QuoteResponse[] = [];
    const promises = unique.map(async (sym: string) => {
      const q = await this.getQuote(sym);
      if (q) results.push(q);
    });
    await Promise.all(promises);
    return results;
  }

  /**
   * 从腾讯抓取美股报价，失败时回退 Yahoo。
   *
   * @param symbol 美股代码（大写）。
   */
  async fetchUsQuote(symbol: string): Promise<QuoteResponse | null> {
    let primary: QuoteResponse | null = null;
    try {
      const url = `http://qt.gtimg.cn/q=us${symbol.toUpperCase()}`;
      const response = await firstValueFrom(
        this.httpService.get(url, { responseType: 'arraybuffer', timeout: 8000 }),
      );

      // 腾讯返回 GBK 编码文本。
      const text = this.decodeGbk(response.data as ArrayBuffer);
      if (!text) return null;

      const match = text.match(/v_us[a-zA-Z0-9.]+="([^"]*)"/);
      if (!match) return null;

      // 腾讯美股字段以 ~ 分隔，字段数不足 35 视为无效响应。
      const fields = match[1].split('~');
      if (fields.length < 35) return null;

      const currentPrice = parseFloat(fields[3]);
      const prevClose = parseFloat(fields[4]);
      const changeStr = fields[31];
      const changePercentStr = fields[32];

      if (isNaN(currentPrice) || currentPrice <= 0) return null;

      // 上游缺涨跌幅时由昨收推导。
      const changeVal = parseFloat(changeStr);
      const changePercentVal = parseFloat(changePercentStr);
      const change = isNaN(changeVal)
        ? isNaN(prevClose) || prevClose <= 0
          ? 0
          : currentPrice - prevClose
        : changeVal;
      const changePercent = isNaN(changePercentVal)
        ? isNaN(prevClose) || prevClose <= 0
          ? 0
          : (change / prevClose) * 100
        : changePercentVal;

      const openStr = fields[5];
      const highStr = fields[33];
      const lowStr = fields[34];
      const volumeStr = fields[6] ?? '';
      const name = fields[46] ?? fields[1] ?? '';

      primary = {
        symbol: symbol.toUpperCase(),
        companyName: name || undefined,
        price: currentPrice.toFixed(2),
        change: change.toFixed(2),
        changePercent: changePercent.toFixed(2),
        open: openStr && !isNaN(parseFloat(openStr)) ? parseFloat(openStr).toFixed(2) : undefined,
        high: highStr && !isNaN(parseFloat(highStr)) ? parseFloat(highStr).toFixed(2) : undefined,
        low: lowStr && !isNaN(parseFloat(lowStr)) ? parseFloat(lowStr).toFixed(2) : undefined,
        volume: volumeStr && !isNaN(parseFloat(volumeStr)) ? volumeStr : undefined,
        currency: 'USD',
        market: 'US',
        timestamp: Date.now(),
        delayed: true,
      };
    } catch (error) {
      this.logger.warn(
        `fetchUsQuote tencent failed for ${symbol}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // 主源失败时回退 Yahoo。
    if (!primary) {
      try {
        const yahooResult = await this.fetchUsQuoteYahoo(symbol);
        if (yahooResult) return yahooResult;
      } catch (error) {
        this.logger.warn(
          `fetchUsQuote yahoo fallback failed for ${symbol}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return primary;
  }

  /**
   * 从 Yahoo Finance chart API 抓取美股报价（备选数据源）。
   *
   * @param symbol 美股代码。
   */
  async fetchUsQuoteYahoo(symbol: string): Promise<QuoteResponse | null> {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`;
      const response = await firstValueFrom(
        this.httpService.get(url, {
          responseType: 'json',
          timeout: 8000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; QuoteService/1.0)',
          },
        }),
      );

      const data = response.data as {
        chart?: {
          result?: Array<{
            meta?: {
              regularMarketPrice?: number;
              chartPreviousClose?: number;
              regularMarketOpen?: number;
              regularMarketDayHigh?: number;
              regularMarketDayLow?: number;
              regularMarketVolume?: number;
              symbol?: string;
            };
          }>;
        };
      };

      // 从 chart.result[0].meta 读取当日行情。
      const meta = data?.chart?.result?.[0]?.meta;
      if (!meta) return null;

      const price = meta.regularMarketPrice;
      const prevClose = meta.chartPreviousClose;

      if (typeof price !== 'number' || isNaN(price) || price <= 0) return null;

      const change = typeof prevClose === 'number' && prevClose > 0 ? price - prevClose : 0;
      const changePercent =
        typeof prevClose === 'number' && prevClose > 0 ? (change / prevClose) * 100 : 0;

      return {
        symbol: (meta.symbol ?? symbol).toUpperCase(),
        price: price.toFixed(2),
        change: change.toFixed(2),
        changePercent: changePercent.toFixed(2),
        open:
          typeof meta.regularMarketOpen === 'number'
            ? meta.regularMarketOpen.toFixed(2)
            : undefined,
        high:
          typeof meta.regularMarketDayHigh === 'number'
            ? meta.regularMarketDayHigh.toFixed(2)
            : undefined,
        low:
          typeof meta.regularMarketDayLow === 'number'
            ? meta.regularMarketDayLow.toFixed(2)
            : undefined,
        volume:
          typeof meta.regularMarketVolume === 'number'
            ? String(meta.regularMarketVolume)
            : undefined,
        currency: 'USD',
        market: 'US',
        timestamp: Date.now(),
        delayed: true,
      };
    } catch (error) {
      this.logger.warn(
        `fetchUsQuoteYahoo failed for ${symbol}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  /**
   * 从腾讯抓取港股报价，失败时回退新浪。
   *
   * @param symbol 港股原生代码（5 位）。
   */
  async fetchHkQuote(symbol: string): Promise<QuoteResponse | null> {
    let primary: QuoteResponse | null = null;
    try {
      const url = `http://qt.gtimg.cn/q=hk${symbol}`;
      const response = await firstValueFrom(
        this.httpService.get(url, { responseType: 'arraybuffer', timeout: 8000 }),
      );

      const text = this.decodeGbk(response.data as ArrayBuffer);
      if (!text) return null;

      // 解析 v_hkXXXX="..." 模式。
      const match = text.match(/v_hk\d+="([^"]*)"/);
      if (!match) return null;

      // 腾讯港股字段以 ~ 分隔，字段数不足 7 视为无效响应。
      const fields = match[1].split('~');
      if (fields.length < 7) return null;

      const currentPrice = parseFloat(fields[3]);
      const prevClose = parseFloat(fields[4]);
      const changeStr = fields[31];
      const changePercentStr = fields[32];

      if (isNaN(currentPrice) || currentPrice <= 0) return null;

      // 上游缺涨跌幅时由昨收推导。
      const changeVal = parseFloat(changeStr);
      const changePercentVal = parseFloat(changePercentStr);
      const change = isNaN(changeVal)
        ? isNaN(prevClose) || prevClose <= 0
          ? 0
          : currentPrice - prevClose
        : changeVal;
      const changePercent = isNaN(changePercentVal)
        ? isNaN(prevClose) || prevClose <= 0
          ? 0
          : (change / prevClose) * 100
        : changePercentVal;

      const openStr = fields[5];
      const highStr = fields[33];
      const lowStr = fields[34];
      const volumeStr = fields[6] ?? '';
      const name = fields[1] ?? '';

      // 5 位港股代码的显示形态去掉前导零。
      const displayCode = symbol.startsWith('0') && symbol.length === 5 ? symbol.slice(1) : symbol;

      primary = {
        symbol: `${displayCode}.HK`,
        companyName: name || undefined,
        price: currentPrice.toFixed(2),
        change: change.toFixed(2),
        changePercent: changePercent.toFixed(2),
        open: openStr && !isNaN(parseFloat(openStr)) ? parseFloat(openStr).toFixed(2) : undefined,
        high: highStr && !isNaN(parseFloat(highStr)) ? parseFloat(highStr).toFixed(2) : undefined,
        low: lowStr && !isNaN(parseFloat(lowStr)) ? parseFloat(lowStr).toFixed(2) : undefined,
        volume: volumeStr && !isNaN(parseFloat(volumeStr)) ? volumeStr : undefined,
        currency: 'HKD',
        market: 'HK',
        timestamp: Date.now(),
        delayed: true,
      };
    } catch (error) {
      this.logger.warn(
        `fetchHkQuote tencent failed for ${symbol}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // 主源失败时回退新浪（try/catch 保护）。
    if (!primary) {
      try {
        primary = await this.fetchHkQuoteSina(symbol);
      } catch (error) {
        this.logger.warn(
          `fetchHkQuote sina fallback failed for ${symbol}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    // 回退链：新浪，再雅虎。（注意：此处会对新浪再发起一次裸调用——
    // 既有回退链行为，保持原样不改。）
    if (!primary) {
      primary = await this.fetchHkQuoteSina(symbol);
    }
    if (!primary) {
      primary = await this.fetchHkQuoteYahoo(symbol);
    }
    return primary;
  }

  /**
   * 从新浪抓取港股报价（备选数据源）。新浪要求带 Referer 头才会响应。
   *
   * @param symbol 港股原生代码（5 位）。
   */
  async fetchHkQuoteSina(symbol: string): Promise<QuoteResponse | null> {
    try {
      const url = `https://hq.sinajs.cn/list=hk${symbol}`;
      const response = await firstValueFrom(
        this.httpService.get(url, {
          responseType: 'arraybuffer',
          timeout: 8000,
          headers: {
            Referer: 'https://finance.sina.com.cn',
          },
        }),
      );

      const text = this.decodeGbk(response.data as ArrayBuffer);
      if (!text) return null;

      const match = text.match(/var hq_str_hk\d+="([^"]*)"/);
      if (!match) return null;

      // 新浪港股字段以逗号分隔，字段数不足 8 视为无效响应。
      const fields = match[1].split(',');
      // 新浪港股格式：0=名称,1=开盘,2=昨收,3=最高,4=最低,5=现价,6=涨跌,7=涨跌%,...
      if (fields.length < 8) return null;

      const name = fields[0] ?? '';
      const openStr = fields[1];
      const prevCloseStr = fields[2];
      const highStr = fields[3];
      const lowStr = fields[4];
      const currentPrice = parseFloat(fields[5]);
      const prevClose = parseFloat(prevCloseStr);

      if (isNaN(currentPrice) || currentPrice <= 0) return null;

      // 涨跌幅由昨收推导。
      const change = isNaN(prevClose) || prevClose <= 0 ? 0 : currentPrice - prevClose;
      const changePercent = isNaN(prevClose) || prevClose <= 0 ? 0 : (change / prevClose) * 100;

      // 5 位港股代码的显示形态去掉前导零。
      const displayCode = symbol.startsWith('0') && symbol.length === 5 ? symbol.slice(1) : symbol;

      return {
        symbol: `${displayCode}.HK`,
        companyName: name || undefined,
        price: currentPrice.toFixed(2),
        change: change.toFixed(2),
        changePercent: changePercent.toFixed(2),
        open: openStr && !isNaN(parseFloat(openStr)) ? parseFloat(openStr).toFixed(2) : undefined,
        high: highStr && !isNaN(parseFloat(highStr)) ? parseFloat(highStr).toFixed(2) : undefined,
        low: lowStr && !isNaN(parseFloat(lowStr)) ? parseFloat(lowStr).toFixed(2) : undefined,
        currency: 'HKD',
        market: 'HK',
        timestamp: Date.now(),
        delayed: true,
      };
    } catch (error) {
      this.logger.warn(
        `fetchHkQuoteSina failed for ${symbol}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  /**
   * 港股第三级备选：Yahoo Finance。腾讯与新浪均失败时启用
   * （例如 CDN 层限流导致的 503）。
   */
  async fetchHkQuoteYahoo(symbol: string): Promise<QuoteResponse | null> {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}.HK?interval=1d&range=1d`;
      const response = await firstValueFrom(this.httpService.get(url, { timeout: 8000 }));
      const result = response.data?.chart?.result?.[0];
      if (!result?.meta) return null;
      const meta = result.meta;
      const price = meta.regularMarketPrice;
      const prevClose = meta.chartPreviousClose ?? meta.previousClose;
      if (!price || price <= 0) return null;
      const change = prevClose ? price - prevClose : 0;
      const changePercent = prevClose ? (change / prevClose) * 100 : 0;
      return {
        symbol: `${symbol}.HK`,
        price: price.toFixed(2),
        change: change.toFixed(2),
        changePercent: changePercent.toFixed(2),
        currency: 'HKD',
        market: 'HK',
        timestamp: Date.now(),
        delayed: true,
      };
    } catch (error) {
      this.logger.warn(
        `fetchHkQuoteYahoo failed for ${symbol}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  /**
   * 从腾讯抓取 A 股报价，失败时回退新浪。
   *
   * @param symbol A 股原生代码（6 位）。
   * @param prefix 上游要求交易所前缀：`sh`、`sz` 或 `bj`。
   */
  async fetchCnQuote(symbol: string, prefix: string): Promise<QuoteResponse | null> {
    let primary: QuoteResponse | null = null;
    try {
      const url = `http://qt.gtimg.cn/q=${prefix}${symbol}`;
      const response = await firstValueFrom(
        this.httpService.get(url, { responseType: 'arraybuffer', timeout: 8000 }),
      );

      const text = this.decodeGbk(response.data as ArrayBuffer);
      if (!text) return null;

      // 解析 v_shXXXX="..." 或 v_szXXXX="..." 模式。
      const match = text.match(/v_[a-z]+\d+="([^"]*)"/);
      if (!match) return null;

      // 腾讯 A 股字段以 ~ 分隔，字段数不足 6 视为无效响应。
      const fields = match[1].split('~');
      if (fields.length < 6) return null;

      const name = fields[1] ?? '';
      const currentPrice = parseFloat(fields[3]);
      const prevClose = parseFloat(fields[4]);
      const openStr = fields[5];

      if (isNaN(currentPrice) || currentPrice <= 0) return null;

      // 涨跌幅由昨收推导。
      const change = isNaN(prevClose) || prevClose <= 0 ? 0 : currentPrice - prevClose;
      const changePercent = isNaN(prevClose) || prevClose <= 0 ? 0 : (change / prevClose) * 100;

      // 字段位：33=最高，34=最低，6=成交量（手）。
      const highStr = fields[33] ?? '';
      const lowStr = fields[34] ?? '';
      const volumeStr = fields[6] ?? '';

      const suffix = prefix === 'sh' ? '.SH' : prefix === 'sz' ? '.SZ' : '.BJ';

      primary = {
        symbol: `${symbol}${suffix}`,
        companyName: name || undefined,
        price: currentPrice.toFixed(2),
        change: change.toFixed(2),
        changePercent: changePercent.toFixed(2),
        open: openStr && !isNaN(parseFloat(openStr)) ? parseFloat(openStr).toFixed(2) : undefined,
        high: highStr && !isNaN(parseFloat(highStr)) ? parseFloat(highStr).toFixed(2) : undefined,
        low: lowStr && !isNaN(parseFloat(lowStr)) ? parseFloat(lowStr).toFixed(2) : undefined,
        volume: volumeStr && !isNaN(parseFloat(volumeStr)) ? volumeStr : undefined,
        currency: 'CNY',
        market: 'CN',
        timestamp: Date.now(),
        delayed: true,
      };
    } catch (error) {
      this.logger.warn(
        `fetchCnQuote tencent failed for ${symbol}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // 主源失败时回退新浪。
    if (!primary) {
      try {
        primary = await this.fetchCnQuoteSina(symbol, prefix);
      } catch (error) {
        this.logger.warn(
          `fetchCnQuote sina fallback failed for ${symbol}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return primary;
  }

  /**
   * 从新浪抓取 A 股报价（备选数据源）。
   *
   * @param symbol A 股原生代码（6 位）。
   * @param prefix 交易所前缀：`sh`、`sz` 或 `bj`。
   */
  async fetchCnQuoteSina(symbol: string, prefix: string): Promise<QuoteResponse | null> {
    try {
      const url = `https://hq.sinajs.cn/list=${prefix}${symbol}`;
      const response = await firstValueFrom(
        this.httpService.get(url, {
          responseType: 'arraybuffer',
          timeout: 8000,
          headers: {
            Referer: 'https://finance.sina.com.cn',
          },
        }),
      );

      const text = this.decodeGbk(response.data as ArrayBuffer);
      if (!text) return null;

      const match = text.match(/var hq_str_[a-z]+\d+="([^"]*)"/);
      if (!match) return null;

      // 新浪 A 股字段以逗号分隔，字段数不足 6 视为无效响应。
      const fields = match[1].split(',');
      // 新浪 A 股格式：0=名称,1=开盘,2=昨收,3=现价,4=最高,5=最低,6=买一,7=卖一,8=成交量,...
      if (fields.length < 6) return null;

      const name = fields[0] ?? '';
      const openStr = fields[1];
      const prevCloseStr = fields[2];
      const currentPrice = parseFloat(fields[3]);
      const highStr = fields[4];
      const lowStr = fields[5];
      const volumeStr = fields[8] ?? '';

      const prevClose = parseFloat(prevCloseStr);

      if (isNaN(currentPrice) || currentPrice <= 0) return null;

      // 涨跌幅由昨收推导。
      const change = isNaN(prevClose) || prevClose <= 0 ? 0 : currentPrice - prevClose;
      const changePercent = isNaN(prevClose) || prevClose <= 0 ? 0 : (change / prevClose) * 100;

      const suffix = prefix === 'sh' ? '.SH' : prefix === 'sz' ? '.SZ' : '.BJ';

      return {
        symbol: `${symbol}${suffix}`,
        companyName: name || undefined,
        price: currentPrice.toFixed(2),
        change: change.toFixed(2),
        changePercent: changePercent.toFixed(2),
        open: openStr && !isNaN(parseFloat(openStr)) ? parseFloat(openStr).toFixed(2) : undefined,
        high: highStr && !isNaN(parseFloat(highStr)) ? parseFloat(highStr).toFixed(2) : undefined,
        low: lowStr && !isNaN(parseFloat(lowStr)) ? parseFloat(lowStr).toFixed(2) : undefined,
        volume: volumeStr && !isNaN(parseFloat(volumeStr)) ? volumeStr : undefined,
        currency: 'CNY',
        market: 'CN',
        timestamp: Date.now(),
        delayed: true,
      };
    } catch (error) {
      this.logger.warn(
        `fetchCnQuoteSina failed for ${symbol}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  /**
   * 为用户搜索代码。优先匹配用户自己的持仓与自选（owner 域内）；仅当本地
   * 匹配不足 10 条时才调用外部腾讯 smartbox 端点。结果按显示代码去重，
   * 上限 15 条。
   *
   * @param query  搜索文本。
   * @param userId 用于圈定本地持仓/自选查询范围的归属用户 id。
   */
  async searchStocks(
    query: string,
    userId: string,
  ): Promise<import('@shared/api.interface').StockSearchResult[]> {
    const q = query.trim().toLowerCase();
    if (!q) return [];

    const results: Map<string, import('@shared/api.interface').StockSearchResult> = new Map();

    try {
      // owner 域内并行查询持仓与自选。
      const [holdingRows, watchRows] = await Promise.all([
        this.db
          .select({
            ticker: holdings.ticker,
            company: holdings.company,
            market: holdings.market,
            currency: holdings.currency,
          })
          .from(holdings)
          .where(eq(holdings.owner, userId)),
        this.db
          .select({
            ticker: watchlist.ticker,
            company: watchlist.company,
            market: watchlist.market,
            currency: watchlist.currency,
          })
          .from(watchlist)
          .where(eq(watchlist.owner, userId)),
      ]);

      // 本地匹配：代码或公司名包含搜索词即命中。
      const matchLocal = (
        ticker: string,
        company: string | null,
        market: string,
        currency: string,
        source: 'holding' | 'watchlist',
      ): boolean => {
        const t = ticker.toLowerCase();
        const c = (company || '').toLowerCase();
        return t.includes(q) || c.includes(q);
      };

      // 先收录持仓命中项。
      for (const row of holdingRows) {
        if (matchLocal(row.ticker, row.company, row.market, row.currency, 'holding')) {
          results.set(row.ticker.toUpperCase(), {
            symbol: row.ticker.toUpperCase(),
            companyName: row.company || row.ticker,
            market: row.market as import('@shared/api.interface').Market,
            currency: row.currency as import('@shared/api.interface').Currency,
            source: 'holding',
          });
        }
      }

      // 再收录自选命中项（已收录的代码跳过）。
      for (const row of watchRows) {
        const key = row.ticker.toUpperCase();
        if (results.has(key)) continue;
        if (matchLocal(row.ticker, row.company, row.market, row.currency, 'watchlist')) {
          results.set(key, {
            symbol: key,
            companyName: row.company || row.ticker,
            market: row.market as import('@shared/api.interface').Market,
            currency: row.currency as import('@shared/api.interface').Currency,
            source: 'watchlist',
          });
        }
      }
    } catch (error) {
      this.logger.warn(
        `searchStocks local match failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // 本地结果已够 10 条时跳过外部查询。
    if (results.size >= 10) {
      return Array.from(results.values()).slice(0, 10);
    }

    try {
      // 腾讯 smartbox 联想搜索（文本响应，5 秒超时）。
      const url = `http://smartbox.gtimg.cn/s3/?q=${encodeURIComponent(q)}&t=all`;
      const response = await firstValueFrom(
        this.httpService.get(url, { responseType: 'text', timeout: 5000 }),
      );

      const text = typeof response.data === 'string' ? response.data : '';
      const match = text.match(/v_hint="([^"]*)"/);
      if (!match) return Array.from(results.values()).slice(0, 10);

      // v_hint 值以 ^ 分隔候选项，每项内部以 ~ 分隔字段。
      const items = match[1].split('^');
      for (const item of items) {
        if (results.size >= 15) break;
        const parts = item.split('~');
        if (parts.length < 3) continue;

        const marketCode = parts[0];
        const rawSymbol = parts[1];
        const companyNameRaw = parts[2];

        if (!rawSymbol || !companyNameRaw) continue;

        const companyName = this.cleanCompanyName(companyNameRaw);

        let market: import('@shared/api.interface').Market | null = null;
        let currency: import('@shared/api.interface').Currency | null = null;
        let displaySymbol = '';

        // 把上游市场代码映射为本地市场/币种/显示代码。
        if (marketCode === 'us') {
          market = 'US';
          currency = 'USD';
          // 美股去掉交易所后缀（.oq/.n/.ps/.am）。
          displaySymbol = rawSymbol
            .replace(/\.oq$/i, '')
            .replace(/\.n$/i, '')
            .replace(/\.ps$/i, '')
            .replace(/\.am$/i, '')
            .toUpperCase();
        } else if (marketCode === 'hk') {
          market = 'HK';
          currency = 'HKD';
          // 港股取数字部分并以 parseInt 去掉前导零。
          const numMatch = rawSymbol.match(/(\d+)/);
          const code = numMatch ? numMatch[1] : rawSymbol;
          displaySymbol = `${parseInt(code, 10)}.HK`;
        } else if (marketCode === 'sh' || marketCode === 'sz' || marketCode === 'bj') {
          market = 'CN';
          currency = 'CNY';
          // A 股按交易所加 .SH/.SZ/.BJ 后缀。
          const numMatch = rawSymbol.match(/(\d+)/);
          const code = numMatch ? numMatch[1] : rawSymbol;
          const suffix = marketCode === 'sh' ? '.SH' : marketCode === 'sz' ? '.SZ' : '.BJ';
          displaySymbol = `${code}${suffix}`;
        } else {
          // 未支持的市场代码直接跳过。
          continue;
        }

        const key = displaySymbol.toUpperCase();
        if (results.has(key)) continue;

        results.set(key, {
          symbol: displaySymbol.toUpperCase(),
          companyName: companyName,
          market,
          currency,
          source: 'external',
        });
      }
    } catch (error) {
      this.logger.warn(
        `searchStocks external search failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    return Array.from(results.values()).slice(0, 15);
  }

  /**
   * 把字符串中的 `\uXXXX` 转义序列解码为实际字符。
   *
   * @param s 可能包含 unicode 转义的原始字符串。
   */
  private decodeUnicodeEscape(s: string): string {
    return s.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) =>
      String.fromCharCode(parseInt(hex, 16)),
    );
  }

  /**
   * 清洗上游返回的原始公司名：解码 unicode 转义，并去掉 CJK 字符后
   * 尾随的一个 ASCII 字母。
   *
   * @param raw 原始公司名。
   */
  private cleanCompanyName(raw: string): string {
    let name = raw;
    if (name.includes('\\u')) {
      name = this.decodeUnicodeEscape(name);
    }
    // 去掉紧跟在中文字符后面的一个尾部小写 ASCII 字母。
    name = name.replace(/([\u4e00-\u9fff])[a-z]$/, '$1');
    return name.trim();
  }

  /**
   * 把数据源响应缓冲按 GBK 解码，失败退 UTF-8、再失败退 null。
   * 腾讯/新浪行情端点历来返回 GBK 编码文本。
   *
   * @param buffer 原始响应字节。
   */
  private decodeGbk(buffer: ArrayBuffer): string | null {
    try {
      const decoder = new TextDecoder('gbk');
      return decoder.decode(buffer);
    } catch {
      try {
        return Buffer.from(buffer).toString('utf-8');
      } catch {
        return null;
      }
    }
  }

  /**
   * 刷新用户全部持仓与自选代码的最新价：收集去重后的代码，逐个抓取
   * 报价（上限 `MAX_BATCH_SIZE`），再把新 `currentPrice` 写回 owner 域内
   * 的持仓与自选行。
   *
   * @param userId 圈定读取与写入范围的归属用户 id。
   * @returns 成功刷新的代码数量。
   */
  async batchRefreshPrices(userId: string): Promise<number> {
    try {
      // 汇总用户持仓与自选的全部代码。
      const [holdingRows, watchRows] = await Promise.all([
        this.db
          .select({ ticker: holdings.ticker })
          .from(holdings)
          .where(eq(holdings.owner, userId)),
        this.db
          .select({ ticker: watchlist.ticker })
          .from(watchlist)
          .where(eq(watchlist.owner, userId)),
      ]);

      const tickerSet = new Set<string>();
      for (const row of holdingRows) tickerSet.add(row.ticker);
      for (const row of watchRows) tickerSet.add(row.ticker);

      const tickers = Array.from(tickerSet).slice(0, MAX_BATCH_SIZE);

      let refreshed = 0;
      const priceMap = new Map<string, string>();

      // 逐个代码抓取最新价。
      for (const ticker of tickers) {
        const quote = await this.getQuote(ticker);
        if (quote && quote.price) {
          priceMap.set(ticker, quote.price);
          refreshed += 1;
        }
      }

      // 把更新后的价格并行写回持仓与自选（每个代码两条 update）。
      const updatePromises: Promise<unknown>[] = [];
      for (const [ticker, price] of priceMap) {
        updatePromises.push(
          this.db
            .update(holdings)
            .set({
              currentPrice: price,
              updatedAt: sql`CURRENT_TIMESTAMP`,
              updatedBy: userId,
            })
            .where(sql`${holdings.owner} = ${userId} AND ${holdings.ticker} = ${ticker}`),
        );
        updatePromises.push(
          this.db
            .update(watchlist)
            .set({
              currentPrice: price,
              updatedAt: sql`CURRENT_TIMESTAMP`,
              updatedBy: userId,
            })
            .where(sql`${watchlist.owner} = ${userId} AND ${watchlist.ticker} = ${ticker}`),
        );
      }

      await Promise.all(updatePromises);
      return refreshed;
    } catch (error) {
      this.logger.error(
        `batchRefreshPrices failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 0;
    }
  }
}
