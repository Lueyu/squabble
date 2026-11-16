/**
 * MarketOverview.tsx — 仪表盘"市场概览"面板：市场情绪评分 + 主要指数行情。
 *
 * 职责边界：
 *  - 拉取并展示美 / 港 / 中三个市场的情绪评分（0-100）与主要指数报价；
 *  - 市场区域切换、手动刷新按钮、数据来源与估算方法的折叠说明；
 *  - 只负责本面板的数据与展示，不修改持仓 / 订单。
 * 上下游：
 *  - 上游：DashboardPage（渲染在 AI 分析状态卡下方）；
 *  - 下游：@/api/http（GET /api/portfolio/dashboard/market-overview）、
 *    @tanstack/react-query（缓存与轮询）、ui 组件（Card / Button / Skeleton）。
 * 关键约定：
 *  - 缓存 45s（staleTime），后台每 60s 轮询一次（refetchInterval，后台标签页不轮询）；
 *  - 监听全局 `portfolio-updated` 事件主动失效缓存以立即刷新；
 *  - 请求失败但已有旧数据时降级展示旧值，并提示"连接中断"；指数报价此时标记为 stale。
 */
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Activity, ArrowDownRight, ArrowUpRight, Minus, RefreshCw, Info } from 'lucide-react';
import http from '@/api/http';
import { cn } from '@/utils/format';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import type { Market, MarketOverviewResponse } from '@shared/api.interface';
import './market-overview.css';

/** 面板支持的三个市场区域，顺序即切换按钮顺序。 */
const MARKETS: Market[] = ['US', 'HK', 'CN'];
/** react-query 缓存键；`portfolio-updated` 事件也按它做失效。 */
const QUERY_KEY = ['market-overview'];

export default function MarketOverview() {
  const { t, i18n } = useTranslation();
  // 当前选中的市场区域（默认美股）。
  const [market, setMarket] = useState<Market>('US');
  const queryClient = useQueryClient();
  // ===== 数据获取区：单一查询承担全部面板数据（情绪 + 指数）=====
  const { data, isPending, isError, isFetching, refetch } = useQuery({
    queryKey: QUERY_KEY,
    queryFn: async (): Promise<MarketOverviewResponse> => {
      const response = await http.get<MarketOverviewResponse>(
        '/api/portfolio/dashboard/market-overview',
      );
      return response.data;
    },
    staleTime: 45_000,
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
    retry: 1,
  });
  // 订阅全局事件：任何页面改动持仓后广播 `portfolio-updated`，本面板立即刷新。
  useEffect(() => {
    const refresh = () => {
      void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    };
    window.addEventListener('portfolio-updated', refresh);
    return () => window.removeEventListener('portfolio-updated', refresh);
  }, [queryClient]);

  // ===== 派生计算区：从原始响应中筛选当前市场并推导展示状态 =====
  // 当前市场的情绪数据；指数列表按市场过滤（无数据时空数组）。
  const mood = data?.moods.find((item) => item.market === market);
  const indices = data?.indices.filter((item) => item.market === market) ?? [];
  // 出错时分数置空（展示"—"），避免用旧分数误导。
  const score = isError ? null : (mood?.score ?? null);
  // 情绪基调：< 40 看空、> 60 看多、之间为均衡；无分数为 unknown。
  const tone =
    score === null ? 'unknown' : score < 40 ? 'bearish' : score > 60 ? 'bullish' : 'balanced';
  // 按当前语言格式化数字 / 日期的小工具。
  const number = new Intl.NumberFormat(i18n.language, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  // 带符号的数值文本（正数加 "+"）。
  const signed = (value: number): string => `${value > 0 ? '+' : ''}${number.format(value)}`;
  // "YYYY-MM-DD" → 本地化的短日期文本（固定按 UTC 正午解析，避免时区偏移到前一天）。
  const date = (value: string): string =>
    new Intl.DateTimeFormat(i18n.language, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC',
    }).format(new Date(`${value}T12:00:00Z`));

  return (
    <Card className="dashboard-panel market-overview-card">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <Activity size={16} className="dashboard-brand-icon shrink-0" aria-hidden="true" />
            <CardTitle className="font-serif text-base">{t('marketOverview.title')}</CardTitle>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="size-7 shrink-0"
            disabled={isFetching}
            onClick={() => {
              void refetch();
            }}
            aria-label={t('marketOverview.refresh')}
          >
            <RefreshCw size={13} className={cn(isFetching && 'animate-spin')} />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* 市场区域切换按钮组（US / HK / CN） */}
        <div
          className="market-region-switch"
          role="group"
          aria-label={t('marketOverview.chooseMarket')}
        >
          {MARKETS.map((item) => (
            <button
              type="button"
              key={item}
              aria-pressed={market === item}
              onClick={() => setMarket(item)}
            >
              {t(`marketOverview.markets.${item}`)}
            </button>
          ))}
        </div>
        {/* 首次加载中：骨架屏占位 */}
        {isPending ? (
          <div className="space-y-3" aria-label={t('marketOverview.loading')} aria-busy="true">
            <Skeleton className="h-28 w-full" />
            <Skeleton className="h-36 w-full" />
          </div>
        ) : isError && !data ? (
          /* 加载失败且没有任何旧数据：整块失败提示 */
          <p className="py-6 text-sm text-muted-foreground" role="status">
            {t('marketOverview.loadFailed')}
          </p>
        ) : (
          /* 正常或"有旧数据但刷新失败"的降级展示 */
          <>
            {/* 什么时候走到这里：刷新失败但缓存里还有上一次的数据——顶部提示连接中断，内容仍用旧值 */}
            {isError && (
              <p role="status" className="text-xs text-warning">
                {t('marketOverview.connectionLost')}
              </p>
            )}
            {/* 情绪评分区：0-100 刻度条 + 当前分数标记 */}
            <div className="market-mood" data-tone={tone}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs text-muted-foreground">{t('marketOverview.mood')}</span>
                <span className="market-estimate-label">{t('marketOverview.estimate')}</span>
              </div>
              <div className="mt-2 flex items-baseline gap-2">
                <strong className="market-mood-value font-mono tabular-nums">{score ?? '—'}</strong>
                <span className="text-xs text-muted-foreground">/ 100</span>
                <span className="ml-auto text-sm font-medium">
                  {t(`marketOverview.tones.${tone}`)}
                </span>
              </div>
              <div
                className="market-mood-track"
                role="meter"
                aria-label={t('marketOverview.mood')}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={score ?? undefined}
                aria-valuetext={
                  score === null ? t('marketOverview.insufficient') : `${score} / 100`
                }
              >
                {/* 无分数（数据不足）时不渲染标记点 */}
                {score !== null && (
                  <span className="market-mood-marker" style={{ left: `${score}%` }} />
                )}
              </div>
              <div className="mt-1 flex justify-between text-[10px] text-muted-foreground">
                <span>{t('marketOverview.tones.bearish')}</span>
                <span>{t('marketOverview.tones.bullish')}</span>
              </div>
              <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
                {score === null
                  ? t('marketOverview.insufficient')
                  : t('marketOverview.coverage', {
                      covered: mood?.covered,
                      total: mood?.total,
                      change: signed(mood?.averageChangePercent ?? 0),
                    })}
              </p>
            </div>

            {/* 主要指数列表：名称、点位、涨跌幅、报价时间 */}
            <div>
              <div className="mb-2 flex flex-wrap items-center justify-between gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
                <span>{t('marketOverview.indices')}</span>
                {mood?.sessionDate && <span>{date(mood.sessionDate)}</span>}
              </div>
              <ul className="market-index-list" aria-label={t('marketOverview.indices')}>
                {indices.map((quote) => {
                  // 刷新失败但拿得到旧值时，把该指数标记为 stale（过期）。
                  const status = isError && quote.value !== null ? 'stale' : quote.status;
                  return (
                    <li key={quote.id}>
                      <div className="min-w-0">
                        <div className="text-xs font-medium">
                          {t(`marketOverview.names.${quote.id}`)}
                        </div>
                        <div className="mt-1 font-mono text-xs tabular-nums text-muted-foreground">
                          {quote.value === null ? '—' : number.format(quote.value)}
                        </div>
                        {status !== 'available' && (
                          <span className="text-[10px] text-warning">
                            {t(`marketOverview.status.${status}`)}
                          </span>
                        )}
                      </div>
                      <div className="min-w-0 text-right">
                        {/* 涨跌幅：非零时按正负显示红 / 绿箭头 */}
                        <div
                          className={cn(
                            'inline-flex items-center gap-1 font-mono text-xs font-semibold tabular-nums',
                            quote.changePercent === null || quote.changePercent === 0
                              ? 'text-muted-foreground'
                              : quote.changePercent > 0
                                ? 'text-success'
                                : 'text-destructive',
                          )}
                        >
                          {quote.changePercent === null || quote.changePercent === 0 ? (
                            <Minus size={12} aria-hidden="true" />
                          ) : quote.changePercent > 0 ? (
                            <ArrowUpRight size={12} aria-hidden="true" />
                          ) : (
                            <ArrowDownRight size={12} aria-hidden="true" />
                          )}
                          {quote.changePercent === null ? '—' : `${signed(quote.changePercent)}%`}
                        </div>
                        <div
                          className="mt-1 text-[10px] text-muted-foreground"
                          title={
                            quote.quoteTime
                              ? `${quote.quoteTime} · ${quote.timeZone}`
                              : t('marketOverview.noQuote')
                          }
                        >
                          {quote.quoteTime
                            ? quote.quoteTime.slice(5, 16)
                            : t('marketOverview.noQuote')}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>

            {/* 数据来源与估算方法说明（折叠块） */}
            <div className="space-y-2 text-[10px] leading-relaxed text-muted-foreground">
              <p>{t('marketOverview.source')}</p>
              <details className="market-mood-method">
                <summary className="flex cursor-pointer items-center gap-1.5 text-[11px]">
                  <Info size={12} aria-hidden="true" />
                  {t('marketOverview.methodTitle')}
                </summary>
                <p className="mt-2">{t('marketOverview.method')}</p>
                <p className="mt-1">{t('marketOverview.timing')}</p>
              </details>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
