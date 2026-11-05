/**
 * @file pages/Analysis/AnalysisPage.tsx
 * @description Route `/analysis`: daily research/review page.
 *
 * Two view modes:
 *  - Traditional: per-date analysis cards, with a special portfolio-level card
 *    (ticker === 'PORTFOLIO'), rating filter pills, and a date sidebar.
 *  - Multi-Agent: list of versioned deep-research reports fetched from the
 *    authenticated server API. Clicking
 *    a card navigates to DeepReportPage.
 *
 * Refetches on window focus/visibility change; prev/next date buttons step
 * through the available analysis dates (newest first).
 */
import { useState, useEffect, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import {
ChevronLeft,
ChevronRight,
Calendar,
AlertTriangle,
BarChart3,
Sparkles,
Bot,
LayoutGrid,
ArrowRight,
MessageSquare,
FlaskConical,
} from 'lucide-react';
import { toast } from 'sonner';
import type {
  Analysis as AnalysisType,
  AgentRunWithRating,
} from '@shared/api.interface';
import {
  fetchAnalysis,
  fetchAnalysisDates,
  getAgentRuns,
} from '@/api';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { formatDate, formatDateTime, cn } from '@/utils/format';
import { displayCompanyName } from '@/utils/company-name';
import AnalysisCard from './AnalysisCard';
import AnalysisRunner from './AnalysisRunner';

/** Ticker sentinel for the portfolio-level analysis card. */
const PORTFOLIO_TICKER = 'PORTFOLIO';

/** Rating order used for the filter pills. */
const RATING_ORDER = ['Strong Buy', 'Buy', 'Hold', 'Sell', 'Strong Sell'];

function localizedRating(value: string | null | undefined, t: (key: string) => string): string {
  const keys: Record<string, string> = {
    'Strong Buy': 'analysis.strongBuy', Buy: 'analysis.buy', Hold: 'analysis.hold',
    Sell: 'analysis.sell', 'Strong Sell': 'analysis.strongSell', Watch: 'analysis.watch',
  };
  return value && keys[value] ? t(keys[value]) : value ?? '';
}

/** View mode toggle: traditional daily cards vs. multi-agent deep reports. */
type ViewMode = 'traditional' | 'multiagent';

/**
 * Analysis page component.
 */
function AnalysisPage() {
  const { t } = useTranslation();
  const [analyses, setAnalyses] = useState<AnalysisType[]>([]);
  const [dates, setDates] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [datesLoading, setDatesLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [currentDate, setCurrentDate] = useState<string>('');

  // Multi-Agent view state (deep reports list)
  const [viewMode, setViewMode] = useState<ViewMode>('multiagent');
  const [ratingFilter, setRatingFilter] = useState<string | null>(null);
  const [deepReports, setDeepReports] = useState<AgentRunWithRating[]>([]);
  const [deepReportsLoading, setDeepReportsLoading] = useState(false);


  useEffect(() => {
    void loadDates();
  }, []);

  useEffect(() => {
    if (currentDate) {
      void loadAnalysis(currentDate);
    }
  }, [currentDate]);

  useEffect(() => {
    setRatingFilter(null);
  }, [currentDate]);

  /** Load the list of dates that have analyses (newest first). */
  const loadDates = async () => {
    setDatesLoading(true);
    try {
      const data: string[] = await fetchAnalysisDates();
      const sorted = Array.isArray(data)
        ? [...data].sort((a, b) => b.localeCompare(a))
        : [];
      setDates(sorted);
      if (sorted.length > 0 && !currentDate) {
        setCurrentDate(sorted[0]);
      } else if (sorted.length === 0) {
        setLoading(false);
      }
    } catch {
      toast.error(t('ui.analysis.datesLoadFailed'));
      setLoading(false);
    } finally {
      setDatesLoading(false);
    }
  };

  /** Load all analysis cards for the given date. */
  const loadAnalysis = async (date: string) => {
    setLoading(true);
    setError(null);
    try {
      const data: AnalysisType[] = await fetchAnalysis(date);
      setAnalyses(Array.isArray(data) ? data : []);
    } catch {
      setError(t('ui.analysis.contentLoadFailed'));
      toast.error(t('ui.analysis.contentLoadFailed'));
    } finally {
      setLoading(false);
    }
  };

  /** Read saved server reports, including basic and AI runs. */
  const loadDeepReports = useCallback(async () => {
    setDeepReportsLoading(true);
    try {
      const data = await getAgentRuns({ limit: 100 });
      const items: AgentRunWithRating[] = data?.items ?? [];
      setDeepReports(items.filter(run => run.hasReport
        && (run.status === 'completed' || run.status === 'awaiting_human')));
    } catch {
      toast.error(t('ui.analysis.reportsLoadFailed'));
    } finally {
      setDeepReportsLoading(false);
    }
  }, [t]);

  useEffect(() => { void loadDeepReports(); }, [loadDeepReports]);
  const handleRunFinished = useCallback(() => { void loadDeepReports(); }, [loadDeepReports]);

  // Auto-refresh when page becomes visible or regains focus
  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState !== 'visible') return;
      void refreshAll();
    };
    const handleFocus = () => {
      void refreshAll();
    };

    const refreshAll = async () => {
      await loadDates();
      const effectiveDate = currentDate || dates[0];
      if (effectiveDate) {
        await Promise.all([
          loadAnalysis(effectiveDate),
          loadDeepReports(),
        ]);
      }
    };

    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('focus', handleFocus);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('focus', handleFocus);
    };
  }, [currentDate, dates, loadDeepReports]);

  const navigate = useNavigate();


  /** Navigate to the deep-report detail page for the given run id. */
  const handleDeepReportClick = (runId: string) => {
    navigate(`/analysis/deep-report/${runId}`);
  };

  const currentIndex = useMemo(
    () => dates.indexOf(currentDate),
    [dates, currentDate]
  );

  const prevDisabled = currentIndex >= dates.length - 1 || dates.length === 0;
  const nextDisabled = currentIndex <= 0 || dates.length === 0;

  /** Step back to the next-newer analysis date. */
  const goPrev = () => {
    if (currentIndex < dates.length - 1) {
      setCurrentDate(dates[currentIndex + 1]);
    }
  };

  /** Step forward to the next-older analysis date. */
  const goNext = () => {
    if (currentIndex > 0) {
      setCurrentDate(dates[currentIndex - 1]);
    }
  };

  // ticker -> deep report runId map for traditional view badges.
  // Suffixes like .HK / .US are stripped so display tickers match.
  const deepReportByTicker = useMemo(() => {
    const map = new Map<string, string>();
    const normalizeTicker = (t: string): string => t.replace(/\.(HK|US)$/i, '');
    for (const r of deepReports) {
      if (r.ticker && r.id && !map.has(normalizeTicker(r.ticker))) {
        map.set(normalizeTicker(r.ticker), r.id);
      }
    }
    return map;
  }, [deepReports]);

  /** Split analyses into stock-level cards and the special portfolio card. */
  const { stockAnalyses, portfolioAnalysis } = useMemo(() => {
    const stocks = analyses.filter(
      (a: AnalysisType) => a.ticker !== PORTFOLIO_TICKER
    );
    stocks.sort((a, b) => a.ticker.localeCompare(b.ticker));
    const portfolio = analyses.find(
      (a: AnalysisType) => a.ticker === PORTFOLIO_TICKER
    );
    return { stockAnalyses: stocks, portfolioAnalysis: portfolio ?? null };
  }, [analyses]);

  /** Build rating filter options with counts, in RATING_ORDER. */
  const ratingOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const a of stockAnalyses) {
      if (a.rating) {
        counts.set(a.rating, (counts.get(a.rating) ?? 0) + 1);
      }
    }
    return RATING_ORDER.filter((r: string) => counts.has(r)).map((r: string) => ({
      rating: r,
      count: counts.get(r) ?? 0,
    }));
  }, [stockAnalyses]);

  /** Apply the active rating filter to the stock analyses. */
  const filteredStockAnalyses = useMemo(
    () =>
      ratingFilter
        ? stockAnalyses.filter((a: AnalysisType) => a.rating === ratingFilter)
        : stockAnalyses,
    [stockAnalyses, ratingFilter]
  );

  if (datesLoading && !currentDate) {
    return <AnalysisSkeleton />;
  }

  return (
    <div className="flex flex-col gap-4 md:flex-row md:items-start md:gap-6">
      {/* Sidebar: date list */}
      <aside className="w-full shrink-0 md:w-48">
        <Card className="md:sticky md:top-4">
          <CardHeader className="p-4 pb-2">
            <CardTitle className="font-serif text-base">{t('ui.analysis.history')}</CardTitle>
          </CardHeader>
          <CardContent className="p-2">
            {datesLoading ? (
              <div className="space-y-2 p-2">
                {Array.from({ length: 5 }).map((_, i) => (
                  <Skeleton key={i} className="h-8 w-full" />
                ))}
              </div>
            ) : dates.length === 0 ? (
              <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                {t('ui.analysis.noHistory')}
              </div>
            ) : (
              <div className="max-h-[300px] space-y-0.5 overflow-y-auto md:max-h-[calc(100vh-200px)]">
                {dates.map((d) => (
                  <button
                    key={d}
                    onClick={() => { setCurrentDate(d); setViewMode('traditional'); }}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors',
                      d === currentDate
                        ? 'bg-primary/10 font-medium text-primary'
                        : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                    )}
                  >
                    <Calendar className="h-3.5 w-3.5 flex-shrink-0" />
                    <span className="font-mono-nums">{formatDate(d)}</span>
                  </button>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </aside>

      {/* Main content */}
      <div className="min-w-0 flex-1 space-y-4 md:space-y-6">
        {/* Date navigator */}
        <Card>
          <CardContent className="flex items-center justify-between p-4">
            <Tooltip>
              <TooltipTrigger asChild>
                <span tabIndex={0} className="inline-flex">
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={goPrev}
                    disabled={prevDisabled || viewMode !== 'traditional'}
                    aria-label={t('ui.analysis.prevDay')}
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </Button>
                </span>
              </TooltipTrigger>
              {prevDisabled && (
                <TooltipContent>
                  {datesLoading ? t('ui.analysis.loadingDates') : t('ui.analysis.earliestDate')}
                </TooltipContent>
              )}
            </Tooltip>
            <div className="text-center">
              <div className="font-serif text-xl font-semibold md:text-2xl">
                {viewMode === 'multiagent' ? t('analysisFlow.reports') : currentDate ? formatDate(currentDate) : t('ui.analysis.chooseDate')}
              </div>
              <div className="text-xs text-muted-foreground">
                {viewMode === 'traditional'
                  ? stockAnalyses.length > 0
                    ? t('ui.analysis.stockCount', { count: stockAnalyses.length })
                    : t('ui.analysis.noStocksToday')
                  : deepReports.length > 0
                    ? t('analysisFlow.reportCount', { count: deepReports.length })
                    : t('ui.analysis.noDeepReports')}
              </div>
            </div>
            <Tooltip>
              <TooltipTrigger asChild>
                <span tabIndex={0} className="inline-flex">
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={goNext}
                    disabled={nextDisabled || viewMode !== 'traditional'}
                    aria-label={t('ui.analysis.nextDay')}
                  >
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </span>
              </TooltipTrigger>
              {nextDisabled && (
                <TooltipContent>
                  {datesLoading ? t('ui.analysis.loadingDates') : t('ui.analysis.latestDate')}
                </TooltipContent>
              )}
            </Tooltip>
          </CardContent>
        </Card>

        <AnalysisRunner onFinished={handleRunFinished} />
        <Card className="border-primary/20 bg-primary/5">
          <CardContent className="flex flex-wrap items-center justify-between gap-4 p-4">
            <div className="min-w-0"><p className="text-sm font-semibold">{t('council.analysisEntry')}</p>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">{t('council.analysisHint')}</p></div>
            <Button asChild variant="outline" size="sm"><Link to="/council">{t('council.open')}<ArrowRight /></Link></Button>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex flex-wrap items-center justify-between gap-3 p-3">
            <p className="max-w-lg text-xs leading-relaxed text-muted-foreground">{t('analysisFlow.reportHint')}</p>
            <div
              role="tablist"
              className="inline-flex h-9 items-center justify-center rounded-lg bg-muted p-1 text-muted-foreground w-full sm:w-auto"
            >
              <button
                type="button"
                role="tab"
                aria-selected={viewMode === 'traditional'}
                data-state={viewMode === 'traditional' ? 'active' : 'inactive'}
                onClick={() => setViewMode('traditional')}
                className={cn(
                  'inline-flex items-center justify-center whitespace-nowrap rounded-md px-3 py-1 text-sm font-medium ring-offset-background transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 flex-1 sm:flex-none',
                  viewMode === 'traditional'
                    ? 'bg-background text-foreground shadow'
                    : ''
                )}
              >
                <LayoutGrid className="mr-1.5 h-3.5 w-3.5" />
                {t('ui.analysis.traditional')}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={viewMode === 'multiagent'}
                data-state={viewMode === 'multiagent' ? 'active' : 'inactive'}
                onClick={() => setViewMode('multiagent')}
                className={cn(
                  'inline-flex items-center justify-center whitespace-nowrap rounded-md px-3 py-1 text-sm font-medium ring-offset-background transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 flex-1 sm:flex-none',
                  viewMode === 'multiagent'
                    ? 'bg-background text-foreground shadow'
                    : ''
                )}
              >
                <Bot className="mr-1.5 h-3.5 w-3.5" />
                {t('analysisFlow.reports')}
              </button>
            </div>
          </CardContent>
        </Card>

        {viewMode === 'traditional' && (
          <div className="space-y-4 md:space-y-6">
            {/* Traditional view error */}
            {error && (
              <Card className="border-destructive/40">
                <CardContent className="flex items-center justify-between p-4">
                  <div className="flex items-center gap-2 text-destructive">
                    <AlertTriangle className="h-4 w-4" />
                    <span className="text-sm">{error}</span>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => currentDate && loadAnalysis(currentDate)}
                  >
                    {t('ui.analysis.retry')}
                  </Button>
                </CardContent>
              </Card>
            )}

            {/* Portfolio strategy review (special card) */}
            {!loading && portfolioAnalysis && (
              <AnalysisCard
                analysis={portfolioAnalysis}
                deepReportRunId={deepReportByTicker.get(PORTFOLIO_TICKER)}
              />
            )}

            {/* No portfolio placeholder */}
            {!loading &&
              !error &&
              !portfolioAnalysis &&
              stockAnalyses.length > 0 && (
                <Card className="border-dashed border-primary/30 bg-primary/[0.02]">
                  <CardContent className="flex items-center gap-3 p-4">
                    <Sparkles className="h-5 w-5 text-primary/60" />
                    <div>
                      <div className="text-sm font-medium text-foreground/80">
                        {t('ui.analysis.noPortfolioReview')}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {t('ui.analysis.noPortfolioReviewHint')}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              )}

            {/* Loading skeleton */}
            {loading && <AnalysisContentSkeleton />}

            {/* Stock analysis cards */}
            {!loading && !error && stockAnalyses.length > 0 && (
              <div className="space-y-4">
                <h2 className="font-serif text-lg font-semibold">
                  {t('ui.analysis.stocks')}
                  <span className="ml-2 text-sm font-normal text-muted-foreground">
                    {t('ui.analysis.stockUnit', { count: stockAnalyses.length })}
                  </span>
                </h2>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => setRatingFilter(null)}
                    className={cn(
                      'rounded-full px-3 py-1 text-xs transition-colors',
                      ratingFilter === null
                        ? 'bg-foreground text-background'
                        : 'bg-muted text-muted-foreground hover:text-foreground'
                    )}
                  >
                    {t('ui.analysis.all')}
                  </button>
                  {ratingOptions.map(({ rating, count }) => (
                    <button
                      key={rating}
                      type="button"
                      onClick={() =>
                        setRatingFilter(ratingFilter === rating ? null : rating)
                      }
                      className={cn(
                        'rounded-full px-3 py-1 text-xs transition-colors',
                        ratingFilter === rating
                          ? 'bg-foreground text-background'
                          : 'bg-muted text-muted-foreground hover:text-foreground'
                      )}
                    >
                      {localizedRating(rating, t)} ({count})
                    </button>
                  ))}
                </div>
                {filteredStockAnalyses.length > 0 ? (
                  <div className="grid gap-4 xl:grid-cols-2">
                    {filteredStockAnalyses.map((a: AnalysisType) => (
                      <AnalysisCard
                        key={a.id}
                        analysis={a}
                        deepReportRunId={deepReportByTicker.get(a.ticker)}
                      />
                    ))}
                  </div>
                ) : (
                  <Card>
                    <CardContent className="p-8">
                      <Empty>
                        <EmptyMedia variant="icon">
                          <BarChart3 className="h-5 w-5" />
                        </EmptyMedia>
                        <EmptyContent>
                          <EmptyTitle className="font-serif">
                            {t('ui.analysis.noRatingAnalysis')}
                          </EmptyTitle>
                          <EmptyDescription>
                            {t('ui.analysis.switchRatingHint')}
                          </EmptyDescription>
                        </EmptyContent>
                      </Empty>
                    </CardContent>
                  </Card>
                )}
              </div>
            )}

            {/* Empty state */}
            {!loading && !error && stockAnalyses.length === 0 && (
              <Card>
                <CardContent className="p-8">
                  <Empty>
                    <EmptyMedia variant="icon">
                      <BarChart3 className="h-5 w-5" />
                    </EmptyMedia>
                    <EmptyContent>
                      <EmptyTitle className="font-serif">
                        {t('ui.analysis.noAnalysisDate')}
                      </EmptyTitle>
                      <EmptyDescription>
                        {dates.length > 0
                          ? t('ui.analysis.chooseAnalysisDate')
                          : t('ui.analysis.systemNoAnalysis')}
                      </EmptyDescription>
                    </EmptyContent>
                  </Empty>
                </CardContent>
              </Card>
            )}
          </div>
        )}

        {viewMode === 'multiagent' && (
          <div className="space-y-3">
            <DeepReportListContent
              loading={deepReportsLoading}
              reports={deepReports}
              onReportClick={handleDeepReportClick}
              onRefresh={loadDeepReports}
            />
          </div>
        )}
      </div>

    </div>
  );
}

/** Full-page skeleton shown while the first date list loads. */
function AnalysisSkeleton() {
  return (
    <div className="flex flex-col gap-4 md:flex-row md:gap-6">
      <div className="w-full md:w-48">
        <Skeleton className="h-48 w-full" />
      </div>
      <div className="flex-1 space-y-4">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-32 w-full" />
        <div className="grid gap-4 md:grid-cols-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-48 w-full" />
          ))}
        </div>
      </div>
    </div>
  );
}

/** Props for {@link DeepReportListContent}. */
interface DeepReportListContentProps {
  loading: boolean;
  reports: AgentRunWithRating[];
  onReportClick: (runId: string) => void;
  onRefresh: () => void;
}

/** Render the deep-report list (loading, empty, or grid of cards). */
function DeepReportListContent({
  loading,
  reports,
  onReportClick,
  onRefresh,
}: DeepReportListContentProps) {
  const { t } = useTranslation();
  if (loading) {
    return (
      <div className="grid gap-4 xl:grid-cols-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i}>
            <CardContent className="space-y-3 p-5">
              <div className="flex items-center justify-between">
                <Skeleton className="h-5 w-24" />
                <Skeleton className="h-5 w-16" />
              </div>
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-3/4" />
              <div className="grid gap-2 pt-2 grid-cols-3">
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
              </div>
              <Skeleton className="h-8 w-32" />
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }

  if (reports.length === 0) {
    return (
      <Card>
        <CardContent className="p-8">
          <Empty>
            <EmptyMedia variant="icon">
              <Sparkles className="h-5 w-5 text-amber-500" />
            </EmptyMedia>
            <EmptyContent>
              <EmptyTitle className="font-serif">
                {t('ui.analysis.noReportsYet')}
              </EmptyTitle>
              <EmptyDescription>
                {t('analysisFlow.noTickers')}
              </EmptyDescription>
              <div className="mt-4">
                <Button variant="outline" size="sm" onClick={onRefresh}>
                  {t('ui.analysis.refresh')}
                </Button>
              </div>
            </EmptyContent>
          </Empty>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-amber-500" />
          <h2 className="font-serif text-lg font-semibold">
            {t('ui.analysis.reportList')}
          </h2>
          <Badge variant="secondary">{reports.length}</Badge>
        </div>
        <Button variant="outline" size="sm" onClick={onRefresh}>
          {t('ui.analysis.refresh')}
        </Button>
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        {reports.map((run: AgentRunWithRating) => (
          <DeepReportCard
            key={run.id}
            run={run}
            onClick={() => onReportClick(run.id)}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * Render a single deep-report card: ticker, name, rating/confidence badges,
 * bear/base/bull target prices, and completion timestamp.
 */
function DeepReportCard({
  run,
  onClick,
}: {
  run: AgentRunWithRating;
  onClick: () => void;
}) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const companyName = displayCompanyName(run.tickerName, run.ticker, i18n.language);
  const hasThreeTargets =
    run.targetBear != null || run.targetBase != null || run.targetBull != null;
  const ratingValue: string | null =
    run.rating == null
      ? null
      : typeof run.rating === 'string'
        ? run.rating
        : typeof (run.rating as unknown as Record<string, unknown>).rating === 'string'
          ? String((run.rating as unknown as Record<string, unknown>).rating)
          : null;

  const confidenceLabel = (c: string | null | undefined): string => {
    switch (c) {
      case 'high': return t('report.highConfidence');
      case 'medium': return t('report.mediumConfidence');
      case 'low': return t('report.lowConfidence');
      default: return t('ui.analysis.unknownConfidence');
    }
  };

  const confidenceColor = (c: string | null | undefined): string => {
    switch (c) {
      case 'high': return 'bg-success/15 text-success border-success/30';
      case 'medium': return 'bg-warning/15 text-warning border-warning/30';
      case 'low': return 'bg-destructive/15 text-destructive border-destructive/30';
      default: return 'bg-muted text-muted-foreground border-muted';
    }
  };

  const ratingBadgeColor = (r: string | null | undefined): string => {
    switch (r) {
      case 'Strong Buy': return 'bg-success/15 text-success';
      case 'Buy': return 'bg-success/10 text-success';
      case 'Hold': return 'bg-warning/15 text-warning';
      case 'Sell': return 'bg-destructive/10 text-destructive';
      case 'Strong Sell': return 'bg-destructive/20 text-destructive';
      default: return 'bg-muted text-muted-foreground';
    }
  };

  return (
    <Card
      onClick={onClick}
      className="cursor-pointer border-amber-500/40 bg-amber-500/[0.02] transition-all hover:border-amber-500/60 hover:bg-amber-500/[0.05] hover:shadow-md hover:-translate-y-0.5"
    >
      <CardContent className="space-y-3 p-4">
        {/* Header: ticker + name + rating */}
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2">
              <h3 className="font-mono-nums text-lg font-semibold tracking-tight">
                {run.ticker}
              </h3>
              {companyName && (
                <span className="truncate text-sm text-muted-foreground">
                  {companyName}
                </span>
              )}
            </div>
            <Badge
              variant="outline"
              className="mt-1.5 gap-1 border-amber-500/50 bg-amber-500/10 text-amber-700 dark:text-amber-400 font-medium"
            >
              <Sparkles size={12} />
              {t('analysisFlow.report')}
            </Badge>
          </div>
          {ratingValue && (
            <Badge
              variant="outline"
              data-testid="deep-report-rating-badge"
              className={cn('border-transparent shrink-0', ratingBadgeColor(ratingValue))}
            >
              {localizedRating(ratingValue, t)}
            </Badge>
          )}
        </div>

        {/* Confidence badge */}
        {run.confidence && (
          <Badge
            variant="outline"
            className={cn('border-transparent w-fit', confidenceColor(run.confidence))}
          >
            {confidenceLabel(run.confidence)}
          </Badge>
        )}

        {/* Target prices: three-scenario or single */}
        {hasThreeTargets ? (
          <div className="grid grid-cols-3 gap-2 text-center">
            <div className="rounded-md bg-muted/30 px-2 py-2">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                {t('report.bear')}
              </div>
              <div className="font-mono-nums text-sm font-semibold text-destructive">
                {run.targetBear ? `$${Number(run.targetBear).toFixed(2)}` : '—'}
              </div>
            </div>
            <div className="rounded-md bg-muted/30 px-2 py-2">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                {t('report.base')}
              </div>
              <div className="font-mono-nums text-sm font-semibold text-foreground">
                {run.targetBase ? `$${Number(run.targetBase).toFixed(2)}` : '—'}
              </div>
            </div>
            <div className="rounded-md bg-muted/30 px-2 py-2">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                {t('report.bull')}
              </div>
              <div className="font-mono-nums text-sm font-semibold text-success">
                {run.targetBull ? `$${Number(run.targetBull).toFixed(2)}` : '—'}
              </div>
            </div>
          </div>
        ) : null}

        {/* Footer: generated time + CTAs */}
        <div className="flex items-center justify-between pt-1 border-t border-border/50">
          <span className="text-xs text-muted-foreground font-mono-nums">
            {formatDateTime(run.completedAt)}
          </span>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                navigate(`/council?reportId=${run.id}`);
              }}
              className="flex items-center gap-0.5 rounded-md px-2 py-1 text-xs font-medium text-blue-600 hover:bg-blue-500/10 dark:text-blue-400"
            >
              <MessageSquare size={12} />
              {t('analysisFlow.discussReport')}
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                navigate('/paper');
              }}
              className="flex items-center gap-0.5 rounded-md px-2 py-1 text-xs font-medium text-emerald-600 hover:bg-emerald-500/10 dark:text-emerald-400"
            >
              <FlaskConical size={12} />
              {t('analysisFlow.paperTrade')}
            </button>
            <span className="flex items-center gap-0.5 text-xs font-medium text-amber-600 dark:text-amber-400">
              {t('analysisFlow.openReport')}
              <ArrowRight size={12} />
            </span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

/** Skeleton shown while the traditional analysis cards load. */
function AnalysisContentSkeleton() {
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      {Array.from({ length: 4 }).map((_, i) => (
        <Card key={i}>
          <CardContent className="space-y-3 p-5">
            <div className="flex items-center justify-between">
              <Skeleton className="h-5 w-20" />
              <Skeleton className="h-5 w-16" />
            </div>
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-5/6" />
            <Skeleton className="h-4 w-4/6" />
            <div className="grid gap-2 pt-2 sm:grid-cols-2">
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-20 w-full" />
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

export default AnalysisPage;
