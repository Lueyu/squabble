/**
 * Quote service.
 *
 * Provides market data for US / HK / CN stocks. It resolves a ticker's market and
 * currency (`detectMarket`), then fetches live quotes from free public providers
 * (Tencent qt.gtimg.cn, Sina hq.sinajs.cn, Yahoo Finance) with an in-memory TTL
 * cache. Each market has a primary provider and a fallback provider; responses are
 * GBK-decoded and parsed from the providers' custom delimited text formats. It also
 * powers ticker search (matching the user's own holdings/watchlist first, then the
 * Tencent smartbox) and a batch price refresh that writes prices back into the
 * caller's holdings/watchlist rows.
 */
import { Injectable, Inject, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '../../common/platform';
import { eq, sql } from 'drizzle-orm';
import { firstValueFrom } from 'rxjs';
import { holdings, watchlist } from '@server/database/schema';
import type { QuoteResponse, Market, Currency } from '@shared/api.interface';
import { tradingMarketDate } from '../paper-trading/trading-market.calendar';
import { tencentObservedUsQuote } from './us-observed-quote';

function quoteReading(market: Market, previousClose: number, source: string, observed?: number | string): Partial<QuoteResponse> {
  let quoteAt: string | undefined;
  if(typeof observed==='number'&&Number.isFinite(observed)&&observed>0)quoteAt=new Date(observed*1000).toISOString();
  // Tencent HK/CN timestamps use their exchange wall clock. The US fallback's
  // undocumented wall-clock field is intentionally not treated as verified.
  if(typeof observed==='string'&&market!=='US'&&/^\d{14}$/u.test(observed)) {
    const y=Number(observed.slice(0,4)),m=Number(observed.slice(4,6)),d=Number(observed.slice(6,8));
    const h=Number(observed.slice(8,10)),minute=Number(observed.slice(10,12)),second=Number(observed.slice(12,14));
    if(m>=1&&m<=12&&d>=1&&d<=31&&h<24&&minute<60&&second<60)quoteAt=new Date(Date.UTC(y,m-1,d,h-8,minute,second)).toISOString();
  }
  return {previousClose:Number.isFinite(previousClose)&&previousClose>0?String(previousClose):undefined,source,quoteAt,
    tradingDate:quoteAt?tradingMarketDate(market,new Date(quoteAt)):undefined};
}

/** Derived market/currency/symbol metadata for a ticker. */
interface MarketInfo {
  /** Target exchange: US, HK, or CN. */
  market: Market;
  /** Quote currency for the market (USD/HKD/CNY). */
  currency: Currency;
  /** Human-readable display symbol (e.g. `AAPL`, `700.HK`, `600519.SH`). */
  displaySymbol: string;
  /** Provider-native symbol used in upstream API calls. */
  symbolNative: string;
}

/** A cached quote entry with an absolute expiry time. */
interface CacheEntry {
  /** The cached quote payload. */
  value: QuoteResponse;
  /** Unix-millisecond time after which the entry is stale. */
  expiresAt: number;
}

/** Maximum number of symbols resolved in a single batch request. */
const MAX_BATCH_SIZE = 30;
/** How long a fetched quote stays in the in-memory cache. */
const CACHE_TTL_MS = 60_000;

/**
 * Fetches and caches stock quotes across markets. Depends on the Drizzle database
 * (for search and price refresh) and the Axios `HttpService` (for upstream calls).
 */
@Injectable()
export class QuoteService {
  private readonly logger = new Logger(QuoteService.name);
  /** In-memory TTL cache keyed by `MarketInfo.displaySymbol`. */
  private readonly quoteCache = new Map<string, CacheEntry>();

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly httpService: HttpService,
  ) {}

  /**
   * Infers the market, currency, and display/native symbols for a ticker purely
   * from its spelling: explicit suffixes (.HK/.SH/.SZ/.BJ) take priority, then
   * digit-pattern heuristics (5 digits -> HK; 6 digits -> CN exchange by leading
   * digit), defaulting to US/USD.
   *
   * @param symbol The user-supplied ticker.
   * @returns Resolved market metadata.
   */
  detectMarket(symbol: string): MarketInfo {
    const upper = symbol.toUpperCase().trim();

    // Explicit suffix detection.
    if (upper.endsWith('.HK')) {
      const codePart = upper.slice(0, -3);
      const numeric = codePart.replace(/\D/g, '');
      // HK native codes are zero-padded to 5 digits.
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

    // Pure numeric detection.
    if (/^\d+$/.test(upper)) {
      // 4-digit -> HK (e.g. 0700, the app's holdings storage form).
      // 5-digit -> HK (e.g. 00700, provider-native form).
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
      // 6-digit -> CN A-share; leading digit selects the exchange.
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

    // Default: US market.
    return {
      market: 'US',
      currency: 'USD',
      displaySymbol: upper,
      symbolNative: upper,
    };
  }

  /**
   * Returns the latest quote for a symbol, using the TTL cache when fresh and
   * fetching from the market-appropriate provider otherwise.
   *
   * @param symbol Ticker to resolve.
   * @returns The quote, or null if all providers failed.
   */
  async getQuote(symbol: string): Promise<QuoteResponse | null> {
    const info = this.detectMarket(symbol);
    const cacheKey = info.displaySymbol;

    // Return cached value if still fresh.
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
        // CN provider endpoints need an sh/sz/bj prefix.
        const prefix = info.displaySymbol.endsWith('.SH') || info.displaySymbol.endsWith('.SS')
          ? 'sh'
          : info.displaySymbol.endsWith('.SZ')
            ? 'sz'
            : 'bj';
        result = await this.fetchCnQuote(info.symbolNative, prefix);
      }

      if (result) {
        this.quoteCache.set(cacheKey, {
          value: result,
          expiresAt: Date.now() + CACHE_TTL_MS,
        });
      }
      return result;
    } catch (error) {
      this.logger.warn(`getQuote failed for ${symbol}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /**
   * Resolves quotes for many symbols in parallel, de-duplicating and capping the
   * list to `MAX_BATCH_SIZE`.
   *
   * @param symbols List of tickers.
   * @returns Quotes that could be resolved (unresolved symbols are skipped).
   */
  async getBatchQuotes(symbols: string[]): Promise<QuoteResponse[]> {
    const unique = Array.from(new Set(symbols.map((s: string) => s.trim()).filter(Boolean))).slice(0, MAX_BATCH_SIZE);
    const results: QuoteResponse[] = [];
    const promises = unique.map(async (sym: string) => {
      const q = await this.getQuote(sym);
      if (q) results.push(q);
    });
    await Promise.all(promises);
    return results;
  }

  /**
   * Fetches a US quote from Tencent, falling back to Yahoo on failure.
   *
   * @param symbol US ticker (uppercase).
   */
  async fetchUsQuote(symbol: string): Promise<QuoteResponse | null> {
    const observed = await this.fetchUsQuoteYahoo(symbol);
    if(observed)return observed;
    let primary: QuoteResponse | null = null;
    try {
      const url = `http://qt.gtimg.cn/q=us${symbol.toUpperCase()}`;
      const response = await firstValueFrom(
        this.httpService.get(url, { responseType: 'arraybuffer', timeout: 8000 }),
      );

      // Tencent returns GBK-encoded text.
      const text = this.decodeGbk(response.data as ArrayBuffer);
      if (!text) return null;

      const match = text.match(/v_us[a-zA-Z0-9.]+="([^"]*)"/);
      if (!match) return null;

      const fields = match[1].split('~');
      if (fields.length < 35) return null;

      const currentPrice = parseFloat(fields[3]);
      const prevClose = parseFloat(fields[4]);
      const changeStr = fields[31];
      const changePercentStr = fields[32];

      if (isNaN(currentPrice) || currentPrice <= 0) return null;

      // Derive change/percent if the provider omits them.
      const changeVal = parseFloat(changeStr);
      const changePercentVal = parseFloat(changePercentStr);
      const change = isNaN(changeVal) ? (isNaN(prevClose) || prevClose <= 0 ? 0 : currentPrice - prevClose) : changeVal;
      const changePercent = isNaN(changePercentVal) ? (isNaN(prevClose) || prevClose <= 0 ? 0 : (change / prevClose) * 100) : changePercentVal;

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
        ...quoteReading('US',prevClose,'tencent'),
        timestamp: Date.now(),
        delayed: true,
      };
    } catch (error) {
      this.logger.warn(`fetchUsQuote tencent failed for ${symbol}: ${error instanceof Error ? error.message : String(error)}`);
    }

    // Fallback to Yahoo when the primary provider failed.
    if (!primary) {
      try {
        const yahooResult = await this.fetchUsQuoteYahoo(symbol);
        if (yahooResult) return yahooResult;
      } catch (error) {
        this.logger.warn(`fetchUsQuote yahoo fallback failed for ${symbol}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    return primary;
  }

  /** Sampling-only source: ordinary quote/order selection keeps its existing behavior. */
  async fetchUsObservedQuote(symbol: string, at = new Date()): Promise<QuoteResponse | null> {
    const requested = symbol.toUpperCase();
    if (!/^[A-Z][A-Z0-9.-]{0,19}$/u.test(requested)) return null;
    try {
      const response = await firstValueFrom(this.httpService.get('https://web.ifzq.gtimg.cn/appstock/app/usMinute/query', {
        params: { code: `us${requested}` }, timeout: 7000, maxContentLength: 1_000_000,
        headers: { Accept: 'application/json' },
      }));
      return tencentObservedUsQuote(response.data, requested, at);
    } catch { return null; }
  }

  /**
   * Fetches a US quote from the Yahoo Finance chart API (fallback provider).
   *
   * @param symbol US ticker.
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
              regularMarketTime?: number;
              symbol?: string;
            };
          }>;
        };
      };

      const meta = data?.chart?.result?.[0]?.meta;
      if (!meta) return null;

      const price = meta.regularMarketPrice;
      const prevClose = meta.chartPreviousClose;

      if (typeof price !== 'number' || isNaN(price) || price <= 0) return null;

      const change = (typeof prevClose === 'number' && prevClose > 0) ? price - prevClose : 0;
      const changePercent = (typeof prevClose === 'number' && prevClose > 0) ? (change / prevClose) * 100 : 0;

      return {
        symbol: (meta.symbol ?? symbol).toUpperCase(),
        price: price.toFixed(2),
        change: change.toFixed(2),
        changePercent: changePercent.toFixed(2),
        open: typeof meta.regularMarketOpen === 'number' ? meta.regularMarketOpen.toFixed(2) : undefined,
        high: typeof meta.regularMarketDayHigh === 'number' ? meta.regularMarketDayHigh.toFixed(2) : undefined,
        low: typeof meta.regularMarketDayLow === 'number' ? meta.regularMarketDayLow.toFixed(2) : undefined,
        volume: typeof meta.regularMarketVolume === 'number' ? String(meta.regularMarketVolume) : undefined,
        currency: 'USD',
        market: 'US',
        ...quoteReading('US',prevClose??NaN,'yahoo',meta.regularMarketTime),
        timestamp: Date.now(),
        delayed: true,
      };
    } catch (error) {
      this.logger.warn(`fetchUsQuoteYahoo failed for ${symbol}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /**
   * Fetches an HK quote from Tencent, falling back to Sina on failure.
   *
   * @param symbol HK native code (5 digits).
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

      // Parse v_hkXXXX="..." pattern.
      const match = text.match(/v_hk\d+="([^"]*)"/);
      if (!match) return null;

      const fields = match[1].split('~');
      if (fields.length < 7) return null;

      const currentPrice = parseFloat(fields[3]);
      const prevClose = parseFloat(fields[4]);
      const changeStr = fields[31];
      const changePercentStr = fields[32];

      if (isNaN(currentPrice) || currentPrice <= 0) return null;

      const changeVal = parseFloat(changeStr);
      const changePercentVal = parseFloat(changePercentStr);
      const change = isNaN(changeVal) ? (isNaN(prevClose) || prevClose <= 0 ? 0 : currentPrice - prevClose) : changeVal;
      const changePercent = isNaN(changePercentVal) ? (isNaN(prevClose) || prevClose <= 0 ? 0 : (change / prevClose) * 100) : changePercentVal;

      const openStr = fields[5];
      const highStr = fields[33];
      const lowStr = fields[34];
      const volumeStr = fields[6] ?? '';
      const name = fields[1] ?? '';

      // Display code drops a leading zero on 5-digit HK codes.
      const displayCode = symbol.startsWith('0') && symbol.length === 5
        ? symbol.slice(1)
        : symbol;

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
        ...quoteReading('HK',prevClose,'tencent',fields[30]),
        timestamp: Date.now(),
        delayed: true,
      };
    } catch (error) {
      this.logger.warn(`fetchHkQuote tencent failed for ${symbol}: ${error instanceof Error ? error.message : String(error)}`);
    }

    // Fallback to Sina if primary failed.
    if (!primary) {
      try {
        primary = await this.fetchHkQuoteSina(symbol);
      } catch (error) {
        this.logger.warn(`fetchHkQuote sina fallback failed for ${symbol}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // Fallback chain: Sina, then Yahoo.
    if (!primary) {
      primary = await this.fetchHkQuoteSina(symbol);
    }
    if (!primary) {
      primary = await this.fetchHkQuoteYahoo(symbol);
    }
    return primary;
  }

  /**
   * Fetches an HK quote from Sina (fallback provider). Requires a Referer header
   * for Sina to answer.
   *
   * @param symbol HK native code (5 digits).
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

      const fields = match[1].split(',');
      // Sina HK format: 0=name,1=open,2=prevClose,3=high,4=low,5=last,6=change,7=changePct,...
      if (fields.length < 8) return null;

      const name = fields[0] ?? '';
      const openStr = fields[1];
      const prevCloseStr = fields[2];
      const highStr = fields[3];
      const lowStr = fields[4];
      const currentPrice = parseFloat(fields[5]);
      const prevClose = parseFloat(prevCloseStr);

      if (isNaN(currentPrice) || currentPrice <= 0) return null;

      const change = isNaN(prevClose) || prevClose <= 0 ? 0 : currentPrice - prevClose;
      const changePercent = isNaN(prevClose) || prevClose <= 0 ? 0 : (change / prevClose) * 100;

      const displayCode = symbol.startsWith('0') && symbol.length === 5
        ? symbol.slice(1)
        : symbol;

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
        ...quoteReading('HK',prevClose,'sina'),
        timestamp: Date.now(),
        delayed: true,
      };
    } catch (error) {
      this.logger.warn(`fetchHkQuoteSina failed for ${symbol}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /**
   * Third-tier HK quote fallback: Yahoo Finance. Used when both Tencent and
   * Sina fail (e.g. 503s from CDN-level rate limiting).
   */
  async fetchHkQuoteYahoo(symbol: string): Promise<QuoteResponse | null> {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}.HK?interval=1d&range=1d`;
      const response = await firstValueFrom(
        this.httpService.get(url, { timeout: 8000 }),
      );
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
        ...quoteReading('HK',prevClose??NaN,'yahoo',meta.regularMarketTime),
        timestamp: Date.now(),
        delayed: true,
      };
    } catch (error) {
      this.logger.warn(`fetchHkQuoteYahoo failed for ${symbol}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /**
   * Fetches a CN A-share quote from Tencent, falling back to Sina on failure.
   *
   * @param symbol CN native code (6 digits).
   * @param prefix Exchange prefix required by the provider: `sh`, `sz`, or `bj`.
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

      // Parse v_shXXXX="..." or v_szXXXX="..." pattern.
      const match = text.match(/v_[a-z]+\d+="([^"]*)"/);
      if (!match) return null;

      const fields = match[1].split('~');
      if (fields.length < 6) return null;

      const name = fields[1] ?? '';
      const currentPrice = parseFloat(fields[3]);
      const prevClose = parseFloat(fields[4]);
      const openStr = fields[5];

      if (isNaN(currentPrice) || currentPrice <= 0) return null;

      const change = isNaN(prevClose) || prevClose <= 0 ? 0 : currentPrice - prevClose;
      const changePercent = isNaN(prevClose) || prevClose <= 0 ? 0 : (change / prevClose) * 100;

      // Index 33 = high, 34 = low, 6 = volume (in lots).
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
        ...quoteReading('CN',prevClose,'tencent',fields[30]),
        timestamp: Date.now(),
        delayed: true,
      };
    } catch (error) {
      this.logger.warn(`fetchCnQuote tencent failed for ${symbol}: ${error instanceof Error ? error.message : String(error)}`);
    }

    // Fallback to Sina if primary failed.
    if (!primary) {
      try {
        primary = await this.fetchCnQuoteSina(symbol, prefix);
      } catch (error) {
        this.logger.warn(`fetchCnQuote sina fallback failed for ${symbol}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    return primary;
  }

  /**
   * Fetches a CN A-share quote from Sina (fallback provider).
   *
   * @param symbol CN native code (6 digits).
   * @param prefix Exchange prefix: `sh`, `sz`, or `bj`.
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

      const fields = match[1].split(',');
      // Sina CN format: 0=name,1=open,2=prevClose,3=last,4=high,5=low,6=bid,7=ask,8=volume,...
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
      this.logger.warn(`fetchCnQuoteSina failed for ${symbol}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /**
   * Searches tickers for a user. It first matches the user's own holdings and
   * watchlist (owner-scoped), and only if fewer than 10 local matches exist does it
   * query the external Tencent smartbox endpoint. Results are de-duplicated by
   * display symbol and capped at 15.
   *
   * @param query  Search text.
   * @param userId Owner id used to scope the local holdings/watchlist lookup.
   */
  async searchStocks(
    query: string,
    userId: string,
  ): Promise<import('@shared/api.interface').StockSearchResult[]> {
    const q = query.trim().toLowerCase();
    if (!q) return [];

    const results: Map<string, import('@shared/api.interface').StockSearchResult> =
      new Map();

    try {
      // Owner-scoped local lookups for holdings and watchlist.
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

    // Enough local results; skip the external lookup.
    if (results.size >= 10) {
      return Array.from(results.values()).slice(0, 10);
    }

    try {
      const url = `http://smartbox.gtimg.cn/s3/?q=${encodeURIComponent(q)}&t=all`;
      const response = await firstValueFrom(
        this.httpService.get(url, { responseType: 'text', timeout: 5000 }),
      );

      const text = typeof response.data === 'string' ? response.data : '';
      const match = text.match(/v_hint="([^"]*)"/);
      if (!match) return Array.from(results.values()).slice(0, 10);

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

        // Map the provider's market code to our market/currency/display symbol.
        if (marketCode === 'us') {
          market = 'US';
          currency = 'USD';
          displaySymbol = rawSymbol
            .replace(/\.oq$/i, '')
            .replace(/\.n$/i, '')
            .replace(/\.ps$/i, '')
            .replace(/\.am$/i, '')
            .toUpperCase();
        } else if (marketCode === 'hk') {
          market = 'HK';
          currency = 'HKD';
          const numMatch = rawSymbol.match(/(\d+)/);
          const code = numMatch ? numMatch[1] : rawSymbol;
          displaySymbol = `${parseInt(code, 10)}.HK`;
        } else if (marketCode === 'sh' || marketCode === 'sz' || marketCode === 'bj') {
          market = 'CN';
          currency = 'CNY';
          const numMatch = rawSymbol.match(/(\d+)/);
          const code = numMatch ? numMatch[1] : rawSymbol;
          const suffix = marketCode === 'sh' ? '.SH' : marketCode === 'sz' ? '.SZ' : '.BJ';
          displaySymbol = `${code}${suffix}`;
        } else {
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
   * Decodes `\uXXXX` escapes inside a string into actual characters.
   *
   * @param s Raw string possibly containing unicode escapes.
   */
  private decodeUnicodeEscape(s: string): string {
    return s.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) =>
      String.fromCharCode(parseInt(hex, 16)),
    );
  }

  /**
   * Cleans a raw company name from the provider: decodes unicode escapes and
   * strips a trailing ASCII letter appended after CJK characters.
   *
   * @param raw Raw company name.
   */
  private cleanCompanyName(raw: string): string {
    let name = raw;
    if (name.includes('\\u')) {
      name = this.decodeUnicodeEscape(name);
    }
    // Remove a trailing lowercase ASCII letter that follows a CJK character.
    name = name.replace(/([\u4e00-\u9fff])[a-z]$/, '$1');
    return name.trim();
  }

  /**
   * Decodes a provider response buffer as GBK, falling back to UTF-8, then null.
   * Tencent/Sina quote endpoints historically return GBK-encoded text.
   *
   * @param buffer Raw response bytes.
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
   * Refreshes current prices for all of a user's holdings and watchlist tickers:
   * collects the distinct tickers, fetches a fresh quote for each (capped at
   * `MAX_BATCH_SIZE`), and writes the new `currentPrice` back to both holdings and
   * watchlist rows, scoped to the owner.
   *
   * @param userId Owner id scoping which rows are read and written.
   * @returns The number of tickers successfully refreshed.
   */
  async batchRefreshPrices(userId: string): Promise<number> {
    try {
      // Collect all tickers from the user's holdings and watchlist.
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

      for (const ticker of tickers) {
        const quote = await this.getQuote(ticker);
        if (quote && quote.price) {
          priceMap.set(ticker, quote.price);
          refreshed += 1;
        }
      }

      // Write updated prices back to holdings and watchlist, in parallel per ticker.
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
            .where(
              sql`${holdings.owner} = ${userId} AND ${holdings.ticker} = ${ticker}`,
            ),
        );
        updatePromises.push(
          this.db
            .update(watchlist)
            .set({
              currentPrice: price,
              updatedAt: sql`CURRENT_TIMESTAMP`,
              updatedBy: userId,
            })
            .where(
              sql`${watchlist.owner} = ${userId} AND ${watchlist.ticker} = ${ticker}`,
            ),
        );
      }

      await Promise.all(updatePromises);
      return refreshed;
    } catch (error) {
      this.logger.error(`batchRefreshPrices failed: ${error instanceof Error ? error.message : String(error)}`);
      return 0;
    }
  }
}
