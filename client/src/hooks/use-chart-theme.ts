/** Resolve semantic CSS colors for canvas charts and refresh with appearance. */
import { useLayoutEffect, useState } from 'react';
import { useTheme } from './use-theme';

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

/** Computed RGB is supported by ECharts even when the source token uses HSL. */
function withAlpha(color: string, opacity: number): string {
  const channels: RegExpMatchArray | null = color.match(/[\d.]+/g);
  if (!channels || channels.length < 3) return color;
  return `rgba(${channels[0]}, ${channels[1]}, ${channels[2]}, ${opacity})`;
}

function readChartTheme(): ChartTheme {
  if (typeof document === 'undefined') return INITIAL_CHART_THEME;

  const root: HTMLElement = document.documentElement;
  const probe: HTMLSpanElement = document.createElement('span');
  probe.style.display = 'none';
  root.appendChild(probe);
  const resolve = (token: string): string => {
    probe.style.color = `var(${token})`;
    return getComputedStyle(probe).color;
  };
  const muted: string = resolve('--muted-foreground');
  const line: string = resolve('--chart-1');
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
  probe.remove();
  return palette;
}

export function useChartTheme(): ChartTheme {
  const { theme, designTheme } = useTheme();
  const [palette, setPalette] = useState<ChartTheme>(INITIAL_CHART_THEME);

  useLayoutEffect(() => {
    const refresh = (): void => setPalette(readChartTheme());
    refresh();
    // Theme setters and other tabs can update the root outside this component.
    const observer: MutationObserver = new MutationObserver(refresh);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'data-design-theme', 'style'],
    });
    return () => observer.disconnect();
  }, [theme, designTheme]);

  return palette;
}
