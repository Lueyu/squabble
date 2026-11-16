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

const MARKETS: Market[] = ['US', 'HK', 'CN'];
const QUERY_KEY = ['market-overview'];

export default function MarketOverview() {
  const { t, i18n } = useTranslation();
  const [market, setMarket] = useState<Market>('US');
  const queryClient = useQueryClient();
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
  useEffect(() => {
    const refresh = () => {
      void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    };
    window.addEventListener('portfolio-updated', refresh);
    return () => window.removeEventListener('portfolio-updated', refresh);
  }, [queryClient]);

  const mood = data?.moods.find((item) => item.market === market);
  const indices = data?.indices.filter((item) => item.market === market) ?? [];
  const score = isError ? null : (mood?.score ?? null);
  const tone =
    score === null ? 'unknown' : score < 40 ? 'bearish' : score > 60 ? 'bullish' : 'balanced';
  const number = new Intl.NumberFormat(i18n.language, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const signed = (value: number): string => `${value > 0 ? '+' : ''}${number.format(value)}`;
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
        {isPending ? (
          <div className="space-y-3" aria-label={t('marketOverview.loading')} aria-busy="true">
            <Skeleton className="h-28 w-full" />
            <Skeleton className="h-36 w-full" />
          </div>
        ) : isError && !data ? (
          <p className="py-6 text-sm text-muted-foreground" role="status">
            {t('marketOverview.loadFailed')}
          </p>
        ) : (
          <>
            {isError && (
              <p role="status" className="text-xs text-warning">
                {t('marketOverview.connectionLost')}
              </p>
            )}
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

            <div>
              <div className="mb-2 flex flex-wrap items-center justify-between gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
                <span>{t('marketOverview.indices')}</span>
                {mood?.sessionDate && <span>{date(mood.sessionDate)}</span>}
              </div>
              <ul className="market-index-list" aria-label={t('marketOverview.indices')}>
                {indices.map((quote) => {
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
