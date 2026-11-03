import type { TradingMarket, TradingMarketSchedule, TradingMarketSession } from '@shared/trading-market.interface';

/** Verified 2026 exchange calendars, checked 2026-11-03. Renew before enabling another year.
 * Scheduled continuous equity sessions only, not a live halt/status feed or auctions.
 * Missing years deliberately fail closed; government makeup weekends never open equities.
 */
const CALENDAR_VERSION = 'official-equities-2026.v1';
const TIMEZONES: Record<TradingMarket, string> = {
  US: 'America/New_York', HK: 'Asia/Hong_Kong', CN: 'Asia/Shanghai',
};
const SOURCES: Record<TradingMarket, string[]> = {
  US: ['https://www.nyse.com/trade/hours-calendars', 'https://nasdaqtrader.com/Trader.aspx?id=Calendar'],
  HK: [
    'https://www.hkex.com.hk/-/media/HKEX-Market/Services/Circulars-and-Notices/Participant-and-Members-Circulars/SEHK/2025/ce_SEHK_CT_075_2025.pdf',
    'https://www.hkex.com.hk/Services/Trading-hours-and-Severe-Weather-Arrangements/Trading-Hours/Securities-Market?sc_lang=en',
  ],
  CN: ['https://www.sse.com.cn/disclosure/announcement/general/c/c_20251222_10802507.shtml',
    'https://www.szse.cn/disclosure/notice/t20251222_618087.html',
    'https://english.sse.com.cn/start/trading/schedule/'],
};
const CLOSED_DATES: Record<TradingMarket, ReadonlySet<string>> = {
  US: new Set(['01-01', '01-19', '02-16', '04-03', '05-25', '06-19', '07-03', '09-07', '11-26', '12-25']),
  HK: new Set(['01-01', '02-17', '02-18', '02-19', '04-03', '04-06', '04-07', '05-01', '05-25',
    '06-19', '07-01', '10-01', '10-19', '12-25']),
  CN: new Set(['01-01', '01-02', '01-03', '02-15', '02-16', '02-17', '02-18', '02-19', '02-20',
    '02-21', '02-22', '02-23', '04-04', '04-05', '04-06', '05-01', '05-02', '05-03', '05-04', '05-05',
    '06-19', '06-20', '06-21', '09-25', '09-26', '09-27', '10-01', '10-02', '10-03', '10-04',
    '10-05', '10-06', '10-07']),
};
const EARLY_CLOSE_DATES: Record<TradingMarket, ReadonlySet<string>> = {
  US: new Set(['11-27', '12-24']), HK: new Set(['02-16', '12-24', '12-31']), CN: new Set(),
};

function localParts(timezone: string, instant: Date): Record<string, string> {
  return Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    second: '2-digit', hourCycle: 'h23' }).formatToParts(instant).map(part => [part.type, part.value]));
}

export function tradingMarketDate(market: TradingMarket, instant: Date): string {
  const parts = localParts(TIMEZONES[market], instant);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function localInstant(market: TradingMarket, date: string, hour: number, minute = 0): string {
  const [year, month, day] = date.split('-').map(Number);
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  let timestamp = wall;
  for (let pass = 0; pass < 2; pass++) {
    const parts = localParts(TIMEZONES[market], new Date(timestamp));
    const shown = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day),
      Number(parts.hour), Number(parts.minute), Number(parts.second));
    timestamp += wall - shown;
  }
  return new Date(timestamp).toISOString();
}

function adjacentDate(date: string, offset: number): string {
  return new Date(Date.parse(`${date}T12:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);
}

function knownDate(date: string): boolean { return date.startsWith('2026-'); }

function sessionsForDate(market: TradingMarket, date: string): TradingMarketSession[] {
  if (!knownDate(date)) return [];
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
  if (weekday === 0 || weekday === 6 || CLOSED_DATES[market].has(date.slice(5))) return [];
  const early = EARLY_CLOSE_DATES[market].has(date.slice(5));
  const open = localInstant(market, date, 9, 30);
  if (market === 'US') return [{ opensAt: open, closesAt: localInstant(market, date, early ? 13 : 16) }];
  const morning = { opensAt: open, closesAt: localInstant(market, date, market === 'HK' ? 12 : 11,
    market === 'HK' ? 0 : 30) };
  return early ? [morning] : [morning,
    { opensAt: localInstant(market, date, 13),
      closesAt: localInstant(market, date, market === 'HK' ? 16 : 14, market === 'HK' ? 0 : 57) }];
}

/** CN closing auction ends at 15:00, after continuous order execution ends at 14:57. */
function officialClose(market: TradingMarket, date: string, sessions: TradingMarketSession[]): string | null {
  if (!sessions.length) return null;
  return market === 'CN' ? localInstant(market, date, 15) : sessions.at(-1)!.closesAt;
}

/** Last verified session whose daily bar can be final; allow 30m for closing auctions/reporting. */
export function lastCompletedTradingDate(market: TradingMarket, now: Date): string | null {
  const date = tradingMarketDate(market, now);
  if (!knownDate(date)) return null;
  for (let offset = 0; offset >= -31; offset--) {
    const candidate = adjacentDate(date, offset);
    if (!knownDate(candidate)) return null;
    const sessions = sessionsForDate(market, candidate);
    const closesAt = officialClose(market, candidate, sessions);
    if (closesAt && Date.parse(closesAt) + 30 * 60_000 <= now.getTime()) return candidate;
  }
  return null;
}

export function tradingMarketSchedule(market: TradingMarket, now: Date): TradingMarketSchedule {
  const tradingDate = tradingMarketDate(market, now);
  const calendarVerified = knownDate(tradingDate);
  const sessions = sessionsForDate(market, tradingDate);
  const isOpen = sessions.some(session => Date.parse(session.opensAt) <= now.getTime()
    && now.getTime() < Date.parse(session.closesAt));
  let nextOpenAt: string | null = null;
  if (calendarVerified) {
    for (let offset = 0; offset <= 31; offset++) {
      const candidate = adjacentDate(tradingDate, offset);
      if (!knownDate(candidate)) break;
      const next = sessionsForDate(market, candidate).find(session => Date.parse(session.opensAt) > now.getTime());
      if (next) { nextOpenAt = next.opensAt; break; }
    }
  }
  return { market, timezone: TIMEZONES[market], tradingDate, calendarVerified,
    isTradingDay: sessions.length > 0, isOpen, opensAt: sessions[0]?.opensAt ?? null,
    closesAt: officialClose(market, tradingDate, sessions), nextOpenAt,
    earlyClose: sessions.length > 0 && EARLY_CLOSE_DATES[market].has(tradingDate.slice(5)),
    reason: !calendarVerified ? 'calendar_unavailable' : isOpen ? null : sessions.length ? 'outside_session' : 'market_holiday',
    sessions, sourceUrls: [...SOURCES[market]], calendarVersion: CALENDAR_VERSION };
}
