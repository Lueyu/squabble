/**
 * @file hooks/use-chart-theme.ts
 * @description 把语义 CSS 颜色 token 解析成 canvas 图表可用的实际色值，并随外观变化刷新。
 *
 * canvas（ECharts 等）无法直接吃 CSS 变量，这里在 documentElement 上挂一个
 * 隐藏探针元素，把 `var(--token)` 解析成 computed color；同时监听根元素的
 * class / data-design-theme / style 变化，主题切换时自动重新解析。
 *
 * 职责边界：
 *  - 只做"CSS token → 色板对象"的解析与刷新；主题状态本身在 hooks/use-theme.ts
 * 上下游：
 *  - 上游（谁调用这里）：PaperPage、Journal/JournalChart、Dashboard/DailyPlChart
 *  - 下游（本文件调用谁）：./use-theme（感知主题变化）；DOM 探针 + MutationObserver
 * 关键约定：
 *  - 色板字段名（surface/line/grid 等）是图表组件的消费契约，勿改名
 *  - SSR / 无 document 环境返回 INITIAL_CHART_THEME 兜底色
 */
import { useLayoutEffect, useState } from 'react';
import { useTheme } from './use-theme';

/** 图表色板：语义化字段，供 canvas 图表直接取用。 */
interface ChartTheme {
  surface: string;
  foreground: string;
  muted: string;
  border: string;
  grid: string;
  line: string;
  areaStart: string;
  areaEnd: string;
  tooltipBackground: string;
  tooltipForeground: string;
  fontFamily: string;
}

/** 无 document 时的兜底色板（接近浅色主题的默认观感）。 */
const INITIAL_CHART_THEME: ChartTheme = {
  surface: '#fff',
  foreground: '#222',
  muted: '#666',
  border: '#ddd',
  grid: '#eee',
  line: '#477fbe',
  areaStart: 'rgba(71, 127, 190, 0.2)',
  areaEnd: 'rgba(71, 127, 190, 0)',
  tooltipBackground: '#fff',
  tooltipForeground: '#222',
  fontFamily: 'sans-serif',
};

/**
 * 给颜色加透明度（rgba）。即使源 token 用 HSL 定义，computed style 拿到的
 * 已是 RGB 形式，ECharts 同样支持。
 */
function withAlpha(color: string, opacity: number): string {
  // 从颜色字符串里抽数值通道；抽不满 3 个就原样返回。
  const channels: RegExpMatchArray | null = color.match(/[\d.]+/g);
  if (!channels || channels.length < 3) return color;
  return `rgba(${channels[0]}, ${channels[1]}, ${channels[2]}, ${opacity})`;
}

/** 挂探针 → 逐 token 解析 → 移除探针，返回当前主题下的完整色板。 */
function readChartTheme(): ChartTheme {
  if (typeof document === 'undefined') return INITIAL_CHART_THEME;

  // 步骤 1：创建一个隐藏探针元素挂到根节点上（display:none 不参与布局）。
  const root: HTMLElement = document.documentElement;
  const probe: HTMLSpanElement = document.createElement('span');
  probe.style.display = 'none';
  root.appendChild(probe);

  // 步骤 2：定义解析函数 —— 给探针设 `var(token)` 再读 computed color。
  const resolve = (token: string): string => {
    probe.style.color = `var(${token})`;
    return getComputedStyle(probe).color;
  };

  // 步骤 3：先解析出 muted 与 line 两个被派生复用的颜色。
  const muted: string = resolve('--muted-foreground');
  const line: string = resolve('--chart-1');

  // 步骤 4：组装色板（grid/area 用 withAlpha 派生透明版本）。
  const palette: ChartTheme = {
    surface: resolve('--card'),
    foreground: resolve('--foreground'),
    muted,
    border: resolve('--border'),
    grid: withAlpha(muted, 0.2),
    line,
    areaStart: withAlpha(line, 0.2),
    areaEnd: withAlpha(line, 0),
    tooltipBackground: resolve('--popover'),
    tooltipForeground: resolve('--popover-foreground'),
    fontFamily: getComputedStyle(root).getPropertyValue('--font-sans').trim() || 'sans-serif',
  };

  // 步骤 5：移除探针并返回。
  probe.remove();
  return palette;
}

/**
 * 获取随主题实时刷新的图表色板。
 * @returns 当前主题下的 ChartTheme 对象（引用随主题变化而更新）。
 */
export function useChartTheme(): ChartTheme {
  // 步骤 1：订阅主题状态，主题或设计主题变化时触发重新解析。
  const { theme, designTheme } = useTheme();
  const [palette, setPalette] = useState<ChartTheme>(INITIAL_CHART_THEME);

  useLayoutEffect(() => {
    // 步骤 2：先同步解析一次。
    const refresh = (): void => setPalette(readChartTheme());
    refresh();

    // 步骤 3：主题 setter 与其他页签会在本组件之外改根元素，
    // 因此监听根节点的 class / data-design-theme / style 属性变化。
    const observer: MutationObserver = new MutationObserver(refresh);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'data-design-theme', 'style'],
    });

    // 步骤 4：卸载时断开观察器。
    return () => observer.disconnect();
  }, [theme, designTheme]);

  return palette;
}
