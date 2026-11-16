/**
 * @file hooks/use-market-quotes.ts
 * @brief Live market-quote subscription with per-market polling.
 *
 * Exposes `useMarketQuotes(tickers)` to any component. Under the hood a module-
 * level `QuoteScheduler` singleton merges all subscribers' tickers, batches
 * quotes per market (US/HK/CN), and polls on a phase-aware cadence:
 *   - 60s while the market is in continuous trading
 *   - 5min during pre/post market
 *   - 10min while closed
 * It also pauses timers when the tab is hidden and refreshes immediately on
 * visibility change, so background tabs do not hammer the quote API.
 */
import { useEffect, useRef, useState, useCallback } from 'react';
import http from '../api/http';
import { logger } from '../utils/logger';
import { tickerVariants } from '../utils/ticker';
import type { QuoteResponse, Market } from '@shared/api.interface';

/**
 * Market session state used to choose the polling cadence.
 */
export type MarketPhase = 'trading' | 'pre' | 'post' | 'closed';

// Poll intervals per phase (ms).
const TRADING_INTERVAL = 60 * 1000; // 60s during trading
const PRE_POST_INTERVAL = 5 * 60 * 1000; // 5min pre/post
const IDLE_INTERVAL = 10 * 60 * 1000; // 10min closed

/** IANA time zones used to convert UTC into each market's local wall clock. */
const MARKET_TIMEZONES: Record<Market, string> = {
  US: 'America/New_York',
  HK: 'Asia/Hong_Kong',
  CN: 'Asia/Shanghai',
};

/** A single trading-session window expressed in minutes-of-day (market-local). */
type TimeSession = { start: number; end: number; phase: MarketPhase };

// Minute-of-day ranges (market-local time) for each market.
const MARKET_SESSIONS: Record<Market, TimeSession[]> = {
  US: [
    { start: 4 * 60, end: 9 * 60 + 30, phase: 'pre' },
    { start: 9 * 60 + 30, end: 16 * 60, phase: 'trading' },
    { start: 16 * 60, end: 20 * 60, phase: 'post' },
  ],
  HK: [
    { start: 9 * 60 + 30, end: 12 * 60, phase: 'trading' },
    { start: 13 * 60, end: 16 * 60, phase: 'trading' },
  ],
  CN: [
    { start: 9 * 60 + 30, end: 11 * 60 + 30, phase: 'trading' },
    { start: 13 * 60, end: 15 * 60, phase: 'trading' },
  ],
};

/** All markets the scheduler tracks. */
const ALL_MARKETS: Market[] = ['US', 'HK', 'CN'];

/**
 * Infer the market a ticker belongs to from its shape.
 *  - `.HK` suffix or 5-digit number -> Hong Kong
 *  - 6-digit number -> China A-shares
 *  - anything else -> US-listed
 * @param ticker - Raw ticker string as stored on a holding/watch item.
 * @returns The resolved `Market`.
 */
export function inferMarket(ticker: string): Market {
  const clean = ticker.trim().toUpperCase();
  if (/\.HK$/.test(clean)) return 'HK';
  if (/^\d{5,6}$/.test(clean)) return clean.length === 6 ? 'CN' : 'HK';
  return 'US';
}

/**
 * Convert a UTC Date into the market-local weekday/hour/minute.
 * Uses `Intl.DateTimeFormat` with the market's IANA zone so the math stays
 * correct across DST changes.
 * @param market - Target market.
 * @param date - UTC Date to convert.
 * @returns Local weekday (0=Sun), 24h hour and minute.
 */
function getMarketLocalTime(
  market: Market,
  date: Date,
): {
  weekday: number;
  hour: number;
  minute: number;
} {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: MARKET_TIMEZONES[market],
    weekday: 'short',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  }).formatToParts(date);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  const weekdayMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  return {
    weekday: weekdayMap[get('weekday')] ?? 0,
    hour: parseInt(get('hour'), 10) || 0,
    minute: parseInt(get('minute'), 10) || 0,
  };
}

/**
 * Compute the current market phase for a given market.
 * @param market - Market to evaluate.
 * @param date - Optional date (defaults to now); mainly used for tests.
 * @returns One of `trading | pre | post | closed`.
 */
export function isMarketTrading(market: Market, date?: Date): MarketPhase {
  const now = date ?? new Date();
  const { weekday, hour, minute } = getMarketLocalTime(market, now);

  // Weekend -> closed
  if (weekday === 0 || weekday === 6) return 'closed';

  const minuteOfDay = hour * 60 + minute;
  const sessions = MARKET_SESSIONS[market];

  for (const session of sessions) {
    if (minuteOfDay >= session.start && minuteOfDay < session.end) {
      return session.phase;
    }
  }
  return 'closed';
}

/**
 * Pick the polling interval appropriate for a market phase.
 * @param phase - Current market phase.
 * @returns Interval in milliseconds.
 */
function intervalForPhase(phase: MarketPhase): number {
  if (phase === 'trading') return TRADING_INTERVAL;
  if (phase === 'pre' || phase === 'post') return PRE_POST_INTERVAL;
  return IDLE_INTERVAL;
}

/** Payload handed to every subscriber callback on each quote refresh. */
type SubscribeCallback = (data: {
  quotes: Record<string, QuoteResponse>;
  marketStatus: Record<Market, MarketPhase>;
  marketErrors: Record<Market, boolean>;
  lastUpdated: Date | null;
}) => void;

/**
 * Singleton quote scheduler shared by all `useMarketQuotes` consumers.
 * It deduplicates tickers across subscribers, batches requests per market,
 * and drives phase-aware timers with tab-visibility awareness.
 */
class QuoteScheduler {
  private tickers = new Set<string>();
  private subscribers = new Map<SubscribeCallback, string[]>();
  private quotes: Record<string, QuoteResponse> = {};
  private marketStatus: Record<Market, MarketPhase> = {
    US: 'closed',
    HK: 'closed',
    CN: 'closed',
  };
  private marketErrors: Record<Market, boolean> = {
    US: false,
    HK: false,
    CN: false,
  };
  private marketLastUpdated: Record<Market, Date | null> = {
    US: null,
    HK: null,
    CN: null,
  };
  private lastUpdated: Date | null = null;
  private marketTimers: Record<Market, number | null> = { US: null, HK: null, CN: null };
  private marketNextRefresh: Record<Market, number> = { US: 0, HK: 0, CN: 0 };
  private visibilityHandler: (() => void) | null = null;
  private visible = true;
  private marketFetching: Record<Market, boolean> = { US: false, HK: false, CN: false };

  /**
   * Register a subscriber for the given tickers.
   * Immediately emits the current cache so the caller renders synchronously,
   * kicks off a first fetch for any newly-covered market, and (lazily) starts
   * the visibility listener.
   * @param tickers - Tickers this consumer cares about.
   * @param callback - Invoked on every subsequent quote refresh.
   */
  subscribe(tickers: string[], callback: SubscribeCallback): void {
    const prevSize = this.tickers.size;
    const uniqueTickers = Array.from(new Set(tickers));
    for (const t of uniqueTickers) this.tickers.add(t);
    this.subscribers.set(callback, uniqueTickers);

    // Recompute phases for all markets with tickers.
    this.refreshMarketStatus();

    callback({
      quotes: this.quotes,
      marketStatus: { ...this.marketStatus },
      marketErrors: { ...this.marketErrors },
      lastUpdated: this.lastUpdated,
    });

    if (this.visibilityHandler === null) this.startVisibilityListener();
    this.scheduleAllMarkets();
    if (this.tickers.size > prevSize && this.visible) {
      // Immediately fetch markets that gained new tickers.
      const grouped = this.groupTickersByMarket();
      for (const m of ALL_MARKETS) {
        if (grouped[m].length > 0 && this.marketLastUpdated[m] === null) {
          void this.fetchMarketBatch(m);
        }
      }
    }
  }

  /**
   * Remove a subscriber. If no subscribers remain, all timers and the
   * visibility listener are torn down and the ticker set is cleared.
   * @param callback - The callback previously passed to `subscribe`.
   */
  unsubscribe(callback: SubscribeCallback): void {
    this.subscribers.delete(callback);
    if (this.subscribers.size === 0) {
      this.tickers.clear();
      this.stopAllTimers();
      this.stopVisibilityListener();
      return;
    }
    // Rebuild ticker set from remaining subscribers.
    this.rebuildTickers();
    this.scheduleAllMarkets();
  }

  /** Rebuild the global ticker union from the active subscribers' ticker lists. */
  private rebuildTickers(): void {
    this.tickers.clear();
    for (const ts of this.subscribers.values()) {
      for (const t of ts) this.tickers.add(t);
    }
  }

  /** Force an immediate refresh of every market that currently has subscribers. */
  refresh(): void {
    const grouped = this.groupTickersByMarket();
    for (const m of ALL_MARKETS) {
      if (grouped[m].length > 0) void this.fetchMarketBatch(m);
    }
  }

  // ---- internals ----

  /** Group the global ticker union into per-market buckets. */
  private groupTickersByMarket(): Record<Market, string[]> {
    const result: Record<Market, string[]> = { US: [], HK: [], CN: [] };
    for (const t of this.tickers) result[inferMarket(t)].push(t);
    return result;
  }

  /** Re-evaluate every market's trading phase (used on subscription/refresh). */
  private refreshMarketStatus(): void {
    for (const m of ALL_MARKETS) {
      this.marketStatus[m] = isMarketTrading(m);
    }
  }

  /**
   * Start the `visibilitychange` listener. When the tab becomes visible we
   * immediately refresh all markets and reschedule timers; when hidden we
   * stop timers to avoid background polling.
   */
  private startVisibilityListener(): void {
    if (typeof document === 'undefined') return;
    this.visibilityHandler = () => {
      this.visible = document.visibilityState === 'visible';
      if (this.visible) {
        // Page became visible — refresh immediately and restart all timers.
        this.stopAllTimers();
        const grouped = this.groupTickersByMarket();
        const fetches: Promise<void>[] = [];
        for (const m of ALL_MARKETS) {
          if (grouped[m].length > 0) {
            fetches.push(this.fetchMarketBatch(m));
          }
        }
        Promise.all(fetches).finally(() => this.scheduleAllMarkets());
      } else {
        this.stopAllTimers();
      }
    };
    document.addEventListener('visibilitychange', this.visibilityHandler);
    this.visible = document.visibilityState === 'visible';
  }

  /** Detach the `visibilitychange` listener (called when subscribers drain). */
  private stopVisibilityListener(): void {
    if (this.visibilityHandler && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.visibilityHandler);
      this.visibilityHandler = null;
    }
  }

  /** Clear all per-market pending timers. */
  private stopAllTimers(): void {
    for (const m of ALL_MARKETS) {
      if (this.marketTimers[m] !== null) {
        window.clearTimeout(this.marketTimers[m]);
        this.marketTimers[m] = null;
      }
    }
  }

  /** Clear the pending timer for a single market (if any). */
  private stopMarketTimer(market: Market): void {
    if (this.marketTimers[market] !== null) {
      window.clearTimeout(this.marketTimers[market]);
      this.marketTimers[market] = null;
    }
  }

  /** (Re)start timers for every market that currently has at least one ticker. */
  private scheduleAllMarkets(): void {
    if (!this.visible) return;
    const grouped = this.groupTickersByMarket();
    for (const m of ALL_MARKETS) {
      if (grouped[m].length > 0) {
        this.scheduleMarket(m);
      } else {
        this.stopMarketTimer(m);
      }
    }
  }

  /**
   * Schedule the next poll for a single market based on its current phase.
   * After the fetch resolves, this method re-schedules itself so the cadence
   * adapts as the market moves between pre/trading/post/closed.
   */
  private scheduleMarket(market: Market): void {
    this.stopMarketTimer(market);
    if (!this.visible) return;
    const phase = isMarketTrading(market);
    // Also update stored phase (it may have changed since last check).
    this.marketStatus[market] = phase;
    const interval = intervalForPhase(phase);
    this.marketNextRefresh[market] = Date.now() + interval;
    this.marketTimers[market] = window.setTimeout(() => {
      void this.fetchMarketBatch(market).finally(() => {
        this.scheduleMarket(market);
      });
    }, interval);
  }

  /**
   * Fetch a batch of quotes for one market. Concurrent calls are collapsed by
   * the `marketFetching` guard. On success the cache is updated for both the
   * raw provider symbol and the normalized local symbol; on failure the last
   * known prices are kept and `marketErrors` is raised so the UI can show a
   * stale-data indicator.
   */
  private async fetchMarketBatch(market: Market): Promise<void> {
    if (!this.visible) return;
    if (this.marketFetching[market]) return;

    const grouped = this.groupTickersByMarket();
    const symbols = grouped[market];
    if (symbols.length === 0) return;

    this.marketFetching[market] = true;

    // Recompute market phase independently of fetch result.
    this.marketStatus[market] = isMarketTrading(market);

    try {
      const resp = await http.get<{ items: QuoteResponse[] }>('/api/quote/batch', {
        params: { symbols: symbols.join(',') },
      });
      const items = resp.data?.items;
      if (!Array.isArray(items)) {
        logger.warn(`行情响应格式异常 (${market})`, resp.data);
        this.marketErrors[market] = true;
      } else {
        let gotAny = false;
        for (const q of items) {
          if (!q || typeof q.price === 'undefined' || q.price === null) continue;
          // Store under every equivalent spelling of the symbol so lookups by
          // the holding's own storage form (e.g. '0700' vs provider '00700',
          // '600519' vs '600519.SH') always hit.
          for (const key of tickerVariants(q.symbol, q.market ?? market)) {
            this.quotes[key] = q;
          }
          gotAny = true;
        }
        this.marketErrors[market] = !gotAny;
        if (gotAny) {
          this.marketLastUpdated[market] = new Date();
        }
      }
    } catch (err) {
      logger.warn(`行情请求失败 (${market})`, err);
      // Keep last prices; marketStatus unchanged.
      this.marketErrors[market] = true;
    } finally {
      this.marketFetching[market] = false;
      this.updateGlobalLastUpdated();
      this.emit();
    }
  }

  /** Roll the global `lastUpdated` up from the per-market last-success timestamps. */
  private updateGlobalLastUpdated(): void {
    let latest: Date | null = null;
    for (const m of ALL_MARKETS) {
      const t = this.marketLastUpdated[m];
      if (t !== null && (latest === null || t > latest)) latest = t;
    }
    this.lastUpdated = latest;
  }

  /** Broadcast a snapshot of the current cache to every subscriber. */
  private emit(): void {
    if (this.subscribers.size === 0) return;
    const payload = {
      quotes: { ...this.quotes },
      marketStatus: { ...this.marketStatus },
      marketErrors: { ...this.marketErrors },
      lastUpdated: this.lastUpdated,
    };
    for (const cb of this.subscribers.keys()) {
      try {
        cb(payload);
      } catch (err) {
        logger.error('行情订阅回调异常', err);
      }
    }
  }

  // ---- diagnostic ----

  /**
   * Return a diagnostic snapshot of every market's phase, local time, next
   * refresh, last update and error state. Exposed on `window.__pt.getMarketStatus`
   * for troubleshooting live quote behavior in production.
   */
  getMarketStatus(): {
    utcNow: string;
    markets: Record<
      Market,
      {
        phase: MarketPhase;
        timezone: string;
        localTime: string;
        weekday: number;
        nextRefresh: number;
        lastUpdated: Date | null;
        error: boolean;
        tickerCount: number;
      }
    >;
  } {
    const now = new Date();
    const grouped = this.groupTickersByMarket();
    const markets = {} as Record<
      Market,
      {
        phase: MarketPhase;
        timezone: string;
        localTime: string;
        weekday: number;
        nextRefresh: number;
        lastUpdated: Date | null;
        error: boolean;
        tickerCount: number;
      }
    >;
    for (const m of ALL_MARKETS) {
      const local = getMarketLocalTime(m, now);
      const hh = local.hour < 10 ? `0${local.hour}` : String(local.hour);
      const mm = local.minute < 10 ? `0${local.minute}` : String(local.minute);
      markets[m] = {
        phase: isMarketTrading(m, now),
        timezone: MARKET_TIMEZONES[m],
        localTime: `${hh}:${mm}`,
        weekday: local.weekday,
        nextRefresh: this.marketNextRefresh[m],
        lastUpdated: this.marketLastUpdated[m],
        error: this.marketErrors[m],
        tickerCount: grouped[m].length,
      };
    }
    return { utcNow: now.toISOString(), markets };
  }
}

/** All markets (re-exported for callers that need to iterate). */
const ALL_MARKETS_EXPORT: Market[] = ['US', 'HK', 'CN'];

// Module-level singleton shared by every useMarketQuotes consumer.
const scheduler = new QuoteScheduler();

/**
 * Compute the current phase of every market without subscribing to quotes.
 * Useful for badges that only need to know whether "any market" is open.
 * @returns `anyTrading` (true if at least one market is in continuous trading)
 *          and a per-market phase map.
 */
export function getAggregateMarketStatus(): {
  anyTrading: boolean;
  statuses: Record<Market, MarketPhase>;
} {
  const statuses = {} as Record<Market, MarketPhase>;
  let anyTrading = false;
  for (const m of ALL_MARKETS_EXPORT) {
    const phase = isMarketTrading(m);
    statuses[m] = phase;
    if (phase === 'trading') anyTrading = true;
  }
  return { anyTrading, statuses };
}

/**
 * Force an immediate quote refresh across all subscribed markets.
 * Bound to the "Refresh" button on quote-bearing pages.
 */
export function forceRefreshAllQuotes(): void {
  scheduler.refresh();
}

// Expose diagnostic API on window (extend existing __pt if present).
if (typeof window !== 'undefined') {
  const w = window as unknown as { __pt?: Record<string, unknown> };
  if (!w.__pt) w.__pt = {};
  w.__pt.getMarketStatus = () => scheduler.getMarketStatus();
}

// ---- Hook ----

/**
 * React hook that subscribes the calling component to live quotes for the
 * given tickers. All consumers share the module-level `QuoteScheduler`, so
 * N components rendering the same tickers produce exactly one network batch.
 *
 * The subscription is re-created whenever the ordered ticker list changes
 * (joined into a string for the dep array to avoid referential churn).
 *
 * @param tickers - Tickers to stream quotes for.
 * @returns Cached quotes map (keyed by raw and normalized symbols), per-market
 *          phase and error maps, the last-success timestamp, and a `refresh`
 *          callback that forces an immediate refetch.
 */
export function useMarketQuotes(tickers: string[]): {
  quotes: Record<string, QuoteResponse>;
  marketStatus: Record<Market, MarketPhase>;
  marketErrors: Record<Market, boolean>;
  lastUpdated: Date | null;
  refresh: () => void;
} {
  const [quotes, setQuotes] = useState<Record<string, QuoteResponse>>({});
  const [marketStatus, setMarketStatus] = useState<Record<Market, MarketPhase>>({
    US: 'closed',
    HK: 'closed',
    CN: 'closed',
  });
  const [marketErrors, setMarketErrors] = useState<Record<Market, boolean>>({
    US: false,
    HK: false,
    CN: false,
  });
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const tickersRef = useRef<string[]>([]);

  const callbackRef = useRef<SubscribeCallback | null>(null);

  const refresh = useCallback(() => {
    scheduler.refresh();
  }, []);

  useEffect(() => {
    const next = tickers.slice();

    // If previous subscription exists, clean it up first.
    if (callbackRef.current) {
      scheduler.unsubscribe(callbackRef.current);
      callbackRef.current = null;
    }

    if (next.length === 0) {
      tickersRef.current = [];
      return;
    }

    const cb: SubscribeCallback = ({
      quotes: qs,
      marketStatus: ms,
      marketErrors: me,
      lastUpdated: lu,
    }) => {
      setQuotes(qs);
      setMarketStatus(ms);
      setMarketErrors(me);
      setLastUpdated(lu);
    };

    callbackRef.current = cb;
    tickersRef.current = next;
    scheduler.subscribe(next, cb);

    return () => {
      if (callbackRef.current) {
        scheduler.unsubscribe(callbackRef.current);
        callbackRef.current = null;
      }
      tickersRef.current = [];
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tickers.join(',')]);

  return { quotes, marketStatus, marketErrors, lastUpdated, refresh };
}
