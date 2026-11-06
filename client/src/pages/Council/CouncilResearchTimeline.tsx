import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, CircleAlert, Clock3, Loader2, MinusCircle } from 'lucide-react';
import type { ResearchEventStatus } from '@shared/research-events.interface';
import { researchIsActive, researchSourceUrl,
  type ResearchActivityView, type ResearchTaskView } from '@/utils/research-events';

const RESEARCH_TOOL_NAMES = new Set(['get_quotes', 'get_financials', 'get_valuation', 'get_news',
  'get_research_report', 'get_discussion_context', 'search_research_web']);

function ActivityIcon({ status }: { status: ResearchEventStatus }) {
  const className = 'mt-0.5 size-3.5 shrink-0';
  if (status === 'running') return <Loader2 aria-hidden className={`${className} animate-spin text-primary`} />;
  if (status === 'queued') return <Clock3 aria-hidden className={`${className} text-muted-foreground`} />;
  if (status === 'succeeded') return <CheckCircle2 aria-hidden className={`${className} text-success`} />;
  if (status === 'failed' || status === 'unavailable' || status === 'interrupted') return <CircleAlert aria-hidden className={`${className} text-destructive`} />;
  return <MinusCircle aria-hidden className={`${className} text-muted-foreground`} />;
}

function ActivityRow({ activity, now, grouped = [] }: { activity: ResearchActivityView; now: number; grouped?: ResearchActivityView[] }) {
  const { t, i18n } = useTranslation();
  const observation = activity.kind === 'summary';
  const elapsed = activity.kind === 'tool'
    ? activity.durationMs ?? (researchIsActive(activity.status) ? now - Date.parse(activity.startedAt) : undefined) : undefined;
  const label = activity.toolName && RESEARCH_TOOL_NAMES.has(activity.toolName)
    ? t(`council.progress.toolNames.${activity.toolName}`) : activity.toolName || t(`council.progress.activityKinds.${activity.kind}`);
  return <li className="flex min-w-0 items-start gap-2 text-xs leading-5">
    {observation ? <Clock3 aria-hidden className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" /> : <ActivityIcon status={activity.status} />}
    <div className="min-w-0 flex-1 [overflow-wrap:anywhere]">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <span className="font-medium">{label}</span>
        {grouped.length > 1 && <span className="rounded-full bg-muted px-1.5 font-medium">× {grouped.length}</span>}
        {!observation && <span className="text-muted-foreground">{t(`council.progress.taskStates.${activity.status}`)}</span>}
        <time className="text-muted-foreground" dateTime={activity.at}>
          {new Date(activity.at).toLocaleTimeString(i18n.language, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time>
        {Number.isFinite(elapsed) && <span className="tabular-nums text-muted-foreground">
          {t('council.progress.duration', { seconds: Math.max(0, Math.floor(elapsed! / 1000)) })}</span>}
      </div>
      <p className="whitespace-pre-wrap text-muted-foreground">{activity.summary}</p>
      {grouped.length > 1 && <details className="mt-1 text-muted-foreground"><summary className="cursor-pointer">{i18n.language.startsWith('zh') ? '展开每次活动' : 'Show each activity'}</summary><ul className="mt-2 space-y-2 border-l pl-3">{grouped.map(item => <li key={item.key}><time dateTime={item.at}>{new Date(item.at).toLocaleTimeString(i18n.language, { hour: '2-digit', minute: '2-digit' })}</time><p className="whitespace-pre-wrap">{item.summary}</p></li>)}</ul></details>}
      {Boolean(activity.sources?.length) && <details className="mt-1">
        <summary className="cursor-pointer text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">
          {t('council.chat.sources', { count: activity.sources!.length })}</summary>
        <ul className="mt-1 space-y-1 border-l border-border pl-3">
          {activity.sources?.map((source, index) => {
            const url = researchSourceUrl(source.url);
            return <li key={`${source.url ?? source.title}:${index}`}>
              {url ? <a href={url} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">{source.title}</a> : source.title}
              {source.fetchedAt && <span className="ml-2 text-muted-foreground">{t('council.progress.sourceAsOf', { at: source.fetchedAt })}</span>}
            </li>;
          })}
        </ul>
      </details>}
    </div>
  </li>;
}

/** Kept inside the turn card so disclosure state survives arrival of the final reply. */
export default function CouncilResearchTimeline({ task }: { task: ResearchTaskView }) {
  const { t } = useTranslation();
  const [now, setNow] = useState(Date.now);
  const active = researchIsActive(task.status);
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  const elapsed = task.durationMs ?? (active ? now - Date.parse(task.startedAt) : undefined);
  const needsAttention = ['failed', 'interrupted', 'unavailable', 'cancelled'].includes(task.status);
  const sourceGaps = task.activities.filter(activity => activity.kind === 'tool'
    && ['failed', 'interrupted', 'unavailable', 'cancelled'].includes(activity.status)).length;
  const groups: ResearchActivityView[][] = [];
  for (const activity of task.activities) {
    const previous = groups.at(-1);
    if (previous && activity.kind === 'tool' && previous[0].kind === 'tool'
      && activity.toolName === previous[0].toolName && activity.status === previous[0].status) previous.push(activity);
    else groups.push([activity]);
  }
  return <details className={`min-w-0 text-xs ${needsAttention ? 'text-destructive' : 'text-muted-foreground'}`}>
    <summary className="cursor-pointer rounded-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">
      <span className="inline-flex max-w-[calc(100%-1rem)] items-center gap-2 align-middle leading-5">
        <ActivityIcon status={task.status} />
        <span className="min-w-0 truncate font-medium">{t(active ? 'council.progress.researching' : 'council.progress.history')}</span>
        <span role="status" className="shrink-0">{t(`council.progress.taskStates.${task.status}`)}</span>
        {sourceGaps > 0 && <span className="shrink-0 font-medium text-destructive">{t('council.progress.sourceGaps', { count: sourceGaps })}</span>}
        {Number.isFinite(elapsed) && <span className={`${sourceGaps ? 'hidden sm:inline' : ''} shrink-0 tabular-nums`}>{t('council.progress.duration', { seconds: Math.max(0, Math.floor(elapsed! / 1000)) })}</span>}
        {task.sourceCount > 0 && <span className="min-w-0 truncate">{t('council.chat.sources', { count: task.sourceCount })}</span>}
      </span>
    </summary>
    <div className="mt-3 space-y-3 border-t border-border/70 pt-3">
      {task.summary && <p className="whitespace-pre-wrap leading-6 [overflow-wrap:anywhere]">{task.summary}</p>}
      <ol className="space-y-3 text-foreground">{groups.map(group => <ActivityRow key={group[0].key} activity={{ ...group[group.length - 1], sources: group.flatMap(item => item.sources || []) }} now={now} grouped={group} />)}</ol>
      {task.truncated && <p className="leading-5 text-muted-foreground">{t('council.progress.truncated')}</p>}
    </div>
  </details>;
}
