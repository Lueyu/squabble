import type { Market, MarketIndexQuote, MarketMood } from '@shared/api.interface';

export interface IndexDefinition {
  id: string;
  symbol: string;
  market: Market;
  timeZone: string;
}

/** Explicit index symbols avoid QuoteService's stock-ticker heuristics. */
export const INDEX_DEFINITIONS: readonly IndexDefinition[] = [
  { id: 'sp500', symbol: 'us.INX', market: 'US', timeZone: 'America/New_York' },
  { id: 'nasdaq', symbol: 'us.IXIC', market: 'US', timeZone: 'America/New_York' },
  { id: 'dow', symbol: 'us.DJI', market: 'US', timeZone: 'America/New_York' },
  { id: 'hsi', symbol: 'hkHSI', market: 'HK', timeZone: 'Asia/Hong_Kong' },
  { id: 'hstech', symbol: 'hkHSTECH', market: 'HK', timeZone: 'Asia/Hong_Kong' },
  { id: 'sse', symbol: 'sh000001', market: 'CN', timeZone: 'Asia/Shanghai' },
  { id: 'csi300', symbol: 'sh000300', market: 'CN', timeZone: 'Asia/Shanghai' },
  { id: 'szse', symbol: 'sz399001', market: 'CN', timeZone: 'Asia/Shanghai' },
];

function providerTime(raw: string): string | null {
  const compact = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(raw);
  const normalized = compact
    ? `${compact[1]}-${compact[2]}-${compact[3]} ${compact[4]}:${compact[5]}:${compact[6]}`
    : raw.replaceAll('/', '-');
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(normalized)) return null;
  const date = new Date(`${normalized.replace(' ', 'T')}Z`);
  if (
    !Number.isFinite(date.getTime()) ||
    date.toISOString().slice(0, 19) !== normalized.replace(' ', 'T')
  )
    return null;
  return normalized;
}

export function parseIndexQuote(
  body: string,
  definition: IndexDefinition,
  now: Date,
): MarketIndexQuote {
  const missing: MarketIndexQuote = {
    id: definition.id,
    market: definition.market,
    value: null,
    change: null,
    changePercent: null,
    quoteTime: null,
    sessionDate: null,
    timeZone: definition.timeZone,
    retrievedAt: null,
    source: 'Tencent',
    status: 'unavailable',
    issue: 'invalid_quote',
  };
  const escaped = definition.symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matched = new RegExp(`v_${escaped}="([^"]*)"`).exec(body);
  if (!matched) return missing;
  const fields = matched[1].split('~');
  const value = Number(fields[3]);
  const previous = Number(fields[4]);
  const quoteTime = providerTime(fields[30] ?? '');
  if (
    !Number.isFinite(value) ||
    value <= 0 ||
    !Number.isFinite(previous) ||
    previous <= 0 ||
    !quoteTime
  )
    return missing;
  const sessionDate = quoteTime.slice(0, 10);
  const dateAge = now.getTime() - Date.parse(`${sessionDate}T00:00:00Z`);
  // Long holidays/closed sessions still show the provider's actual date. Do not
  // call an old snapshot live or let it drive the current sentiment estimate.
  const outdated = dateAge > 7 * 86_400_000 || dateAge < -86_400_000;
  return {
    ...missing,
    value,
    change: Number((value - previous).toFixed(4)),
    changePercent: Number(((value / previous - 1) * 100).toFixed(4)),
    quoteTime,
    sessionDate,
    retrievedAt: now.toISOString(),
    status: outdated ? 'stale' : 'available',
    issue: outdated ? 'outdated_quote' : null,
  };
}

export function calculateMarketMood(market: Market, quotes: MarketIndexQuote[]): MarketMood {
  const available = quotes.filter(
    (quote) =>
      quote.market === market &&
      quote.status === 'available' &&
      quote.changePercent !== null &&
      Number.isFinite(quote.changePercent) &&
      quote.sessionDate,
  );
  const sessionDate =
    available
      .map((quote) => quote.sessionDate as string)
      .sort()
      .at(-1) ?? null;
  const current = available.filter((quote) => quote.sessionDate === sessionDate);
  const total = INDEX_DEFINITIONS.filter((definition) => definition.market === market).length;
  const average =
    current.length >= 2
      ? current.reduce((sum, quote) => sum + (quote.changePercent ?? 0), 0) / current.length
      : null;
  return {
    market,
    sessionDate,
    total,
    covered: current.length,
    method: 'index_daily_change_v1',
    averageChangePercent: average === null ? null : Number(average.toFixed(4)),
    score: average === null ? null : Math.round(Math.max(0, Math.min(100, 50 + 20 * average))),
  };
}
