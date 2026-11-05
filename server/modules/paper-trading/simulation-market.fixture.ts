import type { TradingMarketSnapshot } from '../../../shared/trading-market.interface';
import { tradingMarketSchedule } from './trading-market.calendar';

/** Offline fixture adapter. Tests can override the calendar while production always uses the provider. */
export function simulationMarketFixture(quote: { price: string; market: string; currency: string; timestamp: number } | null,
  forceOpen = false): TradingMarketSnapshot {
  const market = (quote?.market ?? 'US') as 'US' | 'HK' | 'CN';
  const schedule = tradingMarketSchedule(market, new Date());
  if (forceOpen) {
    schedule.isOpen = true; schedule.calendarVerified = true;
    schedule.sessions = [{ opensAt: new Date(Date.now() - 3600_000).toISOString(), closesAt: new Date(Date.now() + 3600_000).toISOString() }];
  }
  const valid = Boolean(quote && Number.isFinite(Number(quote.price)) && Number(quote.price) > 0
    && Math.abs(Date.now() - quote.timestamp) <= 300_000 && schedule.isOpen);
  return { ticker: 'fixture', providerSymbol: 'fixture', market, currency: (quote?.currency ?? 'USD') as 'USD' | 'HKD' | 'CNY',
    usable: valid, reason: valid ? null : 'quote_unavailable', quoteUsable: valid, quoteReason: valid ? null : 'quote_unavailable',
    source: 'yahoo-chart', sourceUrl: 'https://example.invalid/fixture', fetchedAt: new Date().toISOString(),
    quoteTimestamp: quote ? new Date(quote.timestamp).toISOString() : null, price: quote ? Number(quote.price) : null,
    delay: 'possibly-delayed', maxQuoteAgeSeconds: 300, timeframe: '1d', candles: [], indicators: null, schedule,
    corporateActions: [], corporateActionsChecked: true };
}
