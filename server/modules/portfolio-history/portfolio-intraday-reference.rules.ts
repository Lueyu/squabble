import type { PortfolioHistoryPoint } from '../../../shared/portfolio-history.interface';
import type { Market } from '../../../shared/api.interface';
import { tradingMarketSchedule } from '../paper-trading/trading-market.calendar';
import { historySymbol, utcDay, type HistoryFx, type HistoryPosition } from './portfolio-history.rules';

export interface HistoryObservedQuote {
  ticker: string; market: string; currency: string; price: string | number; quoteAt: string; source: string;
}

interface DatedValue { at: number }
interface PreparedQuote extends DatedValue {
  price: number | null;
  source: string | null;
  critical: 'PRICE_BASIS_CHANGED' | 'PRICE_DISCONTINUITY_UNVERIFIED' | null;
}
interface PreparedFx extends DatedValue { value: HistoryFx; rate: number }
interface PreparedSession extends DatedValue { closesAt: number }

const minute = 60_000;
const day = 86_400_000;
const numeric = (value: unknown): number | null => value !== null && value !== ''
  && Number.isFinite(Number(value)) ? Number(value) : null;

function lastIndex(rows: DatedValue[], at: number): number {
  let low = 0, high = rows.length - 1, found = -1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (rows[middle].at <= at) { found = middle; low = middle + 1; }
    else high = middle - 1;
  }
  return found;
}

/** Conflicting facts have no trusted correction order. Keep an unknown boundary
 * rather than selecting whichever duplicate happened to arrive last. */
function prepareQuotes(rows: HistoryObservedQuote[]): PreparedQuote[] {
  const groups = new Map<number, Map<string, { price: number; source: string }>>();
  for (const row of rows) {
    const at = Date.parse(row.quoteAt), price = Number(row.price);
    const facts = groups.get(at) ?? new Map<string, { price: number; source: string }>();
    facts.set(JSON.stringify([price, row.source]), { price, source: row.source });
    groups.set(at, facts);
  }
  const quotes = [...groups.entries()].sort(([left], [right]) => left - right).map(([at, facts]): PreparedQuote => {
    if (facts.size > 1) {
      return { at, price: null, source: null,
        critical: new Set([...facts.values()].map(fact => fact.source)).size > 1
          ? 'PRICE_BASIS_CHANGED' : 'PRICE_DISCONTINUITY_UNVERIFIED' };
    }
    const fact = facts.values().next().value!;
    return { at, ...fact, critical: null };
  });
  for (let index = 1; index < quotes.length; index++) {
    const current = quotes[index], previous = quotes[index - 1];
    if (current.critical) continue;
    if (previous.source === null) current.critical = previous.critical;
    else if (current.source !== previous.source) current.critical = 'PRICE_BASIS_CHANGED';
    else if (previous.price !== null && current.price !== null
      && Math.abs(current.price / previous.price - 1) > 0.25) {
      current.critical = 'PRICE_DISCONTINUITY_UNVERIFIED';
    }
  }
  return quotes;
}

/** Calendar/Intl work is shared across positions and observations. Each close
 * comes from a verified trading date, including its actual local closing time. */
function prepareMarket(market: Market, start: number, end: number) {
  const sessions: PreparedSession[] = [], closes: DatedValue[] = [];
  const first = Date.parse(utcDay(new Date(start - 8 * day)));
  const last = Date.parse(utcDay(new Date(end + day)));
  for (let at = first; at <= last; at += day) {
    const schedule = tradingMarketSchedule(market, new Date(at + day / 2));
    if (!schedule.calendarVerified || !schedule.isTradingDay || !schedule.closesAt) continue;
    sessions.push(...schedule.sessions.map(session => ({ at: Date.parse(session.opensAt), closesAt: Date.parse(session.closesAt) })));
    closes.push({ at: Date.parse(schedule.closesAt) });
  }
  return (at: number, quoteAt: number): boolean => {
    const session = sessions[lastIndex(sessions, at)];
    if (session && at < session.closesAt) return at - quoteAt <= 45 * minute;
    if (at - quoteAt > 7 * day) return false;
    const close = closes[lastIndex(closes, at)];
    // These are already observed quote facts, not a daily bar awaiting its
    // reporting buffer. Keep the genuine quote timestamp at/after official close.
    return Boolean(close && quoteAt >= close.at && quoteAt <= close.at + 2 * minute);
  };
}

function prepareRates(rates: HistoryFx[]): Map<string, PreparedFx[]> {
  const byCurrency = new Map<string, PreparedFx[]>();
  for (const value of rates) {
    const at = Date.parse(value.rateDate), rate = numeric(value.usdRate);
    if (!Number.isFinite(at) || rate === null || rate <= 0) continue;
    const rows = byCurrency.get(value.currency) ?? [];
    rows.push({ at, value, rate });
    byCurrency.set(value.currency, rows);
  }
  for (const rows of byCurrency.values()) rows.sort((left, right) => left.at - right.at);
  return byCurrency;
}

const critical = (point: PortfolioHistoryPoint): boolean => point.gaps.some(gap =>
  gap.startsWith('PRICE_BASIS_CHANGED:') || gap.startsWith('PRICE_DISCONTINUITY_UNVERIFIED:'));
const coverage = (point: PortfolioHistoryPoint): string => JSON.stringify([
  point.priceAsOf.map(row => [row.ticker, row.source]),
  point.fxAsOf.map(row => [row.currency, row.source]),
]);

/** Sample only after evaluating genuine observation times. Otherwise a temporary
 * coverage/source change inside one bucket can disappear before hourly reduction. */
function reducePoints(points: PortfolioHistoryPoint[], interval: number): PortfolioHistoryPoint[] {
  const buckets = new Map<number, PortfolioHistoryPoint>();
  for (const point of points) buckets.set(Math.floor(Date.parse(point.timestamp!) / interval), point);
  const retained = new Set(buckets.values());
  let previousCoverage: string | undefined;
  for (const [index, point] of points.entries()) {
    const ownCoverage = coverage(point), previous = points[index - 1];
    if (critical(point) || previous && ownCoverage !== previousCoverage) {
      retained.add(point);
      if (previous) retained.add(previous);
    }
    previousCoverage = ownCoverage;
  }
  return [...retained].sort((left, right) => Date.parse(left.timestamp!) - Date.parse(right.timestamp!));
}

/** Revalue today's quantities with retained, dated quote facts. This never creates NAV or returns. */
export function intradayReferencePoints(
  positions: HistoryPosition[], quotes: HistoryObservedQuote[], rates: HistoryFx[],
  from: string, to: string, granularity: 'observations' | 'hourly',
  cohort?: ReadonlySet<string>,
): PortfolioHistoryPoint[] {
  const start = Date.parse(from), end = Date.parse(to);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) return [];
  const active = positions.filter(position => numeric(position.shares) !== 0).map(position => {
    const identity = historySymbol(position.ticker, position.market);
    return { position, identity, quantity: numeric(position.shares),
      key: identity ? `${identity.market}:${identity.symbol}:${identity.currency}` : null };
  });
  const identities = new Set(active.map(position => position.key));
  const rawByKey = new Map<string, HistoryObservedQuote[]>();
  const times = new Set<number>();
  for (const quote of quotes) {
    const identity = historySymbol(quote.ticker, quote.market), at = Date.parse(quote.quoteAt), price = numeric(quote.price);
    const key = identity ? `${identity.market}:${identity.symbol}:${identity.currency}` : null;
    if (!identity || identity.currency !== quote.currency || !key || !identities.has(key)
      || !Number.isFinite(at) || at > end || at < start - 7 * day || price === null || price <= 0 || !quote.source) continue;
    const rows = rawByKey.get(key) ?? [];
    rows.push(quote);
    rawByKey.set(key, rows);
    if (at >= start) times.add(at);
  }
  if (!times.size) return [];
  const byKey = new Map([...rawByKey].map(([key, rows]) => [key, prepareQuotes(rows)]));
  const markets = new Map([...new Set(active.flatMap(row => row.identity ? [row.identity.market as Market] : []))]
    .map(market => [market, prepareMarket(market, start, end)]));
  const rateIndex = prepareRates(rates);
  const points: PortfolioHistoryPoint[] = [];
  for (const at of [...times].sort((left, right) => left - right)) {
    const date = utcDay(new Date(at)), dateAt = Date.parse(date), gaps = new Set<string>();
    const point: PortfolioHistoryPoint = { date, timestamp: new Date(at).toISOString(), valueUsd: null,
      knownValueUsd: 0, coveredPositions: 0, totalPositions: active.length, priceAsOf: [], fxAsOf: [], gaps: [] };
    for (const { position, identity, quantity, key } of active) {
      if (!identity || !key || quantity === null || quantity < 0 || position.currency && position.currency !== identity.currency) {
        gaps.add(`POSITION_UNSUPPORTED:${position.ticker}`);
        continue;
      }
      const ownQuotes = byKey.get(key) ?? [], quote = ownQuotes[lastIndex(ownQuotes, at)];
      if (quote?.critical) gaps.add(`${quote.critical}:${position.ticker}`);
      if (cohort && !cohort.has(position.ticker)) {
        gaps.add(`COHORT_EXCLUDED:${position.ticker}`);
        continue;
      }
      const fresh = quote && quote.price !== null && quote.source !== null
        && markets.get(identity.market as Market)!(at, quote.at);
      const ownRates = rateIndex.get(identity.currency) ?? [];
      // A daily FX row has no intraday publication time. Only a preceding date
      // can support a quote without importing information from later that day.
      const priorRate = ownRates[lastIndex(ownRates, dateAt - 1)];
      const fx = identity.currency === 'USD' ? { rateDate: date, rate: 1, source: 'identity' }
        : priorRate && dateAt - priorRate.at <= 7 * day
          ? { rateDate: priorRate.value.rateDate, rate: priorRate.rate, source: priorRate.value.source } : null;
      if (!fresh) gaps.add(`PRICE_MISSING:${position.ticker}`);
      if (!fx) gaps.add(`FX_MISSING:${identity.currency}`);
      if (!fresh || !fx || !quote || quote.price === null || quote.source === null) continue;
      const amount = quantity * quote.price * fx.rate;
      if (!Number.isFinite(amount) || !Number.isFinite(point.knownValueUsd + amount)) {
        gaps.add(`POSITION_UNSUPPORTED:${position.ticker}`);
        continue;
      }
      point.knownValueUsd += amount;
      point.coveredPositions++;
      const quoteDate = utcDay(new Date(quote.at));
      point.priceAsOf.push({ ticker: position.ticker, date: quoteDate,
        timestamp: new Date(quote.at).toISOString(), source: quote.source });
      if (!point.fxAsOf.some(row => row.currency === identity.currency)) {
        point.fxAsOf.push({ currency: identity.currency, date: fx.rateDate, source: fx.source });
      }
      if (quoteDate !== date) gaps.add(`PRIOR_CLOSE:${position.ticker}`);
      if (fx.rateDate !== date) gaps.add(`PRIOR_FX:${identity.currency}`);
    }
    point.knownValueUsd = Number(point.knownValueUsd.toFixed(8));
    if (active.length && point.coveredPositions === active.length && !critical({ ...point, gaps: [...gaps] })) {
      point.valueUsd = point.knownValueUsd;
    }
    point.gaps = [...gaps];
    points.push(point);
  }
  const sampled = reducePoints(points, 5 * minute);
  return granularity === 'observations' ? sampled : reducePoints(sampled, 60 * minute);
}
