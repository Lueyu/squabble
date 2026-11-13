import type { QuoteResponse } from '../../../shared/api.interface';
import { tradingMarketSchedule } from '../paper-trading/trading-market.calendar';

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : null;
const positive = (value: unknown) => typeof value === 'string' && value.trim() && Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : null;

/** Accept US wall-clock time only with explicit provider season and matching minute evidence. */
export function tencentObservedUsQuote(payload: unknown, symbol: string, at: Date): QuoteResponse | null {
  if (!/^[A-Z][A-Z0-9.-]{0,19}$/u.test(symbol)) return null;
  const response = object(payload), native = `us${symbol}`;
  const entry = object(object(response?.data)?.[native]), quote = object(entry?.qt)?.[native];
  const minutes = object(entry?.data), season = object(entry?.pandata)?.season;
  if (response?.code !== 0 || !Array.isArray(quote) || !Array.isArray(minutes?.data) || !minutes.data.length
    || !['EST', 'EDT'].includes(String(season))) return null;
  const identity = quote[2];
  if (typeof identity !== 'string' || identity !== symbol && (!identity.startsWith(`${symbol}.`) || !/^[A-Z]{1,4}$/u.test(identity.slice(symbol.length + 1)))) return null;
  const price = positive(quote[3]), previousClose = positive(quote[4]);
  const wall = typeof quote[30] === 'string' ? quote[30] : '';
  const match = wall.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/u);
  if (!match || price === null) return null;
  const [year, month, date, hour, minute, second] = match.slice(1).map(Number);
  if (month < 1 || month > 12 || date < 1 || date > 31 || hour > 23 || minute > 59 || second > 59) return null;
  const instant = new Date(Date.UTC(year, month - 1, date, hour + (season === 'EST' ? 5 : 4), minute, second));
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(instant).map(part => [part.type, part.value]));
  const roundTrip = `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
  if (roundTrip !== wall || instant.getTime() > at.getTime() + 120_000 || minutes.date !== `${parts.year}${parts.month}${parts.day}`) return null;
  const lastMinute = String(minutes.data.at(-1)).split(' ')[0];
  if (!/^\d{4}$/u.test(lastMinute) || Number(lastMinute.slice(0, 2)) > 23 || Number(lastMinute.slice(2)) > 59) return null;
  const delta = hour * 60 + minute - (Number(lastMinute.slice(0, 2)) * 60 + Number(lastMinute.slice(2)));
  if (delta < 0 || delta > 1) return null;
  const schedule = tradingMarketSchedule('US', instant);
  if (!schedule.calendarVerified || !schedule.isTradingDay || !schedule.opensAt || !schedule.closesAt
    || instant.getTime() < Date.parse(schedule.opensAt) || instant.getTime() > Date.parse(schedule.closesAt) + 120_000) return null;
  const change = previousClose === null ? 0 : price - previousClose;
  return { symbol, price: String(price), previousClose: previousClose === null ? undefined : String(previousClose),
    change: String(change), changePercent: String(previousClose === null ? 0 : change / previousClose * 100),
    companyName: typeof quote[1] === 'string' && quote[1] ? quote[1] : undefined,
    currency: 'USD', market: 'US', source: 'tencent', quoteAt: instant.toISOString(),
    tradingDate: `${parts.year}-${parts.month}-${parts.day}`, timestamp: at.getTime(), delayed: true };
}
