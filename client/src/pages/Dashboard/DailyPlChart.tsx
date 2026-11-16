/**
 * @file pages/Dashboard/DailyPlChart.tsx
 * @description ECharts dual-axis chart: account equity line + daily P/L bars.
 *
 * Left Y-axis = account net value (line, area gradient); right Y-axis = daily
 * P/L (green/red bars). Bars are colored by sign (green = gain, red = loss).
 * Tooltip shows both series with adaptive currency symbol.
 */
import { useMemo } from 'react';
import ReactECharts from 'echarts-for-react';
import { useTranslation } from 'react-i18next';
import { useChartTheme } from '@/hooks/use-chart-theme';

/** Props for {@link DailyPlChart}. */
interface DailyPlChartProps {
  /** Daily series: date, account value, daily P/L, daily P/L percent. */
  data: Array<{ date: string; accountValue: string; dailyPl: string; dailyPct: string }>;
  /** Base currency code for axis labels / tooltip; defaults to USD. */
  baseCurrency?: string;
}

/** Currency symbol lookup used by axis/tooltip formatting. */
const CURRENCY_SYMBOL: Record<string, string> = {
  USD: '$',
  HKD: 'HK$',
  CNY: '¥',
};

/**
 * Render the dual-axis daily P/L chart.
 * @param props - See {@link DailyPlChartProps}.
 */
export default function DailyPlChart({ data, baseCurrency = 'USD' }: DailyPlChartProps) {
  const { t } = useTranslation();
  const colors = useChartTheme();
  const symbol = CURRENCY_SYMBOL[baseCurrency.toUpperCase()] || '$';

  const option = useMemo(() => {
    if (data.length === 0) return {};
    // X-axis labels show MM-DD (year dropped) to save horizontal space.
    const dates = data.map((d) => d.date.slice(5));
    const accountValues = data.map((d) => Number(d.accountValue) || 0);
    const dailyPls = data.map((d) => Number(d.dailyPl) || 0);

    return {
      backgroundColor: colors.surface,
      textStyle: { color: colors.foreground, fontFamily: colors.fontFamily },
      tooltip: {
        trigger: 'axis',
        confine: true,
        backgroundColor: colors.tooltipBackground,
        borderColor: colors.border,
        textStyle: { color: colors.tooltipForeground },
        axisPointer: {
          type: 'cross',
          crossStyle: { color: colors.muted },
          label: { backgroundColor: colors.foreground, color: colors.surface },
        },
        formatter: (params: { name: string; seriesName: string; value: number }[]) => {
          if (!params || params.length === 0) return '';
          const parts = [`<strong>${params[0].name}</strong>`];
          for (const p of params) {
            if (p.seriesName === t('dash.accountNav')) {
              parts.push(
                `${t('dash.accountNav')}: <strong>${symbol}${p.value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong>`,
              );
            } else {
              const sign = p.value >= 0 ? '+' : '';
              const color = p.value >= 0 ? '#16a34a' : '#dc2626';
              parts.push(
                `${t('dash.dailyPlLabel')}: <strong style="color:${color}">${sign}${symbol}${p.value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong>`,
              );
            }
          }
          return parts.join('<br/>');
        },
      },
      legend: {
        data: [t('dash.accountNav'), t('dash.dailyPlLabel')],
        top: 4,
        left: 'center',
        orient: 'horizontal',
        itemGap: 16,
        textStyle: { fontSize: 11, color: colors.muted },
      },
      grid: { top: 38, right: 50, bottom: 40, left: 54 },
      xAxis: {
        type: 'category',
        data: dates,
        axisLabel: { fontSize: 10, color: colors.muted, rotate: data.length > 20 ? 45 : 0 },
        axisLine: { lineStyle: { color: colors.border } },
        axisTick: { show: false },
      },
      yAxis: [
        {
          type: 'value',
          axisLabel: {
            fontSize: 10,
            color: colors.muted,
            formatter: (val: number) => {
              if (Math.abs(val) >= 1e6) return `${(val / 1e6).toFixed(1)}M`;
              if (Math.abs(val) >= 1e3) return `${(val / 1e3).toFixed(0)}k`;
              return val.toFixed(0);
            },
          },
          splitLine: { lineStyle: { color: colors.grid, type: 'dashed' } },
        },
        {
          type: 'value',
          axisLabel: {
            fontSize: 10,
            color: colors.muted,
            formatter: (val: number) => {
              if (Math.abs(val) >= 1e3) return `${(val / 1e3).toFixed(0)}k`;
              return val.toFixed(0);
            },
          },
          splitLine: { show: false },
        },
      ],
      series: [
        {
          name: t('dash.accountNav'),
          type: 'line',
          yAxisIndex: 0,
          data: accountValues,
          smooth: true,
          symbol: 'none',
          lineStyle: { color: colors.line, width: 2 },
          itemStyle: { color: colors.line },
          areaStyle: {
            color: {
              type: 'linear',
              x: 0,
              y: 0,
              x2: 0,
              y2: 1,
              colorStops: [
                { offset: 0, color: colors.areaStart },
                { offset: 1, color: colors.areaEnd },
              ],
            },
          },
        },
        {
          name: t('dash.dailyPlLabel'),
          type: 'bar',
          yAxisIndex: 1,
          data: dailyPls.map((v) => ({
            value: v,
            itemStyle: {
              color: v >= 0 ? '#16a34a' : '#dc2626',
              borderRadius: [3, 3, 0, 0],
            },
          })),
          barWidth: Math.max(4, Math.min(14, 300 / data.length)),
        },
      ],
    };
  }, [data, symbol, t, colors]);

  if (data.length === 0) {
    return (
      <div className="flex h-[280px] items-center justify-center text-sm text-muted-foreground">
        {t('ui.dashboard.dailyChartNoData')}
      </div>
    );
  }

  return (
    <ReactECharts option={option} style={{ height: 280, width: '100%' }} notMerge lazyUpdate />
  );
}
