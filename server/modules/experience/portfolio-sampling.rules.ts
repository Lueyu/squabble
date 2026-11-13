import type { Market } from '../../../shared/api.interface';
import type { PortfolioMarketQuote } from '../../database/portfolio-observations.schema';
import { portfolioMarketDay } from './portfolio-metrics';
import { tradingMarketDate, tradingMarketSchedule } from '../paper-trading/trading-market.calendar';
import { resolveTradingTicker } from '../../../shared/trading-market.interface';
export const VALUATION_SLOT_MS = 5 * 60000;
export const valuationSlot = (at: Date) => `sample:${Math.floor(at.getTime() / VALUATION_SLOT_MS)}`;
/** Delayed public quotes are allowed for valuation, with a bounded provider age in session.
 * Outside a session only its verified closing observation is reusable; unchanged source
 * fingerprints are suppressed by the writer rather than becoming new market readings. */
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
    if (!quote || !['US', 'HK', 'CN'].includes(position.market) || quote.market !== position.market || quote.currency !== position.currency)
        return null;
    const requested = resolveTradingTicker(position.ticker), received = resolveTradingTicker(quote.symbol ?? '');
    if (!requested || !received || requested.providerSymbol !== received.providerSymbol || requested.market !== position.market)
        return null;
    const market = position.market as Market, time = Date.parse(quote.quoteAt ?? ''), price = Number(quote.price);
    if (!Number.isFinite(time) || !Number.isFinite(price) || price <= 0 || time > at.getTime() + 120000)
        return null;
    const expected = portfolioMarketDay(market, at), quotedDay = tradingMarketDate(market, new Date(time));
    if (!expected || quote.tradingDate !== expected || quotedDay !== expected)
        return null;
    const schedule = tradingMarketSchedule(market, at), quotedSchedule = tradingMarketSchedule(market, new Date(time));
    if (!schedule.calendarVerified || !quotedSchedule.opensAt || !quotedSchedule.closesAt)
        return null;
    const inSession = schedule.isTradingDay && schedule.opensAt && schedule.closesAt
        && at.getTime() >= Date.parse(schedule.opensAt) && at.getTime() < Date.parse(schedule.closesAt);
    if (time < Date.parse(quotedSchedule.opensAt) || time > Date.parse(quotedSchedule.closesAt) + 120000)
        return null;
    if (inSession ? at.getTime() - time > 20 * 60000 : time < Date.parse(quotedSchedule.closesAt) - 15 * 60000)
        return null;
    return { ticker: position.ticker, market: position.market, currency: position.currency, price, quoteAt: new Date(time).toISOString(), source: quote.source ?? 'unknown' };
}
