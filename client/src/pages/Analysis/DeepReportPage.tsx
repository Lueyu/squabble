/**
 * @file pages/Analysis/DeepReportPage.tsx
 * @description Route `/analysis/deep-report/:runId`: full-screen reader for a
 * versioned Multi-Agent deep research report.
 *
 * Fetches the report by run id and delegates rendering to the shared
 * `DeepReportView` component. Styled as a dark, immersive reader.
 */
import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Sparkles, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import type { DeepReport as DeepReportType } from '@shared/api.interface';
import { getDeepReport } from '@/api';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useTranslation } from 'react-i18next';
import DeepReportView from '@/components/MultiAgent/DeepReportView';
import ResearchSourceActions from './ResearchSourceActions';

/**
 * Deep report reader page.
 */
function DeepReportPage() {
  const { runId = '' } = useParams<{ runId: string }>();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [report, setReport] = useState<DeepReportType | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!runId) return;
    setLoading(true);
    setError(null);
    let cancelled = false;
    (async () => {
      try {
        const data = await getDeepReport(runId);
        if (cancelled) return;
        setReport(data);
      } catch (err: unknown) {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : t('ui.analysis.contentLoadFailed');
        setError(msg);
        toast.error(t('ui.report.loadDeepReportFailed'), { description: msg });
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [runId, t]);

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Top bar */}
      <div className="sticky top-0 z-20 border-b border-border bg-background/90 backdrop-blur-sm">
        <div className="flex items-center justify-end px-2 sm:px-4 py-3">
          {report && (
            <Badge
              variant="outline"
              className="gap-1 border-amber-500/50 bg-amber-500/10 text-amber-700 dark:text-amber-400 font-medium"
            >
              <Sparkles size={12} />
              {t(report.analysisTrace?.engine === 'basic' ? 'analysisFlow.basic' : 'analysisFlow.report')}
            </Badge>
          )}
        </div>
      </div>

      {/* Loading */}
      {loading && (
        <div className="flex items-center justify-center p-16 text-muted-foreground">
          <Loader2 className="mr-2 h-5 w-5 animate-spin" />
          {t('ui.report.loadingDeepReport')}
        </div>
      )}

      {/* Error */}
      {!loading && error && (
        <div className="p-8">
          <Empty>
            <EmptyMedia variant="icon">
              <Sparkles className="h-5 w-5" />
            </EmptyMedia>
            <EmptyContent>
              <EmptyTitle className="font-serif text-foreground">
                {t('ui.analysis.contentLoadFailed')}
              </EmptyTitle>
              <EmptyDescription className="text-muted-foreground">
                {error}
              </EmptyDescription>
              <div className="mt-4">
                <Button onClick={() => window.location.reload()}>{t('common.retry')}</Button>
              </div>
            </EmptyContent>
          </Empty>
        </div>
      )}

      {/* Empty */}
      {!loading && !error && !report && (
        <div className="p-8">
          <Empty>
            <EmptyMedia variant="icon">
              <Sparkles className="h-5 w-5" />
            </EmptyMedia>
            <EmptyContent>
              <EmptyTitle className="font-serif text-foreground">
                {t('ui.report.noDeepReport')}
              </EmptyTitle>
              <EmptyDescription className="text-muted-foreground">
                {t('ui.report.deepReportGeneratedAfterRun')}
              </EmptyDescription>
            </EmptyContent>
          </Empty>
        </div>
      )}

      {/* Report content */}
      {!loading && !error && report && (
        <div className="px-2 sm:px-4 pb-16">
          <ResearchSourceActions source={{ type: 'deep', id: report.id }} />
          <DeepReportView
            report={report}
            runId={runId}
            onBack={() => navigate(-1)}
          />
        </div>
      )}
    </div>
  );
}

export default DeepReportPage;
