import type { PortfolioComparisonPeriod, PortfolioComparisonPoint } from '../../../shared/portfolio-comparison.interface';

export interface SavedComparisonObservation {
  timestamp: string;
  date: string;
  equityUsd: number | null;
  /** Identity of cash-flow history and position/cash baselines, or null if unknown. */
  continuity: string | null;
  gaps: string[];
}

export function comparisonPeriodStart(period: PortfolioComparisonPeriod, at: Date): Date {
  if (period === 'ALL') return new Date('1970-01-01T00:00:00Z');
  if (period === 'YTD') return new Date(Date.UTC(at.getUTCFullYear(), 0, 1));
  const days = { '1D': 1, '1W': 7, '1M': 30, '3M': 90 }[period];
  return new Date(at.getTime() - days * 86_400_000);
}

/** Keep observed timestamps. Missing intervals get a null separator, never interpolation. */
export function comparisonObservations(input: SavedComparisonObservation[], granularity: 'observations' | 'hourly' | 'daily'): PortfolioComparisonPoint[] {
  const sorted = input.filter(point => Number.isFinite(Date.parse(point.timestamp)))
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  const unique = new Map<string, SavedComparisonObservation>();
  for (const point of sorted) unique.set(point.timestamp, point);
  const observations = [...unique.values()];
  const opening = observations.find(point => point.equityUsd !== null && point.equityUsd > 0 && point.continuity !== null);
  const afterOpening = opening ? observations.slice(observations.indexOf(opening)) : [];
  const firstDiscontinuity = afterOpening.findIndex(point => point.continuity !== opening?.continuity);
  const trustedChain = firstDiscontinuity < 0 ? afterOpening : afterOpening.slice(0, firstDiscontinuity);
  const validCount = trustedChain.filter(point => point.equityUsd !== null).length;
  const discontinuityAt = firstDiscontinuity < 0 ? Infinity : Date.parse(afterOpening[firstDiscontinuity].timestamp);
  const latest = new Map<string, SavedComparisonObservation>();
  for (const point of observations) latest.set(granularity === 'daily' ? point.date : granularity === 'hourly' ? point.timestamp.slice(0,13) : point.timestamp, point);
  const samples = [...latest.values()];
  // Aggregation cannot conceal a failed valuation or the first financial boundary.
  for (const point of observations.filter((point,index)=>point.equityUsd===null || index>0 && point.continuity!==observations[index-1].continuity)) {
    if(!samples.includes(point))samples.push(point);
  }
  // Keep the actual return origin even when it precedes the first daily close.
  if (opening && !samples.includes(opening)) samples.push(opening);
  samples.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  const result: PortfolioComparisonPoint[] = [];
  for (const [index, point] of samples.entries()) {
    const previous = samples[index - 1];
    if (previous && Date.parse(point.date) - Date.parse(previous.date) > 86_400_000) {
      const timestamp = new Date(Date.parse(previous.timestamp) + 86_400_000).toISOString();
      result.push({ timestamp, date: timestamp.slice(0, 10), equityUsd: null, returnPct: null, gaps: ['MISSING_OBSERVATION'] });
    }
    const gaps = [...point.gaps];
    const continuous = Date.parse(point.timestamp) < discontinuityAt;
    if (!continuous) gaps.push('CASH_FLOW_OR_BASELINE_CHANGED');
    if (point.continuity === null) gaps.push('RETURN_HISTORY_UNVERIFIED');
    const canCompare = opening && validCount >= 2 && continuous && point.continuity !== null
      && point.equityUsd !== null && Date.parse(point.timestamp) >= Date.parse(opening.timestamp);
    result.push({ timestamp: point.timestamp, date: point.date, equityUsd: point.equityUsd,
      returnPct: canCompare ? (point.equityUsd! / opening.equityUsd! - 1) * 100 : null, gaps: [...new Set(gaps)] });
  }
  return result;
}
