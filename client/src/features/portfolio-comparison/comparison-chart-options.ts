import type {
  PortfolioComparisonMetric,
  PortfolioComparisonSeries,
  PortfolioComparisonView,
} from '@shared/portfolio-comparison.interface';

const accountColorTokens = ['--chart-2', '--chart-1', '--chart-5', '--chart-3', '--chart-4', '--info'];

/** Account colors follow account identity and the active theme. */
export function accountColor(id: string, colorIndex?: number, theme?: CSSStyleDeclaration): string {
  let index = colorIndex ?? -1;
  if (index < 0) {
    index = 0;
    for (const character of id) index = (index * 31 + character.charCodeAt(0)) >>> 0;
  }
  const token = id === 'real' ? '--foreground' : accountColorTokens[index % accountColorTokens.length];
  return theme?.getPropertyValue(token).trim() || 'var(' + token + ')';
}

export function comparisonInclusionPoint(
  series: PortfolioComparisonSeries,
  metric: PortfolioComparisonMetric,
  window?: Pick<PortfolioComparisonView, 'from' | 'to'>,
) {
  if (series.kind !== 'simulation' || !series.firstIncludedAt) return undefined;
  const at = Date.parse(series.firstIncludedAt);
  if (!Number.isFinite(at) || (window && (at < Date.parse(window.from) || at > Date.parse(window.to)))) return undefined;
  return series.points.find(point => Date.parse(point.timestamp) === at
    && Number.isFinite(metric === 'equity' ? point.equityUsd : point.returnPct));
}

export function formatComparisonTime(value: string | number, language: string, seconds = false) {
  return new Intl.DateTimeFormat(language, {
    timeZone: 'Asia/Shanghai',
    ...(seconds ? { year: 'numeric', second: '2-digit' } : {}),
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(value));
}

export interface ComparisonGapBridge {
  data: Array<[number, number]>;
  fromIndex: number;
  toIndex: number;
  kind: 'gap' | 'warning';
}

const referencePriceWarnings = new Set(['PRICE_BASIS_CHANGED', 'PRICE_DISCONTINUITY_UNVERIFIED']);
const financialBreaks = new Set([
  'INCOMPLETE_VALUATION', 'ESTIMATED_VALUATION',
  'CASH_FLOW_OR_BASELINE_CHANGED', 'RETURN_HISTORY_UNVERIFIED',
  'PRICE_BASIS_CHANGED', 'PRICE_DISCONTINUITY_UNVERIFIED', 'POSITION_UNSUPPORTED',
]);

/** A visual connector has only two real endpoints. It never fills the data gap. */
export function comparisonGapBridges(
  series: PortfolioComparisonSeries,
  metric: PortfolioComparisonMetric,
  reference = false,
): ComparisonGapBridge[] {
  if (metric !== 'equity') return [];
  const allowed = new Set(reference
    ? ['MISSING_OBSERVATION', 'PRICE_MISSING', 'FX_MISSING', 'HISTORY_PENDING', 'PRIOR_CLOSE', 'PRIOR_FX', 'COHORT_EXCLUDED', ...referencePriceWarnings]
    : ['MISSING_OBSERVATION']);
  const bridges: ComparisonGapBridge[] = [];
  let prior = -1;
  for (let index = 0; index < series.points.length; index++) {
    const point = series.points[index];
    if (point.equityUsd === null || !Number.isFinite(point.equityUsd)
      || !Number.isFinite(Date.parse(point.timestamp))) continue;
    if (prior >= 0 && index > prior + 1) {
      const span = series.points.slice(prior, index + 1);
      const missing = span.slice(1, -1);
      const warning = reference && span.some(row => row.gaps.some(gap => referencePriceWarnings.has(gap.split(':')[0])));
      const safe = !span.some(row => row.gaps.some(gap => financialBreaks.has(gap.split(':')[0])
          && !(reference && referencePriceWarnings.has(gap.split(':')[0]))))
        && missing.every(row => row.equityUsd === null && row.gaps.length > 0
          && row.gaps.every(gap => allowed.has(gap.split(':')[0])));
      if (safe) bridges.push({ kind: warning ? 'warning' : 'gap', fromIndex: prior, toIndex: index, data: [
        [Date.parse(series.points[prior].timestamp), series.points[prior].equityUsd!],
        [Date.parse(point.timestamp), point.equityUsd],
      ] });
    }
    prior = index;
  }
  return bridges;
}

/** A one-point segment needs a dot even when other segments contain many values. */
export function comparisonSymbolIndices(
  series: PortfolioComparisonSeries,
  metric: PortfolioComparisonMetric,
): number[] {
  const values = series.points.map(point => metric === 'equity' ? point.equityUsd : point.returnPct);
  const valid = (index: number) => values[index] !== null && Number.isFinite(values[index]);
  const count = values.filter(value => value !== null && Number.isFinite(value)).length;
  return values.flatMap((_value, index) => valid(index)
    && (count <= 24 || !valid(index - 1) || !valid(index + 1)) ? [index] : []);
}

export function comparisonSamplingLabel(
  granularity: PortfolioComparisonView['granularity'] | undefined,
  zh: boolean,
  reference = false,
  referenceGranularity?: 'observations' | 'hourly',
): string {
  if (reference && referenceGranularity) return referenceGranularity === 'hourly'
    ? (zh ? '日内报价参考 · 每小时末次行情' : 'Intraday quote reference · Latest quote per hour')
    : (zh ? '日内报价参考 · 已存行情时点' : 'Intraday quote reference · Saved quote observations');
  if (reference) return zh ? '每日收盘价参考' : 'Daily close reference';
  if (granularity === 'hourly') return zh ? '每小时末次已存估值' : 'Latest saved valuation per hour';
  if (granularity === 'daily') return zh ? '每日末次已存估值' : 'Latest saved valuation per day';
  return zh ? '全部已存估值' : 'All saved valuations';
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
export function referenceDateLabel(value: number, language: string, intraday = false): string {
  return new Intl.DateTimeFormat(language, {
    timeZone: intraday ? 'Asia/Shanghai' : 'UTC',
    month: '2-digit',
    day: '2-digit',
    ...(intraday ? { hour: '2-digit', minute: '2-digit' } as const : {}),
  }).format(value);
}

export function referenceTooltip(
  parameters: unknown,
  language: string,
  quoteTimestamps: number[] = [],
): string {
  return comparisonTooltip(parameters, language, 'equity', true, quoteTimestamps);
}

export interface ComparisonQuoteObservation { accountId: string; timestamp: number }

/** Bridge layers are deliberately absent from the tooltip's observation inventory. */
export function comparisonTooltip(
  parameters: unknown,
  language: string,
  metric: PortfolioComparisonMetric,
  reference = false,
  quoteTimestamps: Array<number | ComparisonQuoteObservation> = [],
  series: PortfolioComparisonSeries[] = [],
): string {
  const items = Array.isArray(parameters) ? parameters : [parameters];
  const entries = items.filter(
    (item): item is { data: [number, number | null]; seriesName?: string; seriesId?: string } =>
      item !== null &&
      typeof item === 'object' &&
      !/^(?:gap|warning)-bridge:/u.test(String(item.seriesId ?? '')) &&
      Array.isArray(item.data) &&
      Number.isFinite(item.data[0]),
  );
  if (!entries.length) return '';
  const timestamp = entries[0].data[0];
  const observedAt = (value: number) => formatComparisonTime(value, language, true);
  const zh = language.startsWith('zh');
  const hasQuoteTime = (item: (typeof entries)[number]) => quoteTimestamps.some(quote =>
    typeof quote === 'number' ? quote === item.data[0]
      : quote.accountId === item.seriesId && quote.timestamp === item.data[0]);
  const heading = reference && !entries.every(hasQuoteTime)
    ? new Date(timestamp).toISOString().slice(0, 10) : observedAt(timestamp);
  const money = new Intl.NumberFormat(language, {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2,
  });
  return [
    heading,
    ...entries.map(item => {
      const time = (reference ? hasQuoteTime(item) : item.data[0] !== timestamp) ? ` (${observedAt(item.data[0])})` : '';
      const value = item.data[1] == null ? '—' : metric === 'return'
        ? `${item.data[1].toFixed(2)}%` : money.format(item.data[1]);
      const account = series.find(row => row.accountId === item.seriesId);
      const gaps = item.data[1] == null ? account?.points
        .find(point => Date.parse(point.timestamp) === item.data[0])?.gaps ?? [] : [];
      const warnings = [...new Set(gaps.map(gap => comparisonGapLabel(gap, zh, reference)))];
      const inclusion = account && !reference ? comparisonInclusionPoint(account, metric) : undefined;
      if (inclusion && Date.parse(inclusion.timestamp) === item.data[0]) {
        warnings.unshift(zh ? '首次计入统计' : 'First included valuation');
      }
      return [(item.seriesName ?? '') + time + ': ' + value, ...warnings].join(' · ');
    }),
  ].join('\n');
}

export function comparisonGapLabel(code: string, zh: boolean, reference = false): string {
  const prefix = code.split(':')[0];
  if (reference && referencePriceWarnings.has(prefix)) return prefix === 'PRICE_BASIS_CHANGED'
    ? (zh ? '价格口径待核实；估值未知，仅作警示连接' : 'Price conventions unverified; valuation unknown, warning connection only')
    : (zh ? '价格跳变待核实；估值未知，仅作警示连接' : 'Price change unverified; valuation unknown, warning connection only');
  const historyLabels: Record<string, [string, string]> = {
    COHORT_EXCLUDED: [
      '为保持参考金额可比，此持仓不在本次共同覆盖范围内',
      'Excluded from this lookback’s common covered holdings to keep reference amounts comparable',
    ],
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
      '部分时段没有估值记录',
      'Some intervals have no observations',
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
