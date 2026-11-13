import { useMemo, useState } from 'react';
import ReactECharts from 'echarts-for-react';
import { useTranslation } from 'react-i18next';
import { useTheme } from '@/hooks/use-theme';
import type {
  PortfolioComparisonMetric,
  PortfolioComparisonSeries,
  PortfolioComparisonView,
} from '@shared/portfolio-comparison.interface';
import type { PortfolioHistorySeries } from '@shared/portfolio-history.interface';
import { referenceHistoryPoint } from './comparison-display';
import {
  chartAccountColor,
  comparisonGapBridges,
  comparisonGapLabel,
  comparisonLineData,
  comparisonSymbolIndices,
  comparisonTimeWindow,
  comparisonTooltip,
  referenceDateLabel,
} from './comparison-chart-options';

interface Props {
  series: PortfolioComparisonSeries[];
  metric: PortfolioComparisonMetric;
  compact?: boolean;
  reference?: boolean;
  historySeries?: PortfolioHistorySeries[];
  partialAccountIds?: string[];
  granularity?: PortfolioComparisonView['granularity'];
  referenceGranularity?: 'observations' | 'hourly';
  onSelectAccount?: (accountId: string) => void;
}

export default function PortfolioComparisonChart({
  series,
  metric,
  compact = false,
  reference = false,
  historySeries,
  partialAccountIds,
  granularity,
  referenceGranularity,
  onSelectAccount,
}: Props) {
  const { i18n } = useTranslation();
  const { theme } = useTheme();
  const zh = i18n.language.startsWith('zh');
  const dark = theme === 'dark';
  const timeWindow = useMemo(() => comparisonTimeWindow(series), [series]);
  const singleObservation =
    timeWindow !== null && timeWindow.first === timeWindow.last;
  const quoteTimestamps = useMemo(() => historySeries?.flatMap(item => item.points
    .flatMap(point => point.timestamp && Number.isFinite(Date.parse(point.timestamp))
      ? [{ accountId: item.accountId, timestamp: Date.parse(point.timestamp) }] : [])) ?? [], [historySeries]);
  const referenceIntraday = reference && quoteTimestamps.length > 0;
  const intraday =
    referenceIntraday || (!reference &&
    (granularity === 'observations' || granularity === 'hourly'
      || (timeWindow !== null && timeWindow.last - timeWindow.first < 2 * 86400000)));
  const foreground = typeof window !== 'undefined' && typeof document !== 'undefined'
    ? window.getComputedStyle(document.querySelector('.portfolio-comparison') ?? document.documentElement)
      .getPropertyValue('--foreground').trim() || undefined : undefined;
  const option = useMemo(
    () => ({
      animationDuration: 200,
      aria: {
        enabled: true,
        description: reference
          ? zh
            ? '按当前持仓回看历史价格的参考市值，不含现金，不代表实际收益。浅色虚线连接可比较的缺失区间，不代表已知价格。价格口径变化仍断线。'
            : 'Current-position historical reference value, excluding cash, not actual returns. Faint dashed links join comparable missing intervals without inventing prices. Price-convention changes remain broken.'
          : zh
            ? '实仓与模拟账户的已存估值。资产金额的浅色虚线仅连接缺少观察的区间，不代表新增估值；收益率缺失与财务口径变化仍断线。'
            : 'Saved real and simulation valuations. Faint dashed equity links mark missing observations without adding valuations. Missing returns and financial discontinuities remain broken.',
      },
      grid: { top: 16, left: 6, right: 66, bottom: 36 },
      tooltip: {
        formatter: (params: unknown) => comparisonTooltip(params, i18n.language, metric, reference, quoteTimestamps),
        trigger: 'axis',
        renderMode: 'richText',
        confine: true,
        backgroundColor: dark ? '#202b28' : '#fff',
        borderColor: dark ? '#42524c' : '#dce5e0',
        textStyle: { color: dark ? '#e5ede8' : '#263e36', fontSize: 13 },
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
        min: singleObservation ? timeWindow.first - 3600000 : undefined,
        max: singleObservation ? timeWindow.first + 3600000 : undefined,
        minInterval: (reference ? referenceGranularity : granularity) === 'hourly'
          ? 3600000 : intraday ? 60000 : 86400000,
        axisLabel: {
          show: !singleObservation,
          color: dark ? '#a6b8ae' : '#65796f',
          hideOverlap: true,
          fontSize: 12,
          formatter: (value: number) =>
            reference
              ? referenceDateLabel(value, i18n.language, referenceIntraday)
              : new Intl.DateTimeFormat(zh ? 'zh-CN' : 'en-US', {
                  month: '2-digit',
                  day: '2-digit',
                  ...(intraday
                    ? ({ hour: '2-digit', minute: '2-digit' } as const)
                    : {}),
                }).format(value),
        },
      },
      yAxis: {
        type: 'value',
        position: 'right',
        scale: true,
        splitNumber: compact ? 3 : 4,
        axisLabel: {
          color: dark ? '#a6b8ae' : '#65796f',
          fontSize: 12,
          formatter: (value: number) =>
            metric === 'return'
              ? `${value > 0 ? '+' : ''}${Number(value.toFixed(1))}%`
              : new Intl.NumberFormat('en-US', {
                  notation: 'compact',
                  style: 'currency',
                  currency: 'USD',
                  maximumFractionDigits: 1,
                }).format(value),
        },
        splitLine: { lineStyle: { color: dark ? '#2c3c34' : '#e3ebe6' } },
      },
      series: series.flatMap((item) => {
        const color = chartAccountColor(item.accountId, item.colorIndex, dark, foreground);
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
          symbolSize: (_value: unknown, params: { dataIndex: number }) => symbols.has(params.dataIndex) ? 7 : 0,
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
          itemStyle: { color },
          emphasis: { focus: 'series' },
        };
        const bridges = comparisonGapBridges(item, metric, reference).map((bridge, index) => ({
          id: `gap-bridge:${item.accountId}:${index}`,
          name,
          type: 'line',
          data: bridge.data,
          connectNulls: false,
          smooth: false,
          showSymbol: false,
          silent: true,
          tooltip: { show: false },
          lineStyle: { color, width: 1.5, type: 'dashed', opacity: 0.55 },
          emphasis: { disabled: true },
          animation: false,
          z: 1,
        }));
        return [observed, ...bridges];
      }),
    }),
    [
      series,
      metric,
      compact,
      dark,
      zh,
      timeWindow,
      singleObservation,
      intraday,
      reference,
      i18n.language,
      partialAccountIds,
      granularity,
      foreground,
      quoteTimestamps,
      referenceIntraday,
      referenceGranularity,
    ],
  );
  const hasValues = series.some((item) =>
    item.points.some(
      (point) =>
        (metric === 'equity' ? point.equityUsd : point.returnPct) !== null,
    ),
  );
  if (!hasValues)
    return (
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
              ? '点击上方图例或比较设置，显示至少一个账户。'
              : 'Use the legend or comparison settings to show at least one account.'
            : metric === 'return'
              ? zh
                ? '收益率需要有效起点与完整资金记录。可以切换到资产金额查看。'
                : 'Returns need a valid starting value and cash-flow history. Switch to equity to view available observations.'
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
        className={`portfolio-chart ${compact ? 'compact' : ''}`}
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
          style={{ height: '100%', width: '100%' }}
          opts={{ renderer: 'svg' }}
          onEvents={{
            click: (event: { seriesId?: string }) => {
              if (
                event.seriesId &&
                series.some((item) => item.accountId === event.seriesId)
              )
                onSelectAccount?.(event.seriesId);
            },
          }}
        />
      </div>
      {singleObservation && (
        <p className="px-3 text-center text-xs leading-6 text-muted-foreground">
          {reference
            ? zh
              ? '当前仅有一条参考行情'
              : 'One reference price observation'
            : zh
              ? '仅一条已存估值，等待下一次观察'
              : 'One saved valuation; waiting for the next observation'}{' '}
          ·{' '}
          {reference
            ? referenceIntraday ? new Date(timeWindow.first).toLocaleString(i18n.language)
              : series[0]?.points[0]?.date
            : new Date(timeWindow.first).toLocaleString(i18n.language)}
        </p>
      )}
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
                          : new Date(point.timestamp).toLocaleString(
                              i18n.language,
                            )}
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
            ...new Set(point.gaps.map((gap) => comparisonGapLabel(gap, zh))),
          ].join(zh ? '；' : '; ')}
        </p>
      )}
    </details>
  );
}
