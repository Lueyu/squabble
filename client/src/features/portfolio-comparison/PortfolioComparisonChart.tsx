import { useMemo, useState, type ReactNode } from 'react';
import ReactECharts from 'echarts-for-react';
import { useTranslation } from 'react-i18next';
import { useTheme } from '@/hooks/use-theme';
import type {
  PortfolioComparisonMetric,
  PortfolioComparisonPeriod,
  PortfolioComparisonSeries,
  PortfolioComparisonView,
} from '@shared/portfolio-comparison.interface';
import type { PortfolioHistorySeries } from '@shared/portfolio-history.interface';
import { referenceHistoryPoint } from './comparison-display';
import {
  accountColor,
  comparisonInclusionPoint,
  formatComparisonTime,
  comparisonGapBridges,
  comparisonGapLabel,
  comparisonLineData,
  comparisonReturnExtent,
  comparisonSymbolIndices,
  comparisonTimeWindow,
  comparisonTooltip,
  referenceDateLabel,
} from './comparison-chart-options';

interface Props {
  series: PortfolioComparisonSeries[];
  metric: PortfolioComparisonMetric;
  compact?: boolean;
  realOnly?: boolean;
  reference?: boolean;
  historySeries?: PortfolioHistorySeries[];
  partialAccountIds?: string[];
  granularity?: PortfolioComparisonView['granularity'];
  referenceGranularity?: 'observations' | 'hourly';
  period: PortfolioComparisonPeriod;
  annotation?: ReactNode;
  window?: Pick<PortfolioComparisonView, 'from' | 'to'>;
}

export default function PortfolioComparisonChart({
  series,
  metric,
  compact = false,
  realOnly = false,
  reference = false,
  historySeries,
  partialAccountIds,
  granularity,
  referenceGranularity,
  period,
  annotation,
  window: comparisonWindow,
}: Props) {
  const { i18n } = useTranslation();
  const { theme } = useTheme();
  const zh = i18n.language.startsWith('zh');
  const timeWindow = useMemo(() => comparisonTimeWindow(series), [series]);
  const singleObservation =
    timeWindow !== null && timeWindow.first === timeWindow.last;
  const weeklyReturnExtent = useMemo(() => !reference && period === '1W' && metric === 'return'
    ? comparisonReturnExtent(series) : undefined, [series, reference, period, metric]);
  const singleReturn = weeklyReturnExtent?.count === 1 ? weeklyReturnExtent.first : undefined;
  const singleTimestamp = singleReturn?.timestamp ?? (singleObservation ? timeWindow.first : undefined);
  const useSelectedWindow = realOnly && singleObservation && comparisonWindow;
  const splitNumber = compact ? 3 : 4;
  const returnSpan = weeklyReturnExtent ? weeklyReturnExtent.max - weeklyReturnExtent.min : Infinity;
  const tickScale = returnSpan || Math.abs(weeklyReturnExtent?.min ?? 0) || 1;
  const fineReturnTicks = !singleReturn && tickScale < 1;
  const returnTickDigits = fineReturnTicks
    ? Math.min(100, 1 - Math.floor(Math.log10(tickScale / splitNumber))) : 1;
  const quoteTimestamps = useMemo(() => historySeries?.flatMap(item => item.points
    .flatMap(point => point.timestamp && Number.isFinite(Date.parse(point.timestamp))
      ? [{ accountId: item.accountId, timestamp: Date.parse(point.timestamp) }] : [])) ?? [], [historySeries]);
  const referenceIntraday = reference && quoteTimestamps.length > 0;
  const intraday = reference ? referenceIntraday : period === '1D';
  const chartTheme = typeof window !== 'undefined' && typeof document !== 'undefined'
    ? window.getComputedStyle(document.querySelector('.portfolio-comparison') ?? document.documentElement)
    : undefined;
  const token = (name: string) => chartTheme?.getPropertyValue(name).trim() || undefined;
  const foreground = token('--popover-foreground');
  const warning = token('--warning');
  const muted = token('--muted-foreground');
  const border = token('--border');
  const popover = token('--popover');
  const card = token('--card');
  const option = {
    animation: false,
    aria: {
      enabled: true,
      description: reference
        ? zh
          ? '按当前持仓回看历史价格的参考市值，不含现金，不代表实际收益。浅色虚线连接缺失区间，警示虚线连接价格口径或跳变待核实区间；区间估值仍未知。'
          : 'Current-position historical reference value, excluding cash, not actual returns. Faint dashes mark missing intervals; warning dashes link unverified price conventions or jumps. Interval valuations remain unknown.'
        : zh
          ? '实仓与模拟账户的已存估值。缺失估值与收益率留空。垂直虚线指示模拟账户的首次完整估值。'
          : 'Saved real and simulation valuations. Missing observations leave gaps. Vertical dashes mark the first complete valuation for a simulation account.',
    },
    grid: { top: 16, left: 46, right: 16, bottom: 30 },
    tooltip: {
      formatter: (params: unknown) => comparisonTooltip(params, i18n.language, metric, reference, quoteTimestamps, series),
      trigger: 'axis',
      renderMode: 'richText',
      confine: true,
      backgroundColor: popover,
      borderColor: border,
      textStyle: { color: foreground, fontSize: 12 },
      valueFormatter: (value: unknown) =>
        value == null
          ? zh
            ? '暂无估值'
            : 'No valuation'
          : metric === 'return'
            ? `${Number(value).toFixed(2)}%`
            : new Intl.NumberFormat(zh ? 'zh-CN' : 'en-US', {
                style: 'currency',
                currency: 'USD',
                maximumFractionDigits: 2,
              }).format(Number(value)),
    },
    xAxis: {
      type: 'time',
      boundaryGap: false,
      axisLine: { show: false },
      axisTick: { show: false },
      splitLine: { show: false },
      min: useSelectedWindow ? Date.parse(comparisonWindow.from) : singleObservation ? timeWindow.first - 3600000 : undefined,
      max: useSelectedWindow ? Date.parse(comparisonWindow.to) : singleObservation ? timeWindow.first + 3600000 : undefined,
      minInterval: (reference ? referenceGranularity : granularity) === 'hourly'
        ? 3600000 : intraday ? 60000 : 86400000,
      axisLabel: {
        show: realOnly || singleTimestamp === undefined,
        showMaxLabel: true,
        color: muted,
        hideOverlap: true,
        fontSize: 12,
        formatter: (value: number) =>
          reference
            ? referenceDateLabel(value, i18n.language, referenceIntraday)
            : new Intl.DateTimeFormat(zh ? 'zh-CN' : 'en-US', {
                timeZone: 'Asia/Shanghai',
                ...(intraday
                  ? { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }
                  : { month: '2-digit', day: '2-digit' }),
              }).format(value),
      },
    },
    yAxis: {
      type: 'value',
      position: 'left',
      scale: true,
      splitNumber,
      axisLabel: {
        ...(singleReturn && { customValues: [singleReturn.value] }),
        color: muted,
        fontSize: fineReturnTicks ? 10 : 12,
        ...(fineReturnTicks && { margin: 4 }),
        formatter: (value: number) =>
          metric === 'return'
            ? `${value > 0 ? '+' : ''}${Number(singleReturn ? value.toPrecision(12) : value.toFixed(returnTickDigits))}%`
            : new Intl.NumberFormat('en-US', {
                notation: 'compact',
                style: 'currency',
                currency: 'USD',
                maximumFractionDigits: 1,
              }).format(value),
      },
      splitLine: { show: !singleReturn, lineStyle: { color: border } },
    },
    series: series.flatMap((item) => {
      const color = accountColor(item.accountId, item.colorIndex, chartTheme);
      const inclusion = reference ? undefined : comparisonInclusionPoint(item, metric, comparisonWindow);
      const symbols = new Set(comparisonSymbolIndices(item, metric));
      const name = (item.kind === 'real' ? (zh ? '实仓' : 'Real portfolio') : item.name)
        + (partialAccountIds?.includes(item.accountId)
          ? (zh ? ' · 部分持仓' : ' · Partial holdings') : '');
      const observed = {
        id: item.accountId,
        name,
        type: 'line',
        data: comparisonLineData(item, metric),
        connectNulls: false,
        smooth: false,
        showSymbol: true,
        symbol: 'circle',
        symbolSize: (_value: unknown, params: { dataIndex: number }) =>
          inclusion && inclusion === item.points[params.dataIndex] ? 8 : symbols.has(params.dataIndex) ? 7 : 0,
        z: 2,
        lineStyle: {
          width: item.kind === 'real' ? 2.8 : 2.2,
          color,
          type:
            item.kind === 'real' || item.colorIndex % 3 === 0
              ? 'solid'
              : item.colorIndex % 3 === 1
                ? 'dashed'
                : 'dotted',
        },
        itemStyle: { color, borderColor: card, borderWidth: 1.5 },
        emphasis: { focus: 'series', scale: 1.5 },
        ...(inclusion && { markLine: {
          silent: true,
          symbol: ['none', 'none'],
          label: { show: false },
          lineStyle: { color, type: 'dashed', opacity: 0.65 },
          data: [{ xAxis: Date.parse(inclusion.timestamp) }],
        } }),
      };
      const bridges = (reference ? comparisonGapBridges(item, metric, reference) : []).map((bridge, index) => ({
        id: `${bridge.kind === 'warning' ? 'warning' : 'gap'}-bridge:${item.accountId}:${index}`,
        name,
        type: 'line',
        data: bridge.data,
        connectNulls: false,
        smooth: false,
        showSymbol: false,
        silent: true,
        tooltip: { show: false },
        lineStyle: bridge.kind === 'warning'
          ? { color: warning ?? color, width: 2, type: [8, 4], opacity: 0.95 }
          : { color, width: 1.5, type: 'dashed', opacity: 0.55 },
        emphasis: { disabled: true },
        animation: false,
        z: 1,
      }));
      return [observed, ...bridges];
    }),
  };
  const hasValues = series.some((item) =>
    item.points.some(
      (point) =>
        (metric === 'equity' ? point.equityUsd : point.returnPct) !== null,
    ),
  );
  if (!hasValues)
    return (
      realOnly ? <div className="min-h-24 space-y-5 text-xs text-muted-foreground" role="status">
        <p>{zh ? '当前时间范围暂无完整估值' : 'No complete valuations in this period'}</p>
        <p>{zh ? '可切换时间范围查看历史。' : 'Choose another date range to view history.'}</p>
      </div> :
      <div
        className={`portfolio-chart-empty ${compact ? 'compact' : ''}`}
        role="status"
      >
        <strong>
          {series.length === 0
            ? zh
              ? '选择要比较的账户'
              : 'Choose accounts to compare'
            : reference
              ? zh
                ? '历史行情尚未补齐'
                : 'Historical prices are incomplete'
              : zh
                ? '等待可比较的估值'
                : 'Waiting for comparable valuations'}
        </strong>
        <p>
          {series.length === 0
            ? zh
              ? '使用「选择账户」显示要比较的账户。'
              : 'Use Select accounts to choose which accounts to display.'
            : metric === 'return'
              ? zh
                ? '收益率需要有效起点与完整资金记录。可在「选择账户」中切换到资产金额。'
                : 'Returns need a valid starting value and cash-flow history. Account equity is available in chart options.'
              : reference
                ? zh
                  ? '可先查看当前持仓金额；不会为缺失价格添加虚构数据点。'
                  : 'Current account values remain available. Missing prices never become invented observations.'
                : zh
                  ? '当前区间还没有完整估值，稍后查看或选择更长时间。'
                  : 'No complete observations in this period. Try a longer period or check again later.'}
        </p>
      </div>
    );
  return (
    <>
      <div
        className={`portfolio-chart ${compact ? 'compact' : ''} ${realOnly && singleObservation ? 'portfolio-chart-single-point' : ''}`}
        role="img"
        aria-label={
          zh
            ? '账户表现对比折线图。完整数值可展开下方历史估值表查看。'
            : 'Portfolio performance comparison chart. Expand the historical valuations table below for all values.'
        }
      >
        <ReactECharts
          option={option}
          notMerge
          key={theme}
          style={{ height: '100%', width: '100%' }}
          opts={{ renderer: 'svg' }}
        />
      </div>
      {!realOnly && singleTimestamp !== undefined && (
        <p className="px-3 text-center text-xs leading-6 text-muted-foreground">
          {reference
            ? zh
              ? '当前仅有一条参考行情'
              : 'One reference price observation'
            : singleReturn
              ? zh ? '仅一条已存收益率，等待下一次观察' : 'One saved return observation'
              : zh
                ? '仅一条已存估值，等待下一次观察'
                : 'One saved valuation; waiting for the next observation'}{' '}
          ·{' '}
          {reference
            ? referenceIntraday ? new Date(singleTimestamp).toLocaleString(i18n.language)
              : series[0]?.points[0]?.date
            : formatComparisonTime(singleTimestamp, i18n.language)}
        </p>
      )}
      {annotation}
      <HistoricalValuations
        series={series}
        reference={reference}
        historySeries={historySeries}
      />
    </>
  );
}

/** An equivalent keyboard/screen-reader path for the pointer-only chart tooltip. */
function HistoricalValuations({
  series,
  reference,
  historySeries,
}: Pick<Props, 'series' | 'reference' | 'historySeries'>) {
  const { i18n } = useTranslation();
  const zh = i18n.language.startsWith('zh');
  const [open, setOpen] = useState(false);
  const money = new Intl.NumberFormat(i18n.language, {
    style: 'currency',
    currency: 'USD',
    currencyDisplay: 'narrowSymbol',
    maximumFractionDigits: 2,
  });
  return (
    <details
      className="portfolio-history-table"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="min-h-6 py-1">
        {reference
          ? zh
            ? '查看参考市值与历史价格来源'
            : 'View reference values and price sources'
          : zh
            ? '查看历史估值表'
            : 'View historical valuations'}
      </summary>
      {open && (
        <div
          className="portfolio-history-scroll"
          tabIndex={0}
          role="region"
          aria-label={zh ? '历史估值数据' : 'Historical valuation data'}
        >
          <table>
            <caption>
              {reference
                ? zh
                  ? '已覆盖持仓数量 × 有来源的收盘价或已存报价 × 当日汇率 · 缺失项、现金、分红和交易不计入'
                  : 'Covered current quantities × sourced closes or saved quotes × dated FX · Excludes missing positions, cash, dividends and trades'
                : zh
                  ? '所选账户的已存估值 · 缺少数值以“—”显示'
                  : 'Saved valuations for selected accounts · Missing values shown as “—”'}
            </caption>
            <thead>
              <tr>
                <th scope="col">{zh ? '账户' : 'Account'}</th>
                <th scope="col">
                  {reference
                    ? zh
                      ? '参考日期'
                      : 'Reference date'
                    : zh
                      ? '估值时间'
                      : 'Observed at'}
                </th>
                <th scope="col">
                  {reference
                    ? zh
                      ? '持仓参考市值'
                      : 'Reference holdings value'
                    : zh
                      ? '资产金额'
                      : 'Equity'}
                </th>
                <th scope="col">
                  {reference
                    ? zh
                      ? '行情依据'
                      : 'Price evidence'
                    : zh
                      ? '期间收益率'
                      : 'Period return'}
                </th>
              </tr>
            </thead>
            <tbody>
              {series.flatMap((item) =>
                item.points.map((point) => {
                  const evidence = referenceHistoryPoint(
                    historySeries?.find(row => row.accountId === item.accountId), point,
                  );
                  return (
                  <tr key={`${item.accountId}:${point.timestamp}`}>
                    <th scope="row">
                      {item.kind === 'real'
                        ? zh
                          ? '实仓'
                          : 'Real portfolio'
                        : item.name}
                    </th>
                    <td>
                      <time dateTime={reference && !evidence?.timestamp ? point.date : point.timestamp}>
                        {reference
                          ? evidence?.timestamp ? new Date(point.timestamp).toLocaleString(i18n.language) : point.date
                          : formatComparisonTime(point.timestamp, i18n.language, true)}
                      </time>
                    </td>
                    <td>
                      {point.equityUsd === null
                        ? '—'
                        : money.format(point.equityUsd)}
                    </td>
                    <td>
                      {reference ? (
                        <ReferenceEvidence
                          point={evidence}
                          zh={zh}
                          language={i18n.language}
                        />
                      ) : point.returnPct === null ? (
                        '—'
                      ) : (
                        `${point.returnPct.toFixed(2)}%`
                      )}
                    </td>
                  </tr>
                  );
                }),
              )}
            </tbody>
          </table>
        </div>
      )}
    </details>
  );
}

function ReferenceEvidence({
  point,
  zh,
  language,
}: {
  point?: PortfolioHistorySeries['points'][number];
  zh: boolean;
  language: string;
}) {
  if (!point) return '—';
  return (
    <details>
      <summary>
        {point.coveredPositions}/{point.totalPositions}{' '}
        {zh ? '标的 · 查看来源' : 'positions · Sources'}
      </summary>
      <ul>
        {point.priceAsOf.map((row) => (
          <li key={row.ticker}>
            {row.ticker} · {row.timestamp ? new Date(row.timestamp).toLocaleString(language) : row.date} · {row.source}
          </li>
        ))}
      </ul>
      <ul>
        {point.fxAsOf.map((row) => (
          <li key={row.currency}>
            {row.currency} → USD · {row.date} · {row.source}
          </li>
        ))}
      </ul>
      {point.gaps.length > 0 && (
        <p>
          {[
            ...new Set(point.gaps.map((gap) => comparisonGapLabel(gap, zh, true))),
          ].join(zh ? '；' : '; ')}
        </p>
      )}
    </details>
  );
}
