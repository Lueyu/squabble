import { HttpService } from '@nestjs/axios';
import { Inject, Injectable } from '@nestjs/common';
import { firstValueFrom, timeout } from 'rxjs';
import type { TradingMarket, TradingMarketSchedule, TradingMarketSnapshot } from '@shared/trading-market.interface';
import { resolveTradingTicker } from '@shared/trading-market.interface';
import { tradingMarketSchedule } from './trading-market.calendar';
import { emptyTradingSnapshot, parseTradingSnapshot } from './trading-market.source';

interface SourceEntry { payload: unknown; fetchedAt: string; expiresAt: number; failed: boolean }

const MAX_CACHE_ENTRIES = 256;
const MAX_IN_FLIGHT = 32;

@Injectable()
export class TradingMarketService {
  private readonly cache = new Map<string, SourceEntry>();
  private readonly pending = new Map<string, Promise<SourceEntry>>();

  constructor(@Inject(HttpService) private readonly http: HttpService) {}

  async getSchedule(market: TradingMarket, now = new Date()): Promise<TradingMarketSchedule> {
    return tradingMarketSchedule(market, now);
  }

  async getSnapshot(ticker: string, now = new Date(), forceRefresh = false): Promise<TradingMarketSnapshot> {
    const info = resolveTradingTicker(ticker);
    const snapshot = emptyTradingSnapshot(ticker, now, info);
    if (!info) return snapshot;
    if (!snapshot.schedule?.calendarVerified) {
      snapshot.quoteReason = snapshot.reason = 'calendar_unavailable'; return snapshot;
    }
    const entry = this.cache.get(info.providerSymbol);
    const cached = !forceRefresh && entry && entry.expiresAt > now.getTime()
      && Date.parse(entry.fetchedAt) <= now.getTime() ? entry : null;
    let request = this.pending.get(info.providerSymbol);
    if (!cached && !request) {
      if (this.pending.size >= MAX_IN_FLIGHT) { snapshot.quoteReason = snapshot.reason = 'source_busy'; return snapshot; }
      request = this.fetchSource(snapshot.sourceUrl!, now);
      this.pending.set(info.providerSymbol, request);
    }
    const source = cached ?? await request!;
    if (!cached) {
      this.pending.delete(info.providerSymbol);
      this.cache.delete(info.providerSymbol);
      this.cache.set(info.providerSymbol, source);
      while (this.cache.size > MAX_CACHE_ENTRIES) this.cache.delete(this.cache.keys().next().value!);
    }
    if (source.failed) {
      snapshot.fetchedAt = source.fetchedAt;
      snapshot.quoteReason = snapshot.reason = 'source_unavailable';
      return snapshot;
    }
    return parseTradingSnapshot(source.payload, info, source.fetchedAt, now);
  }

  private async fetchSource(url: string, now: Date): Promise<SourceEntry> {
    const fetchedAt = now.toISOString();
    try {
      const response = await firstValueFrom(this.http.get<unknown>(url, {
        timeout: 8000, maxRedirects: 0, maxContentLength: 1_048_576, maxBodyLength: 1_048_576,
        responseType: 'json', transitional: { silentJSONParsing: false },
        headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 Squabble-Paper/1.0' },
      }).pipe(timeout(9000)));
      return { payload: response.data, fetchedAt, expiresAt: now.getTime() + 60_000, failed: false };
    } catch {
      // Explicit unavailable result; never substitute stored prices or fabricated bars.
      return { payload: null, fetchedAt, expiresAt: now.getTime() + 15_000, failed: true };
    }
  }
}
