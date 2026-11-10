import type { PortfolioComparisonMetric, PortfolioComparisonSeries } from '@shared/portfolio-comparison.interface';

export const accountColors = ['#178562', '#3976ce', '#8b63be', '#b87932', '#268a96', '#bf607f'];

/** Derive color from identity, not selection order, so toggling a line never recolors another. */
export function accountColor(id: string, colorIndex?: number): string {
  if (id === 'real') return '#263e36';
  if (colorIndex !== undefined && colorIndex >= 0) return accountColors[colorIndex % accountColors.length];
  let hash = 0;
  for (const character of id) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return accountColors[hash % accountColors.length];
}

export function comparisonLineData(series: PortfolioComparisonSeries, metric: PortfolioComparisonMetric) {
  return series.points.map(point => [Date.parse(point.timestamp), metric === 'equity' ? point.equityUsd : point.returnPct]);
}

export function comparisonTimeWindow(series: PortfolioComparisonSeries[]) {
  const timestamps = series.flatMap(item => item.points.map(point => Date.parse(point.timestamp))).filter(Number.isFinite);
  return timestamps.length ? { first: Math.min(...timestamps), last: Math.max(...timestamps) } : null;
}

export function comparisonGapLabel(code: string, zh: boolean): string {
  const labels: Record<string, [string, string]> = {
    MISSING_OBSERVATION: ['部分日期没有估值记录', 'Some dates have no observations'],
    INCOMPLETE_VALUATION: ['估值资料不完整', 'Incomplete valuation'],
    ESTIMATED_VALUATION: ['包含估算值，收益率待核对', 'Estimated values; return unavailable'],
    CASH_FLOW_OR_BASELINE_CHANGED: ['资金流或资产起点发生变化，收益率待核对', 'Cash flows or starting balances changed; return unavailable'],
    RETURN_HISTORY_UNVERIFIED: ['收益计算所需的历史资料不足', 'Insufficient history to calculate return'],
    INSUFFICIENT_OBSERVATIONS: ['等待更多估值记录', 'Waiting for more observations'],
    NO_OBSERVATIONS: ['还没有估值记录', 'No saved valuations yet'],
    VALUATION_TIMESTAMP_UNKNOWN: ['旧估值缺少可信时间', 'Valuation time is unknown'],
  };
  return labels[code]?.[zh ? 0 : 1] ?? (zh ? '部分资料需要核对' : 'Some data needs review');
}
