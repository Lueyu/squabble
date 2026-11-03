/** Public, possibly delayed market data. All timestamps are ISO UTC instants. */
export type TradingMarket = 'US' | 'HK' | 'CN';

export interface TradingTicker {
  ticker: string;
  providerSymbol: string;
  market: TradingMarket;
  currency: 'USD' | 'HKD' | 'CNY';
}

export interface TradingMarketCandle {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface TradingMarketIndicators {
  sma20: number;
  sma50: number;
  /** Wilder smoothing, seeded with the first 14 close-to-close changes. */
  rsi14: number;
  /** Wilder smoothing, seeded with 14 true ranges using a previous close. */
  atr14: number;
  /** Last completed daily volume / mean volume of the preceding 20 bars. */
  volumeRatio: number;
  asOf: string;
  sampleSize: number;
  timeframe: '1d';
}

export interface TradingMarketSession {
  opensAt: string;
  closesAt: string;
}

export interface TradingMarketSchedule {
  market: TradingMarket;
  timezone: string;
  tradingDate: string;
  calendarVerified: boolean;
  isTradingDay: boolean;
  /** Continuous trading only; excludes lunch breaks and closing auctions. */
  isOpen: boolean;
  opensAt: string | null;
  /** Official daily close; CN includes its closing auction after continuous trading ends. */
  closesAt: string | null;
  nextOpenAt: string | null;
  earlyClose: boolean;
  reason: string | null;
  sessions: TradingMarketSession[];
  sourceUrls: string[];
  calendarVersion: string;
}

export interface TradingMarketSnapshot {
  ticker: string;
  providerSymbol: string | null;
  market: TradingMarket | null;
  currency: 'USD' | 'HKD' | 'CNY' | null;
  /** Valid quote/session for a protective exit, independent of historical indicators. */
  quoteUsable: boolean;
  quoteReason: string | null;
  /** New strategy signals additionally require sufficient valid completed daily history. */
  usable: boolean;
  reason: string | null;
  source: 'yahoo-chart';
  sourceUrl: string | null;
  /** Retrieval time, never substituted for the provider's quote timestamp. */
  fetchedAt: string;
  quoteTimestamp: string | null;
  price: number | null;
  delay: 'possibly-delayed';
  maxQuoteAgeSeconds: number;
  timeframe: '1d';
  /** Completed daily candles only; today's incomplete bar is excluded. */
  candles: TradingMarketCandle[];
  indicators: TradingMarketIndicators | null;
  schedule: TradingMarketSchedule | null;
}

/** Strict allowlist; a ticker can never select a host or arbitrary URL. */
export function resolveTradingTicker(value: string): TradingTicker | null {
  const ticker = value.trim().toUpperCase();
  const hk = /^(\d{1,5})\.HK$/u.exec(ticker) ?? /^(\d{4,5})$/u.exec(ticker);
  if (hk && Number(hk[1]) > 0) {
    const code = String(Number(hk[1])).padStart(4, '0');
    return { ticker: `${code}.HK`, providerSymbol: `${code}.HK`, market: 'HK', currency: 'HKD' };
  }
  const cn = /^([603]\d{5}|0\d{5})(?:\.(SH|SS|SZ))?$/u.exec(ticker);
  if (cn) {
    const exchange = cn[1].startsWith('6') ? 'SH' : 'SZ';
    if (cn[2] && (cn[2] === 'SS' ? 'SH' : cn[2]) !== exchange) return null;
    return { ticker: `${cn[1]}.${exchange}`, providerSymbol: `${cn[1]}.${exchange === 'SH' ? 'SS' : 'SZ'}`,
      market: 'CN', currency: 'CNY' };
  }
  // Only class A/B suffixes are treated as US share classes; foreign suffixes are rejected.
  if (/^[A-Z]{1,6}(?:[.-][AB])?$/u.test(ticker)) {
    return { ticker, providerSymbol: ticker.replace('.', '-'), market: 'US', currency: 'USD' };
  }
  return null;
}
