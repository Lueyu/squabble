import type {
  PortfolioComparisonMetric,
  PortfolioComparisonSeries,
} from '@shared/portfolio-comparison.interface';

export const accountColors = [
  '#178562',
  '#3976ce',
  '#8b63be',
  '#b87932',
  '#268a96',
  '#bf607f',
];

/** Derive color from identity, not selection order, so toggling a line never recolors another. */
export function accountColor(id: string, colorIndex?: number): string {
  if (id === 'real') return '#263e36';
  if (colorIndex !== undefined && colorIndex >= 0)
    return accountColors[colorIndex % accountColors.length];
  let hash = 0;
  for (const character of id)
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return accountColors[hash % accountColors.length];
}

export function comparisonLineData(
  series: PortfolioComparisonSeries,
  metric: PortfolioComparisonMetric,
) {
  return series.points.map((point) => [
    Date.parse(point.timestamp),
    metric === 'equity' ? point.equityUsd : point.returnPct,
  ]);
}

export function comparisonTimeWindow(series: PortfolioComparisonSeries[]) {
  const timestamps = series
    .flatMap((item) => item.points.map((point) => Date.parse(point.timestamp)))
    .filter(Number.isFinite);
  return timestamps.length
    ? { first: Math.min(...timestamps), last: Math.max(...timestamps) }
    : null;
}

/** Reference days have no observed-at time and must not change with the browser's timezone. */
export function referenceDateLabel(value: number, language: string): string {
  return new Intl.DateTimeFormat(language, {
    timeZone: 'UTC',
    month: '2-digit',
    day: '2-digit',
  }).format(value);
}

export function referenceTooltip(
  parameters: unknown,
  language: string,
): string {
  const items = Array.isArray(parameters) ? parameters : [parameters];
  const entries = items.filter(
    (item): item is { data: [number, number | null]; seriesName?: string } =>
      item !== null &&
      typeof item === 'object' &&
      Array.isArray(item.data) &&
      Number.isFinite(item.data[0]),
  );
  if (!entries.length) return '';
  const day = new Date(entries[0].data[0]).toISOString().slice(0, 10);
  const money = new Intl.NumberFormat(language, {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2,
  });
  return [
    day,
    ...entries.map(
      (item) =>
        `${item.seriesName ?? ''}: ${item.data[1] == null ? '—' : money.format(item.data[1])}`,
    ),
  ].join('\n');
}

export function comparisonGapLabel(code: string, zh: boolean): string {
  const prefix = code.split(':')[0];
  const historyLabels: Record<string, [string, string]> = {
    PRIOR_CLOSE: [
      '沿用此前最近收盘价，具体日期见来源',
      'Uses the latest prior close; see source dates',
    ],
    PRIOR_FX: [
      '沿用此前最近可用汇率，具体日期见来源',
      'Uses the latest prior FX rate; see source dates',
    ],
    PRICE_BASIS_CHANGED: [
      '历史价格口径切换，此处断线',
      'Price conventions changed; the line breaks here',
    ],
    PRICE_DISCONTINUITY_UNVERIFIED: [
      '价格突变待核对拆股或除权，此处断线',
      'Large price change needs corporate-action review; the line breaks here',
    ],
    PRICE_MISSING: [
      '缺少历史价格，未视为零',
      'Historical price missing, not zero',
    ],
    FX_MISSING: [
      '缺少当日可用汇率，未使用未来汇率',
      'Dated FX missing; future FX is not substituted',
    ],
    HISTORY_PENDING: [
      '正在后台补齐历史行情',
      'Historical prices are being prepared',
    ],
    HISTORY_LIMITED_TO_365_DAYS: [
      '历史回看最多展示最近一年',
      'Historical lookback is limited to the latest year',
    ],
    NO_POSITIONS: [
      '该账户没有可回看的持仓',
      'This account has no positions to look back on',
    ],
  };
  if (historyLabels[prefix]) return historyLabels[prefix][zh ? 0 : 1];
  const labels: Record<string, [string, string]> = {
    MISSING_OBSERVATION: [
      '部分日期没有估值记录',
      'Some dates have no observations',
    ],
    INCOMPLETE_VALUATION: ['估值资料不完整', 'Incomplete valuation'],
    ESTIMATED_VALUATION: [
      '包含估算值，收益率待核对',
      'Estimated values; return unavailable',
    ],
    CASH_FLOW_OR_BASELINE_CHANGED: [
      '资金流或资产起点发生变化，收益率待核对',
      'Cash flows or starting balances changed; return unavailable',
    ],
    RETURN_HISTORY_UNVERIFIED: [
      '收益计算所需的历史资料不足',
      'Insufficient history to calculate return',
    ],
    INSUFFICIENT_OBSERVATIONS: [
      '等待更多估值记录',
      'Waiting for more observations',
    ],
    NO_OBSERVATIONS: ['还没有估值记录', 'No saved valuations yet'],
    VALUATION_TIMESTAMP_UNKNOWN: [
      '旧估值缺少可信时间',
      'Valuation time is unknown',
    ],
  };
  return (
    labels[code]?.[zh ? 0 : 1] ??
    (zh ? '部分资料需要核对' : 'Some data needs review')
  );
}
