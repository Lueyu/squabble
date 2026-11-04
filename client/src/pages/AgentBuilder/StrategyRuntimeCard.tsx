import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { CalendarClock, CircleAlert, Loader2, Radio } from 'lucide-react';
import type { BuilderProfile } from '@shared/api.interface';
import type { DailyStrategyPlan } from '@shared/strategy.interface';
import { fetchStrategyRuntime } from '@/api/builder';
import { Badge } from '@/components/ui/badge';
import { strategyDisplayState } from '@/utils/strategy-state';
import { memoryReason } from '@/utils/memory-reason';

export default function StrategyRuntimeCard({ profile }: { profile: BuilderProfile }) {
  const { t, i18n } = useTranslation();
  const [now, setNow] = useState(Date.now);
  const query = useQuery({ queryKey: ['builder', 'automation', profile.id, profile.version, profile.status],
    queryFn: () => fetchStrategyRuntime(profile.id), enabled: Boolean(profile.config.automation?.enabled),
    refetchInterval: profile.status === 'active' ? 15000 : false, retry: false });
  useEffect(() => {
    if (profile.status !== 'active') return;
    const timer = window.setInterval(() => setNow(Date.now()), 15000);
    return () => window.clearInterval(timer);
  }, [profile.status]);
  if (!profile.config.automation?.enabled) return null;
  const formatDate = (value: string | null) => value && Number.isFinite(Date.parse(value))
    ? new Date(value).toLocaleString(i18n.language, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : t('strategy.none');
  return <section className="space-y-3 rounded-xl border border-primary/20 bg-primary/5 p-3" aria-label={t('strategy.runtime')}>
    <h4 className="flex items-center gap-2 text-sm font-semibold"><Radio className="size-4 text-primary" />{t('strategy.runtime')}</h4>
    {query.isLoading && <p role="status" className="text-xs text-muted-foreground">{t('strategy.loading')}</p>}
    {query.isError && <p role="alert" className="flex gap-2 text-xs text-destructive"><CircleAlert className="size-4 shrink-0" />{t('strategy.unavailable')}</p>}
    {!query.isError && query.data?.markets.length === 0 && <p className="text-xs leading-5 text-muted-foreground">{t('strategy.empty')}</p>}
    {!query.isError && query.data?.markets.map((market) => {
      const state = strategyDisplayState(profile, market, query.data!.profileVersion, now);
      return <article key={market.market} className="space-y-3 rounded-lg bg-card p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-sm font-medium">{market.market} · {market.marketDate ?? t('strategy.none')}</span>
          <Badge variant={['blocked', 'offline', 'outdated'].includes(state) ? 'destructive' : 'secondary'}>
            {state === 'discussing' && <Loader2 className="mr-1 size-3 animate-spin" />}{t(`strategy.states.${state}`)}</Badge>
        </div>
        <dl className="grid gap-2 text-xs sm:grid-cols-2">
          <div><dt className="text-muted-foreground">{t('strategy.nextDiscussion')}</dt><dd className="mt-1">{formatDate(market.nextDiscussionAt)}</dd></div>
          <div><dt className="text-muted-foreground">{t('strategy.lastCheck')}</dt><dd className="mt-1">{formatDate(market.lastCheckAt)}</dd></div>
          <div><dt className="text-muted-foreground">{t('strategy.lastQuote')}</dt><dd className="mt-1">{formatDate(market.lastQuoteAt)}</dd></div>
        </dl>
        {market.reason && <p className="whitespace-pre-wrap break-words text-xs leading-5 text-muted-foreground">{memoryReason(market.reason, i18n.language)}</p>}
        {market.currentPlan ? <PlanDetails plan={market.currentPlan} formatDate={formatDate} />
          : <p className="text-xs leading-5 text-muted-foreground">{t('strategy.empty')}</p>}
      </article>;
    })}
    {!query.isError && query.data && <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
      <span>{t('strategy.notificationsPending', { count: query.data.notification.pending })}</span>
      {query.data.notification.failed > 0 && <span className="text-destructive">{t('strategy.notificationsFailed', { count: query.data.notification.failed })}</span>}
      <span>{t('strategy.lastNotification')}：{formatDate(query.data.notification.lastDeliveredAt)}</span>
    </div>}
    <p className="text-xs leading-5 text-muted-foreground">{t('strategy.runtimeHint')}</p>
  </section>;
}

function PlanDetails({ plan, formatDate }: { plan: DailyStrategyPlan; formatDate: (value: string | null) => string }) {
  const { t, i18n } = useTranslation();
  const zh = i18n.language.startsWith('zh');
  const inventory = plan.memoryInventory;
  const inventoryReason = inventory?.reason ?? (inventory?.state === 'archive-pending' ? 'MEMORY_ARCHIVE_PENDING'
    : inventory?.state === 'archive-failed' ? 'MEMORY_ARCHIVE_FAILED' : inventory?.state === 'archive-disabled' ? 'MEMORY_ARCHIVE_DISABLED'
      : inventory?.state === 'unknown' || !inventory ? 'MEMORY_SUBMISSION_UNKNOWN' : null);
  return <div className="space-y-2 border-t border-border pt-3 text-xs">
    <p className="flex items-center gap-1.5 font-semibold"><CalendarClock className="size-3.5" />{t('strategy.plan')} · {t('strategy.version', { version: plan.version })}</p>
    <p className="whitespace-pre-wrap break-words leading-6">{plan.summary}</p>
    <p className="text-muted-foreground">{t('strategy.expires')}：{formatDate(plan.expiresAt)}</p>
    <details className="[overflow-wrap:anywhere]"><summary className="cursor-pointer">{zh ? '论点依赖' : 'Thesis dependencies'} · {inventory?.state === 'ready'
      ? inventory.dependencies.length : inventory?.state === 'legacy-no-structure' ? zh ? '历史报告未提供结构' : 'Legacy report has no structure' : zh ? '待核验' : 'Not yet verified'}</summary>
      {inventoryReason && <p>{memoryReason(inventoryReason, i18n.language)}</p>}
      {inventory?.dependencies.map(dependency => <p key={`${dependency.thesisId}:${dependency.version}`}>
        {dependency.ticker} · v{dependency.version} · {dependency.origin === 'current-report' ? zh ? '当前报告' : 'Current report'
          : dependency.origin === 'recalled-memory' ? zh ? '已提交的历史记忆' : 'Submitted recalled memory' : zh ? '上一策略保留的依赖' : 'Dependency retained from the previous plan'}
        <span className="block text-muted-foreground">{dependency.thesisId}</span></p>)}
    </details>
    {plan.rules.length === 0 ? <p className="text-muted-foreground">{t('strategy.noRules')}</p> : <details>
      <summary className="cursor-pointer py-1 font-medium text-primary">{t('strategy.rules', { count: plan.rules.length })}</summary>
      <ul className="mt-2 space-y-3">{plan.rules.map((rule) => <li key={rule.id} className="space-y-1.5 rounded-lg border border-border p-2.5 leading-5">
        <p className="font-semibold">{rule.ticker} · {t(`strategy.${rule.side}`)}</p>
        <p>{t(`strategy.triggers.${rule.trigger.kind}`)} {rule.trigger.value}</p>
        <p>{t('strategy.range')}：{rule.minPrice} – {rule.maxPrice}</p>
        <p>{t('strategy.positionCap')}：{rule.maxPositionPct}% · {t('strategy.stop')}：{rule.stopLossPrice}</p>
        <p className="break-words text-muted-foreground">{rule.rationale}</p>
      </li>)}</ul>
    </details>}
    <div className="flex flex-wrap gap-3">{plan.sessionIds.map((id, index) => <Link key={id}
      className="text-primary hover:underline" to={`/council?session=${encodeURIComponent(id)}`}>{t('strategy.sources')} {index + 1}</Link>)}</div>
  </div>;
}
