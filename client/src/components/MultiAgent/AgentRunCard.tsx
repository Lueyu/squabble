/**
 * AgentRunCard - compact summary card for one multi-agent analysis run, used in
 * the run list. Shows ticker, live pipeline status, rating/confidence once the
 * run completes, three-scenario target prices for "full" (deep) runs, bull/bear
 * summary lines, error message on failure, and a human-in-the-loop approval cue.
 */
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  TrendingUp,
  TrendingDown,
  FileText,
  Clock,
  AlertCircle,
  Sparkles,
  ChevronRight,
} from 'lucide-react';
import RatingBadge from './RatingBadge';
import ConfidenceBadge from './ConfidenceBadge';
import RunProgressBar from './RunProgressBar';
import RiskAlertBadge from './RiskAlertBadge';
import { useTranslation } from 'react-i18next';
import type { AgentRunWithRating, AgentRunStatus, RiskGateResult } from '@shared/api.interface';

interface AgentRunCardProps {
  /** The run record (with its rating, if any) to render */
  run: AgentRunWithRating;
  /** Optional risk-gate results, rendered as a RiskAlertBadge in the footer */
  riskGate?: RiskGateResult[];
  /** Optional number of evidence items gathered by the run */
  evidenceCount?: number;
  /** Callback when the card is clicked (opens the detail modal) */
  onClick?: () => void;
  /** Three-scenario target prices from deep report (optional) */
  targetBear?: string | null;
  targetBase?: string | null;
  targetBull?: string | null;
  confidence?: string | null;
}

/**
 * Tailwind outline-badge classes per pipeline status. Color encodes stage type:
 *   pending/cancelled  -> slate (idle)
 *   fetching           -> blue  (data collection)
 *   debating           -> purple (multi-agent argumentation)
 *   critiquing         -> amber (critic review)
 *   risk_check         -> rose  (risk gate)
 *   awaiting_human     -> amber-strong (needs human decision)
 *   completed          -> emerald
 *   failed             -> rose-strong
 */
const statusStyles: Record<AgentRunStatus, string> = {
  pending: 'bg-slate-500/15 text-slate-600 dark:text-slate-400 border-slate-500/30',
  fetching: 'bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30',
  debating: 'bg-purple-500/15 text-purple-600 dark:text-purple-400 border-purple-500/30',
  critiquing: 'bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30',
  risk_check: 'bg-rose-500/15 text-rose-600 dark:text-rose-400 border-rose-500/30',
  awaiting_human: 'bg-amber-500/20 text-amber-700 dark:text-amber-400 border-amber-500/40',
  completed: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30',
  failed: 'bg-rose-600/20 text-rose-700 dark:text-rose-400 border-rose-500/40',
  cancelled: 'bg-slate-500/15 text-slate-600 dark:text-slate-400 border-slate-500/30',
};

const statusLabelKeys: Record<AgentRunStatus, string> = {
  pending: 'agent.pending',
  fetching: 'agent.fetching',
  debating: 'agent.debating',
  critiquing: 'agent.critiquing',
  risk_check: 'agent.riskCheck',
  awaiting_human: 'agent.awaitingHuman',
  completed: 'agent.completed',
  failed: 'agent.failed',
  cancelled: 'agent.cancelled',
};

/**
 * Renders one run row. Sections are conditionally shown by run state:
 * in-progress runs get a live RunProgressBar; completed runs get rating +
 * bull/bear summaries; failed runs show the error; awaiting_human runs show an
 * approval call-to-action box.
 */
function AgentRunCard({
  run,
  riskGate,
  evidenceCount,
  onClick,
  targetBear,
  targetBase,
  targetBull,
}: AgentRunCardProps) {
  const { t, i18n } = useTranslation();
  const isAwaiting = run.status === 'awaiting_human';
  const isCompleted = run.status === 'completed';
  // Stages that still have a live (polling) progress bar shown on the card
  const isInProgress = ['fetching', 'debating', 'critiquing', 'risk_check'].includes(run.status);
  // 'full' runs produce the long-form deep report; quick runs do not
  const isDeep = run.runMode === 'full';
  const hasTargets = targetBear != null || targetBase != null || targetBull != null;

  return (
    <Card
      onClick={onClick}
      className={[
        'cursor-pointer transition-all hover:shadow-md hover:-translate-y-0.5',
        isAwaiting ? 'border-amber-500/50 ring-1 ring-amber-500/30' : '',
        isDeep
          ? 'border-amber-500/40 bg-amber-500/[0.03] hover:border-amber-500/60 hover:bg-amber-500/[0.05]'
          : '',
      ].join(' ')}
    >
      <div className="p-4 space-y-3">
        {/* Header: ticker + status */}
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-baseline gap-2">
              <h3 className="text-lg font-bold tracking-tight truncate">{run.ticker}</h3>
              {run.tickerName && (
                <span className="text-sm text-muted-foreground truncate">{run.tickerName}</span>
              )}
            </div>
            {isDeep && (
              <Badge
                variant="outline"
                className="mt-1.5 gap-1 border-amber-500/50 bg-amber-500/10 text-amber-700 dark:text-amber-400 font-medium"
              >
                <Sparkles size={12} />
                {t('report.deepReport')}
              </Badge>
            )}
          </div>
          <Badge variant="outline" className={`${statusStyles[run.status]} shrink-0 font-medium`}>
            {t(statusLabelKeys[run.status])}
          </Badge>
        </div>

        {/* Progress bar for in-progress statuses */}
        {isInProgress && (
          <div className="py-1">
            <RunProgressBar status={run.status} />
          </div>
        )}

        {/* Completed: rating + confidence */}
        {isCompleted && run.rating && (
          <div className="space-y-2">
            <div className="flex items-center gap-2 flex-wrap">
              <RatingBadge rating={run.rating.rating} />
              <ConfidenceBadge confidence={run.rating.confidence} />
              <Badge variant="secondary" className="font-medium">
                {run.rating.action}
              </Badge>
              {!isDeep && run.rating.targetPrice && (
                <Badge variant="outline" className="text-muted-foreground">
                  {t('report.targetPrice')} ${run.rating.targetPrice}
                </Badge>
              )}
            </div>

            {/* Deep analysis: three-scenario target prices */}
            {isDeep && hasTargets && (
              <div className="text-xs text-muted-foreground">
                {t('ui.agent.scenarioBear')}{' '}
                <span className="font-mono-nums text-rose-500">${targetBear ?? '—'}</span>
                {' / '}
                {t('ui.agent.scenarioBase')}{' '}
                <span className="font-mono-nums text-foreground">${targetBase ?? '—'}</span>
                {' / '}
                {t('ui.agent.scenarioBull')}{' '}
                <span className="font-mono-nums text-emerald-500">${targetBull ?? '—'}</span>
              </div>
            )}

            {/* Bull / bear summary */}
            {run.rating.bullSummary && (
              <div className="flex items-start gap-2 text-xs">
                <TrendingUp size={14} className="mt-0.5 shrink-0 text-emerald-500" />
                <span className="text-emerald-700 dark:text-emerald-400 line-clamp-1">
                  {run.rating.bullSummary}
                </span>
              </div>
            )}
            {run.rating.bearSummary && (
              <div className="flex items-start gap-2 text-xs">
                <TrendingDown size={14} className="mt-0.5 shrink-0 text-rose-500" />
                <span className="text-rose-700 dark:text-rose-400 line-clamp-1">
                  {run.rating.bearSummary}
                </span>
              </div>
            )}
          </div>
        )}

        {/* Failed status */}
        {run.status === 'failed' && run.errorMessage && (
          <div className="flex items-start gap-2 text-xs text-rose-600 dark:text-rose-400">
            <AlertCircle size={14} className="mt-0.5 shrink-0" />
            <span className="line-clamp-2">{run.errorMessage}</span>
          </div>
        )}

        {/* Awaiting human tag */}
        {isAwaiting && (
          <div className="rounded-md bg-amber-500/10 border border-amber-500/30 px-3 py-2">
            <div className="flex items-center gap-2 text-sm font-medium text-amber-700 dark:text-amber-400">
              <AlertCircle size={14} />
              {t('ui.agent.awaitingDecision')}
            </div>
            {run.rating && (
              <div className="mt-2 flex items-center gap-2 flex-wrap">
                <RatingBadge rating={run.rating.rating} size="sm" />
                <ConfidenceBadge confidence={run.rating.confidence} size="sm" />
              </div>
            )}
          </div>
        )}

        {/* Footer: metadata */}
        <div className="flex items-center gap-3 pt-1 text-xs text-muted-foreground flex-wrap">
          {evidenceCount !== undefined && (
            <div className="flex items-center gap-1">
              <FileText size={12} />
              <span>{t('ui.agent.evidenceCount', { count: evidenceCount })}</span>
            </div>
          )}
          <div className="flex items-center gap-1">
            <Clock size={12} />
            <span>{formatDate(run.createdAt, i18n.language)}</span>
          </div>
          {riskGate && riskGate.length > 0 && <RiskAlertBadge results={riskGate} />}
        </div>

        {/* Deep analysis CTA */}
        {isDeep && isCompleted && (
          <div className="flex items-center justify-end gap-0.5 pt-1 text-xs font-medium text-amber-600 dark:text-amber-400">
            {t('ui.agent.fullReport')}
            <ChevronRight size={12} />
          </div>
        )}
      </div>
    </Card>
  );
}

/**
 * Formats an ISO date string as a relative time ("just now", "5 min ago",
 * "3 days ago") and falls back to a short absolute date older than 7 days.
 */
function formatDate(dateStr: string, locale: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  const relativeTime = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  if (diffMins < 1) return relativeTime.format(0, 'minute');
  if (diffMins < 60) return relativeTime.format(-diffMins, 'minute');
  if (diffHours < 24) return relativeTime.format(-diffHours, 'hour');
  if (diffDays < 7) return relativeTime.format(-diffDays, 'day');
  return date.toLocaleDateString(locale, { month: 'short', day: 'numeric' });
}

/** Loading placeholder that mirrors AgentRunCard's layout while runs are being fetched */
export function AgentRunCardSkeleton() {
  const { t } = useTranslation();
  return (
    <Card className="p-4 space-y-3">
      <div className="flex items-start justify-between">
        <div className="space-y-2">
          <Skeleton className="h-5 w-20" />
          <Skeleton className="h-4 w-28" />
        </div>
        <Skeleton className="h-5 w-16" />
      </div>
      <Skeleton className="h-10 w-full" />
      <div className="flex gap-2">
        <Skeleton className="h-5 w-16" />
        <Skeleton className="h-5 w-20" />
      </div>
      <div className="flex items-center gap-3 pt-1">
        <Skeleton className="h-3 w-12" />
        <Skeleton className="h-3 w-20" />
        <Skeleton className="h-5 w-24" />
      </div>
    </Card>
  );
}

export default AgentRunCard;
