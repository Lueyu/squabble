import type { PortfolioCurrentMark } from '../../../shared/portfolio-comparison.interface';
import type { PortfolioHistoryPoint } from '../../../shared/portfolio-history.interface';

export interface HistoryPosition { ticker: string; market: string | null; currency: string | null; shares: string; currentPrice?: string | null }
export interface HistoryPrice { symbol: string; market: string; currency: string; priceDate: string; close: string; source: string }
export interface HistoryFx { currency: string; rateDate: string; usdRate: string; source: string }
export interface MarkCash { currency: string; balance: string; known: boolean }
const dayMs = 86_400_000;
const numeric = (value: unknown): number | null => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null;
const round = (value: number) => Math.round(value * 1e8) / 1e8;
export const utcDay = (value: Date) => value.toISOString().slice(0, 10);

export function historySymbol(ticker: string, market: string | null): { symbol: string; market: string; currency: string } | null {
  const value = ticker.trim().toUpperCase();
  if (market === 'HK' && /^\d{1,5}(?:\.HK)?$/u.test(value)) return { symbol: `${String(Number(value.replace(/\.HK$/u, ''))).padStart(4, '0')}.HK`, market, currency: 'HKD' };
  if (market === 'CN' && /^\d{6}(?:\.(?:SH|SS|SZ|BJ))?$/u.test(value)) {
    const code = value.slice(0, 6), suffix = value.split('.')[1];
    return { symbol: `${code}.${suffix === 'SH' || suffix === 'SS' || !suffix && code.startsWith('6') ? 'SS' : suffix ?? (/^[48]/u.test(code) ? 'BJ' : 'SZ')}`, market, currency: 'CNY' };
  }
  if ((!market || market === 'US') && /^[A-Z][A-Z0-9.-]{0,19}$/u.test(value)) return { symbol: value.replaceAll('.', '-'), market: 'US', currency: 'USD' };
  return null;
}

function prior<T>(rows: T[], getDate: (row: T) => string, day: string): T | undefined {
  return rows.filter(row => getDate(row) <= day && Date.parse(day) - Date.parse(getDate(row)) <= 7 * dayMs)
    .sort((a, b) => getDate(b).localeCompare(getDate(a)))[0];
}

function priorIndex<T>(rows: T[], getDate: (row: T) => string, day: string): number {
  let low = 0, high = rows.length - 1, found = -1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (getDate(rows[middle]) <= day) { found = middle; low = middle + 1; } else high = middle - 1;
  }
  return found >= 0 && Date.parse(day) - Date.parse(getDate(rows[found])) <= 7 * dayMs ? found : -1;
}

export function referencePoints(positions: HistoryPosition[], prices: HistoryPrice[], rates: HistoryFx[], from: string, to: string): PortfolioHistoryPoint[] {
  const active = positions.filter(position => numeric(position.shares) !== 0);
  const priceIndex = new Map<string, HistoryPrice[]>(), rateIndex = new Map<string, HistoryFx[]>();
  for (const price of prices) if (numeric(price.close)! > 0) {
    const key = `${price.symbol}:${price.currency}`, rows = priceIndex.get(key) ?? [];
    rows.push(price); priceIndex.set(key, rows);
  }
  for (const rate of rates) if (numeric(rate.usdRate)! > 0) {
    const rows = rateIndex.get(rate.currency) ?? []; rows.push(rate); rateIndex.set(rate.currency, rows);
  }
  for (const rows of priceIndex.values()) rows.sort((a, b) => a.priceDate.localeCompare(b.priceDate));
  for (const rows of rateIndex.values()) rows.sort((a, b) => a.rateDate.localeCompare(b.rateDate));
  const prepared = active.map(position => {
    const identity = historySymbol(position.ticker, position.market);
    return { position, identity, quantity: numeric(position.shares),
      prices: identity ? priceIndex.get(`${identity.symbol}:${identity.currency}`) ?? [] : [],
      rates: identity ? rateIndex.get(identity.currency) ?? [] : [] };
  });
  const points: PortfolioHistoryPoint[] = [];
  for (let at = Date.parse(from); at <= Date.parse(to); at += dayMs) {
    const date = utcDay(new Date(at)), gaps = new Set<string>();
    const point: PortfolioHistoryPoint = { date, valueUsd: null, knownValueUsd: 0, coveredPositions: 0, totalPositions: active.length, priceAsOf: [], fxAsOf: [], gaps: [] };
    for (const { position, identity, quantity, prices: ownPrices, rates: ownRates } of prepared) {
      if (!identity || quantity === null || quantity < 0 || position.currency && position.currency !== identity.currency) { gaps.add(`POSITION_UNSUPPORTED:${position.ticker}`); continue; }
      const index = priorIndex(ownPrices, row => row.priceDate, date), price = ownPrices[index];
      const fx = identity.currency === 'USD' ? { currency: 'USD', rateDate: date, usdRate: '1', source: 'identity' }
        : ownRates[priorIndex(ownRates, row => row.rateDate, date)];
      if (!price) gaps.add(`PRICE_MISSING:${position.ticker}`);
      if (!fx) gaps.add(`FX_MISSING:${identity.currency}`);
      if (!price || !fx) continue;
      const previous = ownPrices[index - 1];
      if (previous && price.priceDate === date && previous.source !== price.source) gaps.add(`PRICE_BASIS_CHANGED:${position.ticker}`);
      if (previous && price.priceDate === date && Math.abs(Number(price.close) / Number(previous.close) - 1) > 0.25) gaps.add(`PRICE_DISCONTINUITY_UNVERIFIED:${position.ticker}`);
      point.knownValueUsd += quantity * Number(price.close) * Number(fx.usdRate); point.coveredPositions++;
      point.priceAsOf.push({ ticker: position.ticker, date: price.priceDate, source: price.source });
      if (!point.fxAsOf.some(row => row.currency === identity.currency)) point.fxAsOf.push({ currency: identity.currency, date: fx.rateDate, source: fx.source });
      if (price.priceDate !== date) gaps.add(`PRIOR_CLOSE:${position.ticker}`);
      if (fx.rateDate !== date) gaps.add(`PRIOR_FX:${identity.currency}`);
    }
    point.knownValueUsd = round(point.knownValueUsd);
    if (!active.length) gaps.add('NO_POSITIONS');
    if (active.length && point.coveredPositions === active.length && ![...gaps].some(gap => gap.startsWith('PRICE_BASIS_CHANGED:') || gap.startsWith('PRICE_DISCONTINUITY_UNVERIFIED:'))) point.valueUsd = point.knownValueUsd;
    point.gaps = [...gaps]; points.push(point);
  }
  return points;
}

export function currentMark(positions: HistoryPosition[], cash: MarkCash[], prices: HistoryPrice[], rates: HistoryFx[], at: Date, cashScopeKnown = false): PortfolioCurrentMark {
  const day = utcDay(at), active = positions.filter(position => numeric(position.shares) !== 0), gaps = new Set<string>();
  const currencies = new Set([...(cashScopeKnown ? [] : active.map(row => row.currency ?? 'USD')), ...cash.map(row => row.currency)]);
  let holdingsValue = 0, cashValue = 0, covered = 0, cashComplete = currencies.size > 0, cashKnown = 0;
  let saved = 0, cached = 0;
  const priceDates: string[] = [];
  const rateFor = (currency: string) => currency === 'USD' ? 1 : numeric(prior(rates.filter(row => row.currency === currency), row => row.rateDate, day)?.usdRate);
  for (const position of active) {
    const identity = historySymbol(position.ticker, position.market), quantity = numeric(position.shares);
    const stored = numeric(position.currentPrice);
    const close = identity ? prior(prices.filter(row => row.symbol === identity.symbol && row.currency === identity.currency), row => row.priceDate, day) : undefined;
    const datedPrice = numeric(close?.close);
    // A recent dated close outranks a saved/imported price whose observation time is unknown.
    const useDated = datedPrice !== null && datedPrice > 0;
    const price = useDated ? datedPrice : stored;
    const rate = rateFor(position.currency ?? identity?.currency ?? 'USD');
    if (!identity || quantity === null || quantity < 0 || position.currency && position.currency !== identity.currency) { gaps.add(`POSITION_UNSUPPORTED:${position.ticker}`); continue; }
    if (price === null || price <= 0) gaps.add(`PRICE_MISSING:${position.ticker}`);
    if (rate === null || rate <= 0) gaps.add(`FX_MISSING:${identity.currency}`);
    if (price === null || price <= 0 || rate === null || rate <= 0) continue;
    covered++; holdingsValue += quantity * price * rate;
    if (useDated) { cached++; priceDates.push(close!.priceDate); gaps.add('CACHED_DAILY_CLOSE'); }
    else { saved++; gaps.add('SAVED_PRICE_TIME_UNKNOWN'); }
  }
  for (const currency of currencies) {
    const rows = cash.filter(row => row.currency === currency), row = rows[0], balance = numeric(row?.balance), rate = rateFor(currency);
    if (rows.length !== 1 || !row.known || balance === null || balance < 0) { cashComplete = false; gaps.add(`CASH_UNCONFIRMED:${currency}`); continue; }
    if (balance !== 0 && (rate === null || rate <= 0)) { cashComplete = false; gaps.add(`FX_MISSING:${currency}`); continue; }
    cashValue += balance * (rate ?? 1); cashKnown++;
  }
  const positionsComplete = covered === active.length, complete = positionsComplete && cashComplete;
  const basis = complete ? 'total_assets' : positionsComplete && active.length ? 'holdings_market_value' : 'known_assets';
  const value = basis === 'total_assets' ? holdingsValue + cashValue : basis === 'holdings_market_value' ? holdingsValue : covered || cashKnown ? holdingsValue + cashValue : null;
  return { valueUsd: value === null ? null : round(value), basis, holdingsValueUsd: positionsComplete ? round(holdingsValue) : null,
    cashValueUsd: cashComplete ? round(cashValue) : null, complete, asOf: saved || !priceDates.length ? null : priceDates.sort()[0],
    readAt: at.toISOString(), pricing: saved && cached ? 'mixed' : saved ? 'saved_prices' : cached ? 'cached_close' : 'none',
    coveredPositions: covered, totalPositions: active.length, gaps: [...gaps] };
}
