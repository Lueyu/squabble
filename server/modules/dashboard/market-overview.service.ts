import { Injectable } from '@nestjs/common';
import type { Market, MarketOverviewResponse, MarketIndexQuote } from '@shared/api.interface';
import { INDEX_DEFINITIONS, parseIndexQuote, calculateMarketMood } from './market-overview.logic';

const CACHE_MS = 60_000;
const STALE_MAX_MS = 24 * 60 * 60_000;
const MARKETS: Market[] = ['US', 'HK', 'CN'];

/** Public, non-personal market data shared across authenticated requests. */
@Injectable()
export class MarketOverviewService {
  private cached: MarketOverviewResponse | null = null;
  private expiresAt = 0;
  private inFlight: Promise<MarketOverviewResponse> | null = null;

  getOverview(): Promise<MarketOverviewResponse> {
    if (this.cached && Date.now() < this.expiresAt) return Promise.resolve(this.cached);
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.fetchOverview().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async fetchOverview(): Promise<MarketOverviewResponse> {
    let body = '';
    let failed = false;
    try {
      const response = await fetch(
        `https://qt.gtimg.cn/q=${INDEX_DEFINITIONS.map((item) => item.symbol).join(',')}`,
        {
          signal: AbortSignal.timeout(8000),
          headers: { 'User-Agent': 'Squabble/2.0', Accept: 'text/plain' },
        },
      );
      if (!response.ok) throw new Error('Index source unavailable');
      body = new TextDecoder('gbk').decode(await response.arrayBuffer());
    } catch {
      failed = true;
    }
    const now = new Date();
    const indices = INDEX_DEFINITIONS.map((definition) => {
      const quote = parseIndexQuote(body, definition, now);
      if (quote.status !== 'unavailable') return quote;
      const previous = this.cached?.indices.find((item) => item.id === definition.id);
      if (
        previous?.retrievedAt &&
        previous.value !== null &&
        now.getTime() - Date.parse(previous.retrievedAt) <= STALE_MAX_MS
      ) {
        return {
          ...previous,
          status: 'stale',
          issue: failed ? 'fetch_failed' : 'invalid_quote',
        } as MarketIndexQuote;
      }
      return { ...quote, issue: failed ? 'fetch_failed' : quote.issue } as MarketIndexQuote;
    });
    const overview: MarketOverviewResponse = {
      checkedAt: now.toISOString(),
      refreshAfterSeconds: CACHE_MS / 1000,
      indices,
      moods: MARKETS.map((market) => calculateMarketMood(market, indices)),
    };
    this.cached = overview;
    this.expiresAt = Date.now() + CACHE_MS;
    return overview;
  }
}
