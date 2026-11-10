import { Injectable } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { historySymbol, type HistoryFx, type HistoryPrice, utcDay } from './portfolio-history.rules';

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : null;
const validDay = (value: string) => /^\d{4}-\d{2}-\d{2}$/u.test(value) && Number.isFinite(Date.parse(value)) && utcDay(new Date(value)) === value;
const marketDay = (market: string, at: Date) => new Intl.DateTimeFormat('en-CA', {
  timeZone: market === 'US' ? 'America/New_York' : market === 'HK' ? 'Asia/Hong_Kong' : 'Asia/Shanghai',
  year: 'numeric', month: '2-digit', day: '2-digit',
}).format(at);

export function tencentNativeSymbol(ticker: string, market: string): string {
  const identity = historySymbol(ticker, market);
  if (!identity) throw new Error('HISTORY_SYMBOL_UNSUPPORTED');
  if (market === 'US') return `us${identity.symbol.replaceAll('-', '.')}`;
  if (market === 'HK') return `hk${identity.symbol.split('.')[0].padStart(5, '0')}`;
  return `${identity.symbol.endsWith('.SS') ? 'sh' : identity.symbol.endsWith('.BJ') ? 'bj' : 'sz'}${identity.symbol.slice(0, 6)}`;
}

/** Verify the provider's quoted identity before accepting either the series or its US exchange suffix. */
export function tencentResponseSymbol(data: unknown, native: string, ticker: string, market: string): string {
  const response = object(data), series = object(object(response?.data)?.[native]);
  const quote = object(series?.qt)?.[native];
  if (response?.code !== 0 || !series || !Array.isArray(quote) || typeof quote[2] !== 'string') throw new Error('HISTORY_PROVIDER_RESPONSE_INVALID');
  const actual = quote[2].toUpperCase(), identity = historySymbol(ticker, market)!;
  if (market === 'US') {
    const requested = identity.symbol.replaceAll('-', '.');
    if (actual !== requested && (!actual.startsWith(`${requested}.`) || !/^[A-Z]{1,4}$/u.test(actual.slice(requested.length + 1)))) throw new Error('HISTORY_PROVIDER_SYMBOL_MISMATCH');
    return `us${actual}`;
  }
  if (!/^\d+$/u.test(actual) || Number(actual) !== Number(identity.symbol.split('.')[0])) throw new Error('HISTORY_PROVIDER_SYMBOL_MISMATCH');
  return native;
}

/** Empty adjustment parameter requests day, never dividend-adjusted qfqday/hfqday. */
export function tencentDailyCloses(data: unknown, native: string, ticker: string, market: string, from: string, to: string, at: Date): HistoryPrice[] {
  tencentResponseSymbol(data, native, ticker, market);
  const identity = historySymbol(ticker, market)!;
  const series = object(object(object(data)?.data)?.[native]);
  if (!Array.isArray(series?.day)) throw new Error('HISTORY_UNADJUSTED_CLOSE_UNAVAILABLE');
  const unique = new Map<string, HistoryPrice>(), today = marketDay(market, at);
  for (const row of series.day) {
    if (!Array.isArray(row) || typeof row[0] !== 'string' || !validDay(row[0]) || row[0] < from || row[0] > to || row[0] >= today) continue;
    const close = typeof row[2] === 'number' || typeof row[2] === 'string' && row[2].trim() ? Number(row[2]) : NaN;
    if (!Number.isFinite(close) || close <= 0) continue;
    unique.set(row[0], { ...identity, priceDate: row[0], close: String(close), source: 'tencent:unadjusted-close' });
  }
  return [...unique.values()].sort((a, b) => a.priceDate.localeCompare(b.priceDate));
}

/** Yahoo close is split-adjusted, unlike adjclose which also includes dividend adjustments. */
export function yahooDailyCloses(data: unknown, ticker: string, market: string, from: string, to: string, at: Date): HistoryPrice[] {
  const identity = historySymbol(ticker, market);
  if (!identity) throw new Error('HISTORY_SYMBOL_UNSUPPORTED');
  const chart = object(object(data)?.chart), results = chart?.result;
  const result = object(Array.isArray(results) ? results[0] : null), meta = object(result?.meta);
  if (chart?.error || !result || meta?.currency !== identity.currency || typeof meta.symbol !== 'string'
    || meta.symbol.toUpperCase() !== identity.symbol) throw new Error('HISTORY_PROVIDER_RESPONSE_INVALID');
  const timestamps = result.timestamp, quoteRows = object(result.indicators)?.quote;
  const closes = object(Array.isArray(quoteRows) ? quoteRows[0] : null)?.close;
  if (!Array.isArray(timestamps) || !Array.isArray(closes)) throw new Error('HISTORY_PROVIDER_RESPONSE_INVALID');
  const timeZone = market === 'US' ? 'America/New_York' : market === 'HK' ? 'Asia/Hong_Kong' : 'Asia/Shanghai';
  const dateOf = (value: Date) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(value);
  const today = dateOf(at), unique = new Map<string, HistoryPrice>();
  for (const [index, timestamp] of timestamps.entries()) {
    const close = closes[index];
    if (typeof timestamp !== 'number' || !Number.isFinite(timestamp) || timestamp * 1000 > at.getTime()
      || typeof close !== 'number' || !Number.isFinite(close) || close <= 0) continue;
    const priceDate = dateOf(new Date(timestamp * 1000));
    // Never label an unfinished current-day bar as the historical close.
    if (priceDate < from || priceDate > to || priceDate >= today) continue;
    unique.set(priceDate, { ...identity, priceDate, close: String(close), source: 'yahoo:split-adjusted-close' });
  }
  return [...unique.values()].sort((a, b) => a.priceDate.localeCompare(b.priceDate));
}

export function frankfurterDailyFx(data: unknown, from: string, to: string, at: Date): HistoryFx[] {
  const response = object(data), rates = object(response?.rates);
  if (response?.base !== 'USD' || !rates) throw new Error('HISTORY_FX_RESPONSE_INVALID');
  const rows: HistoryFx[] = [];
  for (const [rateDate, values] of Object.entries(rates)) {
    if (!validDay(rateDate) || rateDate < from || rateDate > to || rateDate > utcDay(at)) continue;
    const quotes = object(values);
    for (const currency of ['HKD', 'CNY']) {
      const rate = quotes?.[currency];
      if (typeof rate === 'number' && Number.isFinite(rate) && rate > 0) rows.push({ currency, rateDate, usdRate: String(1 / rate), source: 'frankfurter:ecb-daily' });
    }
  }
  return rows;
}

@Injectable()
export class PortfolioHistoryProvider {
  constructor(private readonly http: HttpService) {}

  async prices(ticker: string, market: string, from: string, to: string, at: Date): Promise<HistoryPrice[]> {
    const identity = historySymbol(ticker, market);
    if (!identity) throw new Error('HISTORY_SYMBOL_UNSUPPORTED');
    try {
      let native = tencentNativeSymbol(ticker, market);
      let data = await this.tencent(native);
      const resolved = tencentResponseSymbol(data, native, ticker, market);
      if (resolved !== native) { native = resolved; data = await this.tencent(native); }
      const prices = tencentDailyCloses(data, native, ticker, market, from, to, at);
      if (prices.length) return prices;
    } catch { /* Public provider fallback retains its own adjustment provenance. */ }
    const period1 = Math.floor(Date.parse(from) / 1000), period2 = Math.floor(Date.parse(to) / 1000) + 86_400;
    for (const host of ['query1.finance.yahoo.com', 'query2.finance.yahoo.com']) {
      try {
        const response = await firstValueFrom(this.http.get(`https://${host}/v8/finance/chart/${encodeURIComponent(identity.symbol)}`, {
          params: { interval: '1d', period1, period2, events: 'splits', includeAdjustedClose: false },
          timeout: 7000, maxContentLength: 2_000_000,
          headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
        }));
        const prices = yahooDailyCloses(response.data, ticker, market, from, to, at);
        if (prices.length) return prices;
      } catch { /* Try the existing provider's alternate host; no invented fallback price. */ }
    }
    throw new Error('HISTORY_PRICES_UNAVAILABLE');
  }

  private async tencent(native: string): Promise<unknown> {
    const response = await firstValueFrom(this.http.get('https://web.ifzq.gtimg.cn/appstock/app/fqkline/get', {
      params: { param: `${native},day,,,380,` }, timeout: 7000, maxContentLength: 2_000_000,
      headers: { Accept: 'application/json' },
    }));
    return response.data;
  }

  async fx(from: string, to: string, at: Date): Promise<HistoryFx[]> {
    const response = await firstValueFrom(this.http.get(`https://api.frankfurter.dev/v1/${from}..${to}`, {
      params: { base: 'USD', symbols: 'HKD,CNY' }, timeout: 8000, maxContentLength: 1_000_000,
    }));
    const rows = frankfurterDailyFx(response.data, from, to, at);
    if (!rows.length) throw new Error('HISTORY_FX_UNAVAILABLE');
    return rows;
  }
}
