import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, LoaderCircle } from 'lucide-react';
import { getPortfolioReportRun } from '@/api/portfolio-report';
import PortfolioReportContent from '@/components/MultiAgent/PortfolioReportContent';
import { isPortfolioReportActive } from '@/utils/portfolio-report';
import { Button } from '@/components/ui/button';

export default function PortfolioReportPage() {
  const { runId = '' } = useParams<{ runId: string }>();
  const { t } = useTranslation();
  const run = useQuery({
    queryKey: ['analysis', 'portfolio-run', runId],
    queryFn: () => getPortfolioReportRun(runId),
    enabled: Boolean(runId),
    refetchInterval: query => query.state.data && isPortfolioReportActive(query.state.data.status) ? 2500 : false,
  });

  return <div className="mx-auto max-w-6xl space-y-6 px-3 pb-16 pt-4 sm:px-6">
    <Button asChild variant="ghost" size="sm"><Link to="/analysis"><ArrowLeft className="mr-2 size-4" />{t('analysisFlow.portfolio.back')}</Link></Button>
    <header className="space-y-2">
      <h1 className="font-serif text-3xl font-semibold">{t('analysisFlow.portfolio.title')}</h1>
      <p className="text-sm text-muted-foreground">{t('analysisFlow.portfolio.description')}</p>
    </header>

    {run.isPending && <div role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />{t('ui.report.loadingDeepReport')}</div>}
    {run.isError && <div role="alert" className="rounded-lg border border-destructive/40 p-4 text-sm text-destructive">
      {t('analysisFlow.portfolio.loadFailed')} <Button variant="outline" size="sm" onClick={() => void run.refetch()}>{t('common.retry')}</Button>
    </div>}
    {run.data && <>
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-muted/30 p-4 text-sm">
        <strong>{t('analysisFlow.portfolio.status')}:</strong>
        <span>{t(`analysisFlow.portfolio.${run.data.status}`)}</span>
        {run.data.status === 'completed' && <span className="text-xs text-muted-foreground">
          {run.data.usageKnown && run.data.tokensUsed !== null
            ? t('analysisFlow.portfolio.tokensKnown', { count: run.data.tokensUsed })
            : t('analysisFlow.portfolio.tokensUnknown')}
        </span>}
        {isPortfolioReportActive(run.data.status) && <LoaderCircle className="size-4 animate-spin" />}
        {isPortfolioReportActive(run.data.status) && <>
          <span className="basis-full text-muted-foreground">{run.data.progress.message}</span>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-border" role="progressbar" aria-valuenow={run.data.progress.percent} aria-valuemin={0} aria-valuemax={100}>
            <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${run.data.progress.percent}%` }} />
          </div>
        </>}
        {run.data.errorMessage && <span className="basis-full text-destructive">{run.data.errorMessage}</span>}
      </div>
      {run.data.report ? <PortfolioReportContent report={run.data.report} snapshot={run.data.snapshot} t={t} />
        : !isPortfolioReportActive(run.data.status) && <p className="text-sm text-muted-foreground">{t('analysisFlow.portfolio.reportMissing')}</p>}
    </>}
  </div>;
}
