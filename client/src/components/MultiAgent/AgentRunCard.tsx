/**
 * @file components/MultiAgent/AgentRunCard.tsx
 * @description 多 agent 分析单次 run 的紧凑摘要卡片，用于 run 列表。
 * 展示：ticker、实时流水线状态、完成后的评级/置信度、"full"（深度）run 的
 * 三情景目标价、多空摘要行、失败时的错误信息，以及 human-in-the-loop 审批提示。
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
  /** 要渲染的 run 记录（含其评级，如有） */
  run: AgentRunWithRating;
  /** 可选的风控闸门结果，在页脚渲染为 RiskAlertBadge */
  riskGate?: RiskGateResult[];
  /** 可选：本次 run 收集的证据条数 */
  evidenceCount?: number;
  /** 卡片被点击时的回调（打开详情弹窗） */
  onClick?: () => void;
  /** 深度报告的三情景目标价（可选） */
  targetBear?: string | null;
  targetBase?: string | null;
  targetBull?: string | null;
  confidence?: string | null;
}

/**
 * 各流水线状态对应的 Tailwind outline 徽章 class。颜色编码阶段类型：
 *   pending/cancelled  -> slate（空闲）
 *   fetching           -> 蓝（数据采集）
 *   debating           -> 紫（多 agent 论辩）
 *   critiquing         -> 琥珀（批评者复核）
 *   risk_check         -> 玫瑰红（风控闸门）
 *   awaiting_human     -> 琥珀加重（等待人工决策）
 *   completed          -> 翡翠绿
 *   failed             -> 玫瑰红加重
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

/** 各流水线状态对应的 i18n 文案 key。 */
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
 * 渲染一条 run 记录。各区块按 run 状态条件展示：
 * 进行中的 run 显示实时 RunProgressBar；完成的 run 显示评级 + 多空摘要；
 * 失败的 run 显示错误信息；awaiting_human 的 run 显示审批操作提示框。
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
  // 卡片上仍显示实时（轮询）进度条的进行中阶段
  const isInProgress = ['fetching', 'debating', 'critiquing', 'risk_check'].includes(run.status);
  // 'full' run 产出长篇深度报告；quick run 不产出
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
        {/* 头部：ticker + 状态 */}
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

        {/* 进行中状态的进度条 */}
        {isInProgress && (
          <div className="py-1">
            <RunProgressBar status={run.status} />
          </div>
        )}

        {/* 已完成：评级 + 置信度 */}
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

            {/* 深度分析：三情景目标价 */}
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

            {/* 多 / 空摘要 */}
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

        {/* 失败状态 */}
        {run.status === 'failed' && run.errorMessage && (
          <div className="flex items-start gap-2 text-xs text-rose-600 dark:text-rose-400">
            <AlertCircle size={14} className="mt-0.5 shrink-0" />
            <span className="line-clamp-2">{run.errorMessage}</span>
          </div>
        )}

        {/* 等待人工决策提示 */}
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

        {/* 页脚：元数据 */}
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

        {/* 深度分析入口提示 */}
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
 * 把 ISO 日期字符串格式化为相对时间（"刚刚"、"5 分钟前"、"3 天前"），
 * 超过 7 天时回退为短格式绝对日期。
 */
function formatDate(dateStr: string, locale: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  // 预先换算分钟/小时/天三档时间差，供下方逐档判断使用。
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  // 7 天内用相对时间格式；超出则回退为"月 日"短格式。
  const relativeTime = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  if (diffMins < 1) return relativeTime.format(0, 'minute');
  if (diffMins < 60) return relativeTime.format(-diffMins, 'minute');
  if (diffHours < 24) return relativeTime.format(-diffHours, 'hour');
  if (diffDays < 7) return relativeTime.format(-diffDays, 'day');
  return date.toLocaleDateString(locale, { month: 'short', day: 'numeric' });
}

/** run 列表加载中时，与 AgentRunCard 布局一致的加载占位卡片 */
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
