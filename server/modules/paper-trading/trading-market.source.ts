import type {
  TradingMarketCandle, TradingMarketSnapshot, TradingTicker,
} from '@shared/trading-market.interface';
import { lastCompletedTradingDate, tradingMarketDate, tradingMarketSchedule } from './trading-market.calendar';
import { calculateTradingIndicators, validTradingCandle } from './trading-market.indicators';

export const MAX_QUOTE_AGE_SECONDS = 20 * 60;
export const YAHOO_CHART_BASE = 'https://query1.finance.yahoo.com/v8/finance/chart/';
// Yahoo documents exchange suffixes and possible delays, not a stable public chart API SLA:
// https://help.yahoo.com/kb/yahoo-finance-plus/partnerships-sln2310.html
const EXCHANGES = { US: ['NMS', 'NGM', 'NCM', 'NYQ', 'ASE', 'PCX', 'BATS'], HK: ['HKG'], CN: ['SHH', 'SHZ'] };

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function epoch(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value < 253402300800
    ? value * 1000 : null;
}

export function emptyTradingSnapshot(ticker: string, now: Date, info: TradingTicker | null): TradingMarketSnapshot {
  return { ticker: info?.ticker ?? ticker, providerSymbol: info?.providerSymbol ?? null,
    market: info?.market ?? null, currency: info?.currency ?? null,
    quoteUsable: false, quoteReason: 'unsupported_ticker', usable: false, reason: 'unsupported_ticker',
    source: 'yahoo-chart', sourceUrl: info ? `${YAHOO_CHART_BASE}${encodeURIComponent(info.providerSymbol)}?interval=1d&range=6mo` : null,
    fetchedAt: now.toISOString(), quoteTimestamp: null, price: null, delay: 'possibly-delayed',
    maxQuoteAgeSeconds: MAX_QUOTE_AGE_SECONDS, timeframe: '1d', candles: [], indicators: null,
    schedule: info ? tradingMarketSchedule(info.market, now) : null };
}

function normalizeCandles(result: Record<string, unknown>, info: TradingTicker, now: Date,
  lastCompletedDate: string): TradingMarketCandle[] | null {
  const timestamps = result.timestamp;
  const quotes = object(result.indicators)?.quote;
  const quote = Array.isArray(quotes) ? object(quotes[0]) : null;
  if (!Array.isArray(timestamps) || timestamps.length === 0 || timestamps.length > 300 || !quote) return null;
  const keys = ['open', 'high', 'low', 'close', 'volume'] as const;
  if (keys.some(key => !Array.isArray(quote[key]) || (quote[key] as unknown[]).length !== timestamps.length)) return null;
  const candles: TradingMarketCandle[] = [];
  const dates = new Set<string>();
  for (let index = 0; index < timestamps.length; index++) {
    const timestamp = epoch(timestamps[index]);
    if (timestamp === null || timestamp > now.getTime()) return null;
    const date = tradingMarketDate(info.market, new Date(timestamp));
    if (dates.has(date)) return null;
    dates.add(date);
    if (date > lastCompletedDate) continue;
    const values = keys.map(key => (quote[key] as unknown[])[index]);
    if (values.some(value => typeof value !== 'number')) return null;
    const [open, high, low, close, volume] = values as number[];
    const candle = { timestamp: new Date(timestamp).toISOString(), open, high, low, close, volume };
    if (!validTradingCandle(candle)) return null;
    candles.push(candle);
  }
  return candles.sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp));
}

/** Recomputed on cache hits so retrieval freshness can never refresh a stale exchange quote. */
export function parseTradingSnapshot(payload: unknown, info: TradingTicker,
  fetchedAt: string, now: Date): TradingMarketSnapshot {
  const snapshot = emptyTradingSnapshot(info.ticker, now, info);
  snapshot.fetchedAt = fetchedAt;
  const chart = object(object(payload)?.chart);
  const results = chart?.result;
  const result = Array.isArray(results) && results.length === 1 ? object(results[0]) : null;
  const meta = object(result?.meta);
  const timestamp = epoch(meta?.regularMarketTime);
  if (!result || !meta || chart?.error || meta.symbol !== info.providerSymbol || meta.currency !== info.currency
    || !EXCHANGES[info.market].includes(String(meta.exchangeName))
    || meta.exchangeTimezoneName !== snapshot.schedule?.timezone
    || !['EQUITY', 'ETF'].includes(String(meta.instrumentType))
    || typeof meta.regularMarketPrice !== 'number' || !Number.isFinite(meta.regularMarketPrice)
    || meta.regularMarketPrice <= 0 || timestamp === null) {
    snapshot.quoteReason = snapshot.reason = 'source_invalid';
    return snapshot;
  }
  snapshot.price = meta.regularMarketPrice;
  snapshot.quoteTimestamp = new Date(timestamp).toISOString();
  if (timestamp > now.getTime() + 60_000) { snapshot.quoteReason = snapshot.reason = 'quote_future'; return snapshot; }
  const active = snapshot.schedule?.sessions.find(session => Date.parse(session.opensAt) <= now.getTime()
    && now.getTime() < Date.parse(session.closesAt));
  snapshot.quoteReason = !snapshot.schedule?.calendarVerified ? 'calendar_unavailable'
    : !snapshot.schedule.isOpen || !active ? 'market_closed'
      : now.getTime() - timestamp > MAX_QUOTE_AGE_SECONDS * 1000 || timestamp < Date.parse(active.opensAt)
        ? 'quote_stale' : null;
  snapshot.quoteUsable = snapshot.quoteReason === null;
  const completedDate = lastCompletedTradingDate(info.market, now);
  if (!completedDate) { snapshot.reason = 'calendar_unavailable'; return snapshot; }
  const candles = normalizeCandles(result, info, now, completedDate);
  if (!candles || candles.length === 0) { snapshot.reason = 'history_invalid'; return snapshot; }
  snapshot.candles = candles;
  if (candles.length < 50) { snapshot.reason = 'history_insufficient'; return snapshot; }
  if (tradingMarketDate(info.market, new Date(candles.at(-1)!.timestamp)) !== completedDate) {
    snapshot.reason = 'history_stale'; return snapshot;
  }
  snapshot.indicators = calculateTradingIndicators(candles);
  if (!snapshot.indicators) { snapshot.reason = 'history_invalid'; return snapshot; }
  snapshot.usable = snapshot.quoteUsable;
  snapshot.reason = snapshot.quoteReason;
  return snapshot;
}
