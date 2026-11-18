import type { Market } from '../../../shared/api.interface';
import { resolveTradingTicker } from '../../../shared/trading-market.interface';
import type { PortfolioMarketQuote } from '../../database/portfolio-observations.schema';
import { portfolioMarketDay } from './portfolio-metrics';
import { tradingMarketDate, tradingMarketSchedule } from '../paper-trading/trading-market.calendar';

export const VALUATION_MINUTE_MS = 60_000;
export const VALUATION_SLOT_MS = 5 * VALUATION_MINUTE_MS;
export const valuationSlot = (at: Date) => 'sample:' + Math.floor(at.getTime() / VALUATION_SLOT_MS);
export const minuteValuationSlot = (at: Date) => 'minute:' + Math.floor(at.getTime() / VALUATION_MINUTE_MS);
export const isLegacyValuationMinute = (at: Date) => at.getTime() % VALUATION_SLOT_MS < VALUATION_MINUTE_MS;

export function portfolioQuoteSymbol(ticker: string, market: string): string {
    return market === 'HK' && /^\d{1,5}$/u.test(ticker) ? ticker + '.HK' : ticker;
}

export const VALUATION_MARKETS: readonly Market[] = ['CN', 'HK', 'US'];
export const MAX_MINUTE_VALUATION_SYMBOLS = 12;

export interface ValuationSourcePolicy {
    slot: string;
    legacy: boolean;
    blocked(): boolean;
    onThrottle(retryAfterMs: number): Promise<void>;
}

export function valuationMarketPhase(schedule: ReturnType<typeof tradingMarketSchedule>, at: Date): 'open' | 'closing' | 'closed' {
    if (schedule.isOpen)
        return 'open';
    if (schedule.closesAt) {
        const sinceClose = at.getTime() - Date.parse(schedule.closesAt);
        if (sinceClose >= 0 && sinceClose < 20 * VALUATION_MINUTE_MS)
            return 'closing';
    }
    return 'closed';
}

export function shouldSaveValuation(
    at: Date,
    previous: { capturedAt: Date; complete: boolean; sourceFingerprint: string | null; gaps: string[] } | undefined,
    reading: { complete: boolean; sourceFingerprint: string; gaps: string[] },
): boolean {
    if (!previous)
        return true;
    if (previous.capturedAt > at)
        return false;
    return previous.complete !== reading.complete || previous.sourceFingerprint !== reading.sourceFingerprint
        || JSON.stringify([...new Set(previous.gaps)].sort()) !== JSON.stringify([...new Set(reading.gaps)].sort());
}

/** Validate exchange, session and provider time. A closed-market mark may
 * accompany an open constituent, retaining its own last verified quote time. */
export function verifiedMarketQuote(position: {
    ticker: string;
    market: string;
    currency: string;
}, quote: {
    symbol?: string;
    market: string;
    currency: string;
    price: string;
    quoteAt?: string;
    tradingDate?: string;
    source?: string;
} | null | undefined, at: Date): PortfolioMarketQuote | null {
    if (!quote || quote.market !== position.market || quote.currency !== position.currency)
        return null;
    const requested = resolveTradingTicker(portfolioQuoteSymbol(position.ticker, position.market)), received = resolveTradingTicker(quote.symbol ?? '');
    if (!requested || !received || requested.providerSymbol !== received.providerSymbol
        || requested.market !== position.market || requested.currency !== position.currency)
        return null;
    const market = requested.market, time = Date.parse(quote.quoteAt ?? ''), price = Number(quote.price);
    const now = at.getTime();
    if (!Number.isFinite(time) || !Number.isFinite(price) || price <= 0 || time > now + 120_000)
        return null;
    const expected = portfolioMarketDay(market, at), quotedDay = tradingMarketDate(market, new Date(time));
    if (!expected || quote.tradingDate !== expected || quotedDay !== expected)
        return null;
    const schedule = tradingMarketSchedule(market, at), quotedSchedule = tradingMarketSchedule(market, new Date(time));
    if (!schedule.calendarVerified || !quotedSchedule.opensAt || !quotedSchedule.closesAt)
        return null;
    const active = schedule.sessions.find(session => Date.parse(session.opensAt) <= now && now < Date.parse(session.closesAt));
    if (active) {
        if (time < Date.parse(active.opensAt) || time >= Date.parse(active.closesAt) || now - time > 20 * VALUATION_MINUTE_MS)
            return null;
    } else {
        const officialClose = Date.parse(quotedSchedule.closesAt);
        const earlierSession = quotedSchedule.sessions.filter(session => Date.parse(session.closesAt) <= now).at(-1);
        // During lunch or CN's auction, require a mark near the just-ended
        // continuous session. Once officially closed, use the daily close window.
        const sessionEnd = now < officialClose && earlierSession ? Date.parse(earlierSession.closesAt) : officialClose;
        const grace = sessionEnd === officialClose ? 120_000 : 0;
        if (time < sessionEnd - 15 * VALUATION_MINUTE_MS || time > sessionEnd + grace)
            return null;
    }
    return { ticker: position.ticker, market, currency: position.currency, price, quoteAt: new Date(time).toISOString(), source: quote.source ?? 'unknown' };
}
