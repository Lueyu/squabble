import type { PortfolioHistoryPoint } from '../../../shared/portfolio-history.interface';

/** Preserve source gaps while replacing only dates backed by real intraday quote facts. */
export function combineReferencePoints(daily: PortfolioHistoryPoint[], observed: PortfolioHistoryPoint[]): PortfolioHistoryPoint[] {
  if (!observed.length) return daily;
  const firstSource = daily.findIndex(point => point.priceAsOf.length > 0);
  const retained = firstSource < 0 ? [] : daily.slice(firstSource).filter(point => point.date < observed[0].date);
  const prior = retained.filter(point => point.priceAsOf.length > 0).at(-1);
  const boundary = observed[0];
  const changed = boundary.priceAsOf.filter(current => {
    const previous = prior?.priceAsOf.find(row => row.ticker === current.ticker);
    // Tencent's explicitly unadjusted closes and dated raw quotes share a
    // convention. Other differing labels do not prove adjustment compatibility.
    return previous && previous.source !== current.source
      && !(previous.source === 'tencent:unadjusted-close' && current.source === 'tencent');
  });
  const first = changed.length ? { ...boundary, valueUsd: null,
    gaps: [...new Set([...boundary.gaps, ...changed.map(row => `PRICE_BASIS_CHANGED:${row.ticker}`)])] } : boundary;
  return [...retained, first, ...observed.slice(1)];
}
