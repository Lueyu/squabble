import { useMemo, useState } from 'react';
import ReactECharts from 'echarts-for-react';
import { useTranslation } from 'react-i18next';
import { useTheme } from '@/hooks/use-theme';
import type {
  PortfolioComparisonMetric,
  PortfolioComparisonSeries,
} from '@shared/portfolio-comparison.interface';
import type { PortfolioHistorySeries } from '@shared/portfolio-history.interface';
import {
  accountColor,
  comparisonGapLabel,
  comparisonLineData,
  comparisonTimeWindow,
  referenceDateLabel,
  referenceTooltip,
} from './comparison-chart-options';

interface Props {
  series: PortfolioComparisonSeries[];
  metric: PortfolioComparisonMetric;
  compact?: boolean;
  reference?: boolean;
  historySeries?: PortfolioHistorySeries[];
  onSelectAccount?: (accountId: string) => void;
}

export default function PortfolioComparisonChart({
  series,
  metric,
  compact = false,
  reference = false,
  historySeries,
  onSelectAccount,
}: Props) {
  const { i18n } = useTranslation();
  const { theme } = useTheme();
  const zh = i18n.language.startsWith('zh');
  const dark = theme === 'dark';
  const timeWindow = useMemo(() => comparisonTimeWindow(series), [series]);
  const singleObservation =
    timeWindow !== null && timeWindow.first === timeWindow.last;
  const intraday =
    !reference &&
    timeWindow !== null &&
    timeWindow.last - timeWindow.first < 2 * 86400000;
  const option = useMemo(
    () => ({
      animationDuration: 200,
      aria: {
        enabled: true,
        description: reference
          ? zh
            ? '按当前持仓回看历史价格的参考市值，不含现金，不代表实际收益。缺少资料的日期断线。'
            : 'Current-position historical reference value, excluding cash. Not actual investment returns. Missing observations break the line.'
          : zh
            ? '实仓与模拟账户的历史估值。缺少资料的日期断线显示。'
            : 'Saved real and simulation valuations. Missing observations break the line.',
      },
      grid: { top: 16, left: 6, right: 66, bottom: 36 },
      tooltip: {
        formatter: reference
          ? (params: unknown) => referenceTooltip(params, i18n.language)
          : undefined,
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
        minInterval: intraday ? 60000 : 86400000,
        axisLabel: {
          show: !singleObservation,
          color: dark ? '#a6b8ae' : '#65796f',
          hideOverlap: true,
          fontSize: 12,
          formatter: (value: number) =>
            reference
              ? referenceDateLabel(value, i18n.language)
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
      series: series.map((item) => ({
        id: item.accountId,
        name:
          item.kind === 'real' ? (zh ? '实仓' : 'Real portfolio') : item.name,
        type: 'line',
        data: comparisonLineData(item, metric),
        connectNulls: false,
        smooth: false,
        showSymbol:
          item.points.filter((point) => point.equityUsd !== null).length < 3,
        symbol: 'circle',
        symbolSize: 7,
        lineStyle: {
          width: item.kind === 'real' ? 2.8 : 2.2,
          color:
            item.kind === 'real' && dark
              ? '#c9ded2'
              : accountColor(item.accountId, item.colorIndex),
          type:
            item.kind === 'real' || item.colorIndex % 3 === 0
              ? 'solid'
              : item.colorIndex % 3 === 1
                ? 'dashed'
                : 'dotted',
        },
        itemStyle: {
          color:
            item.kind === 'real' && dark
              ? '#c9ded2'
              : accountColor(item.accountId, item.colorIndex),
        },
        emphasis: { focus: 'series' },
      })),
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
                  ? '可先查看当前持仓金额；缺失价格不会连接成曲线。'
                  : 'Current account values remain available. Missing prices never become an invented line.'
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
              ? '当前仅有一天参考行情'
              : 'One day of reference prices'
            : zh
              ? '仅一条已存估值，等待下一次观察'
              : 'One saved valuation; waiting for the next observation'}{' '}
          ·{' '}
          {reference
            ? series[0]?.points[0]?.date
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
      <summary>
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
                  ? '当前数量 × 历史收盘价 × 当日汇率 · 不含现金、分红或交易'
                  : 'Current quantities × historical closes × dated FX · Excludes cash, dividends and trades'
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
                item.points.map((point) => (
                  <tr key={`${item.accountId}:${point.timestamp}`}>
                    <th scope="row">
                      {item.kind === 'real'
                        ? zh
                          ? '实仓'
                          : 'Real portfolio'
                        : item.name}
                    </th>
                    <td>
                      <time dateTime={reference ? point.date : point.timestamp}>
                        {reference
                          ? point.date
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
                          point={historySeries
                            ?.find((row) => row.accountId === item.accountId)
                            ?.points.find((row) => row.date === point.date)}
                          zh={zh}
                        />
                      ) : point.returnPct === null ? (
                        '—'
                      ) : (
                        `${point.returnPct.toFixed(2)}%`
                      )}
                    </td>
                  </tr>
                )),
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
}: {
  point?: PortfolioHistorySeries['points'][number];
  zh: boolean;
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
            {row.ticker} · {row.date} · {row.source}
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
