/**
 * DailyPlChart.tsx — 账户净值曲线 + 每日盈亏柱状的 ECharts 双轴图。
 *
 * 职责边界：
 *  - 纯展示组件：左轴画账户净值（平滑曲线 + 渐变面积），右轴画每日盈亏；
 *  - 柱子按正负着色（绿 = 盈利，红 = 亏损）；tooltip 同时展示两条序列，
 *    货币符号随 baseCurrency 自适应；
 *  - 不发请求、不管理业务状态，数据全部由父组件传入。
 * 上下游：
 *  - 上游：DashboardPage 的"每日盈亏"卡片（<DailyPlChart data={dailyPl} .../>）；
 *  - 下游：echarts-for-react（ReactECharts）、useChartTheme（图表主题色）、react-i18next（文案）。
 * 关键约定：
 *  - data 为空时渲染同高占位文案，不渲染图表；
 *  - option 用 useMemo 缓存，依赖 [data, symbol, t, colors] 变化才重建。
 */
import { useMemo } from 'react';
import ReactECharts from 'echarts-for-react';
import { useTranslation } from 'react-i18next';
import { useChartTheme } from '@/hooks/use-chart-theme';

/** {@link DailyPlChart} 的入参。 */
interface DailyPlChartProps {
  /** 日线序列：日期、账户净值、每日盈亏、每日盈亏百分比。 */
  data: Array<{ date: string; accountValue: string; dailyPl: string; dailyPct: string }>;
  /** 坐标轴 / tooltip 使用的基准货币代码；缺省 USD。 */
  baseCurrency?: string;
}

/** 货币代码 → 符号的查找表，供坐标轴 / tooltip 格式化使用。 */
const CURRENCY_SYMBOL: Record<string, string> = {
  USD: '$',
  HKD: 'HK$',
  CNY: '¥',
};

/**
 * 渲染每日盈亏双轴图。
 * @param props - 见 {@link DailyPlChartProps}。
 */
export default function DailyPlChart({ data, baseCurrency = 'USD' }: DailyPlChartProps) {
  const { t } = useTranslation();
  // 图表主题色（随亮 / 暗主题切换）。
  const colors = useChartTheme();
  // 未收录的货币代码回退为 $。
  const symbol = CURRENCY_SYMBOL[baseCurrency.toUpperCase()] || '$';

  // 图表配置构建：仅在 data / 货币符号 / 文案 / 主题变化时重建。
  const option = useMemo(() => {
    if (data.length === 0) return {};
    // X 轴标签只显示 MM-DD（去掉年份）以节省横向空间。
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
        // tooltip 自定义格式：第一行日期，随后账户净值一行 + 每日盈亏一行（按正负着色）。
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
      // 序列 1：净值曲线（左轴，平滑 + 渐变面积）；序列 2：每日盈亏柱（右轴）。
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
          // 每根柱子按盈亏正负单独着色：正 = 绿、负 = 红。
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

  // 没有数据时渲染占位提示（与图表同高，避免布局跳动）。
  if (data.length === 0) {
    return (
      <div className="flex h-[280px] items-center justify-center text-sm text-muted-foreground">
        {t('ui.dashboard.dailyChartNoData')}
      </div>
    );
  }

  // 正常渲染图表；notMerge 保证 data 变化时整体替换配置。
  return (
    <ReactECharts option={option} style={{ height: 280, width: '100%' }} notMerge lazyUpdate />
  );
}
