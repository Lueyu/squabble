/**
 * JournalChart.tsx — 交易日志页的双轴 ECharts 图（每日盈亏柱 + 账户净值线）。
 *
 * 职责边界：
 *  - 柱状图画每日盈亏（左轴，按正负着色：绿 = 盈利、红 = 亏损），
 *    平滑面积线画账户净值走势（右轴）；
 *  - 数据先按日期升序排序、过滤掉无法解析的日期，再组装 ECharts option；
 *  - 纯展示组件：不发请求、不持业务状态，快照数据与加载态由父组件传入。
 * 上下游：
 *  - 上游：JournalPage（snapshots + loading）；
 *  - 下游：echarts-for-react（ReactECharts）、useChartTheme（图表主题色）、
 *    @/utils/format 的 toDate（日期有效性判断）、react-i18next（文案）。
 * 关键约定：
 *  - Snapshot 的 dailyPl / accountValue 为"字符串数值"（服务端序列化约定），
 *    参与图表前必须 Number() 转 number（并 || 0 兜底），禁止直接字符串运算；
 *  - 无有效数据时 chartOption 返回 {}，组件级再由 loading / 空态分支兜住。
 */
import { useMemo } from 'react';
import ReactECharts from 'echarts-for-react';
import type { Snapshot } from '@shared/api.interface';
import { toDate } from '@/utils/format';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Empty, EmptyContent, EmptyTitle, EmptyDescription } from '@/components/ui/empty';
import { useTranslation } from 'react-i18next';
import { useChartTheme } from '@/hooks/use-chart-theme';

/** {@link JournalChart} 的入参。 */
interface JournalChartProps {
  /** 账户快照序列（金额字段为字符串数值）。 */
  snapshots: Snapshot[];
  /** 加载中标记：为 true 时渲染骨架屏。 */
  loading: boolean;
}

/**
 * 渲染"每日盈亏柱 + 账户净值线"双轴图。
 * @param props - 见 {@link JournalChartProps}。
 */
export function JournalChart({ snapshots, loading }: JournalChartProps) {
  const { t } = useTranslation();
  // 图表主题色（随亮 / 暗主题切换）。
  const colors = useChartTheme();

  // 图表配置构建：过滤无效日期 → 按日期升序 → 抽出三个序列 → 组装 option。
  // 仅在 snapshots / 文案 / 主题变化时重建。
  const chartOption = useMemo(() => {
    // 第一步：过滤掉 snapshotDate 解析不出有效日期的脏数据。
    const valid = snapshots.filter((s) => toDate(s.snapshotDate));
    if (valid.length === 0) return {};
    // 第二步：按日期升序排序（不改动原数组，拷贝后 sort）。
    const sorted = [...valid].sort(
      (a, b) => new Date(a.snapshotDate).getTime() - new Date(b.snapshotDate).getTime(),
    );

    // 第三步：抽出 X 轴标签（M/D 短格式）与两个数值序列（字符串数值 → number，|| 0 兜底）。
    const dates = sorted.map((s) => {
      const d = new Date(s.snapshotDate);
      return `${d.getMonth() + 1}/${d.getDate()}`;
    });
    const dailyPl = sorted.map((s) => Number(s.dailyPl) || 0);
    const accountValues = sorted.map((s) => Number(s.accountValue) || 0);

    // 第四步：组装 ECharts option（tooltip 十字准星、双 Y 轴、两个 series）。
    return {
      backgroundColor: colors.surface,
      textStyle: { color: colors.foreground, fontFamily: colors.fontFamily },
      grid: { top: 42, right: 54, bottom: 40, left: 54 },
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
      },
      legend: {
        data: [t('journal.dailyPl'), t('journal.accountNav')],
        top: 4,
        left: 'center',
        orient: 'horizontal',
        itemGap: 16,
        textStyle: { fontSize: 12, color: colors.muted },
      },
      xAxis: {
        type: 'category',
        data: dates,
        axisLabel: { fontSize: 10, color: colors.muted, interval: 'auto' },
        axisLine: { lineStyle: { color: colors.border } },
        axisTick: { show: false },
      },
      yAxis: [
        {
          // 左轴：每日盈亏，大数缩写为 k。
          type: 'value',
          axisLabel: {
            fontSize: 10,
            color: colors.muted,
            formatter: (v: number) =>
              Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(0)}k` : String(v),
          },
          splitLine: { lineStyle: { color: colors.grid, type: 'dashed' } },
        },
        {
          // 右轴：账户净值，同样缩写但不画分隔线（避免与左轴网格重叠）。
          type: 'value',
          axisLabel: {
            fontSize: 10,
            color: colors.muted,
            formatter: (v: number) =>
              Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(0)}k` : String(v),
          },
          splitLine: { show: false },
        },
      ],
      series: [
        {
          // 序列一：每日盈亏柱（绑左轴），逐点按正负着色。
          name: t('journal.dailyPl'),
          type: 'bar',
          yAxisIndex: 0,
          data: dailyPl.map((v) => ({
            value: Number(v.toFixed(2)),
            itemStyle: {
              color: v >= 0 ? '#16a34a' : '#dc2626',
              borderRadius: [3, 3, 0, 0],
            },
          })),
          barWidth: '50%',
        },
        {
          // 序列二：账户净值平滑面积线（绑右轴），颜色取主题 line 色。
          name: t('journal.accountNav'),
          type: 'line',
          yAxisIndex: 1,
          data: accountValues.map((v) => Number(v.toFixed(2))),
          smooth: true,
          symbol: 'circle',
          symbolSize: 5,
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
      ],
    };
  }, [snapshots, t, colors]);

  // 渲染区：加载骨架屏 → 无快照空态 → 正常图表，三选一。
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between pb-3">
        <CardTitle className="font-serif text-lg">{t('ui.journal.chartTitle')}</CardTitle>
        <span className="text-xs text-muted-foreground">{t('ui.journal.last30Days')}</span>
      </CardHeader>
      <CardContent>
        {loading ? (
          // 加载中：固定高度骨架占位（与图表同高）。
          <Skeleton className="h-[300px] w-full" />
        ) : snapshots.length === 0 ? (
          // 无数据：整个快照列表为空时的空态提示。
          <Empty className="py-16">
            <EmptyContent>
              <EmptyTitle>{t('ui.journal.noSnapshots')}</EmptyTitle>
              <EmptyDescription>{t('ui.journal.chartEmptyHint')}</EmptyDescription>
            </EmptyContent>
          </Empty>
        ) : (
          // 有数据：渲染图表。notMerge 防止旧 option 残留。
          <ReactECharts
            option={chartOption}
            style={{ height: 300, width: '100%' }}
            notMerge
            lazyUpdate
          />
        )}
      </CardContent>
    </Card>
  );
}
