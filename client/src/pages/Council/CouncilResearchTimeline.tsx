import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, CircleAlert, Clock3, Loader2, MinusCircle } from 'lucide-react';
import type { CouncilSession } from '@shared/council.interface';
import type { ResearchEventStatus } from '@shared/research-events.interface';
import { researchIsActive, researchSourceUrl, researchTimeline,
  type ResearchActivityView, type ResearchTaskView } from '@/utils/research-events';

const VISIBLE_ACTIVITIES = 6;
const VISIBLE_TASKS = 4;
const RESEARCH_TOOL_NAMES = new Set(['get_quotes', 'get_financials', 'get_valuation', 'get_news',
  'get_research_report', 'get_discussion_context', 'search_research_web']);

function ActivityIcon({ status }: { status: ResearchEventStatus }) {
  const className = 'mt-0.5 size-3.5 shrink-0';
  if (status === 'running') return <Loader2 aria-hidden className={`${className} animate-spin text-primary`} />;
  if (status === 'queued') return <Clock3 aria-hidden className={`${className} text-muted-foreground`} />;
  if (status === 'succeeded') return <CheckCircle2 aria-hidden className={`${className} text-success`} />;
  if (status === 'failed' || status === 'unavailable') return <CircleAlert aria-hidden className={`${className} text-destructive`} />;
  return <MinusCircle aria-hidden className={`${className} text-muted-foreground`} />;
}

function ActivityRow({ activity, now }: { activity: ResearchActivityView; now: number }) {
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
        {!observation && <span className="text-muted-foreground">{t(`council.progress.taskStates.${activity.status}`)}</span>}
        <time className="text-muted-foreground" dateTime={activity.at}>
          {new Date(activity.at).toLocaleTimeString(i18n.language, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time>
        {Number.isFinite(elapsed) && <span className="tabular-nums text-muted-foreground">
          {t('council.progress.duration', { seconds: Math.max(0, Math.floor(elapsed! / 1000)) })}</span>}
      </div>
      <p className="whitespace-pre-wrap text-muted-foreground">{activity.summary}</p>
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

function TaskCard({ task, session, now }: { task: ResearchTaskView; session: CouncilSession; now: number }) {
  const { t } = useTranslation();
  const member = session.members?.find(item => item.id === task.memberId);
  const older = task.activities.slice(0, -VISIBLE_ACTIVITIES);
  const elapsed = task.durationMs ?? (researchIsActive(task.status) ? now - Date.parse(task.startedAt) : undefined);
  return <article aria-label={`${task.memberName} · ${t('council.progress.taskTurn', { turn: task.turn + 1 })}`}
    className="min-w-0 rounded-2xl rounded-tl-sm border border-primary/20 bg-card px-3 py-3 shadow-sm sm:px-4">
    <div className="flex items-start gap-2 text-xs leading-5">
      <ActivityIcon status={task.status} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 [overflow-wrap:anywhere]">
          <span className="font-semibold">{task.memberName}</span>
          {member && <span className="text-muted-foreground">{member.roleTitle || t(`council.roles.${member.role}`)}</span>}
          <span className="text-muted-foreground">{t('council.progress.taskTurn', { turn: task.turn + 1 })}</span>
          {task.isStale && <span className="text-muted-foreground">{t('council.progress.previousRevision', { revision: task.revision })}</span>}
        </div>
        <p className="flex flex-wrap gap-x-3 gap-y-0.5 text-muted-foreground">
          <span role="status">{t(`council.progress.taskStates.${task.status}`)}</span>
          {Number.isFinite(elapsed) && <span className="tabular-nums">{t('council.progress.duration', { seconds: Math.max(0, Math.floor(elapsed! / 1000)) })}</span>}
          {task.sourceCount > 0 && <span>{t('council.chat.sources', { count: task.sourceCount })}</span>}
        </p>
        {task.summary && <p className="mt-1 whitespace-pre-wrap text-muted-foreground [overflow-wrap:anywhere]">{task.summary}</p>}
      </div>
    </div>
    {task.activities.length > 0 && <div className="mt-3 space-y-2 border-t border-border/70 pt-3">
      {older.length > 0 && <details className="text-xs">
        <summary className="mb-2 cursor-pointer text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">
          {t('council.progress.olderActivities', { count: older.length })}</summary>
        <ol className="mb-3 space-y-3">{older.map(activity => <ActivityRow key={activity.key} activity={activity} now={now} />)}</ol>
      </details>}
      <ol className="space-y-3">{task.activities.slice(-VISIBLE_ACTIVITIES).map(activity => <ActivityRow key={activity.key} activity={activity} now={now} />)}</ol>
    </div>}
    {task.replyMessageId && <button type="button" className="mt-2 text-xs text-primary underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
      onClick={() => {
        const target = document.getElementById(`council-message-${task.replyMessageId}`);
        target?.scrollIntoView({ block: 'center', behavior: 'smooth' }); target?.focus({ preventScroll: true });
      }}>{t('council.progress.viewReply')}</button>}
  </article>;
}

export default function CouncilResearchTimeline({ session }: { session: CouncilSession }) {
  const { t } = useTranslation();
  const [now, setNow] = useState(Date.now);
  const timeline = researchTimeline(session);
  const current = timeline.tasks.filter(task => !task.isStale);
  const previous = timeline.tasks.filter(task => task.isStale);
  const active = current.some(task => researchIsActive(task.status));
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  const cards = (tasks: ResearchTaskView[]) => tasks.map(task => <TaskCard key={task.key} task={task} session={session} now={now} />);
  return <section aria-label={t('council.progress.history')} className="w-full min-w-0 space-y-3 sm:max-w-[88%]">
    <h3 className="text-xs font-medium text-muted-foreground">{t('council.progress.history')}</h3>
    {previous.length > 0 && <details className="text-xs">
      <summary className="cursor-pointer text-muted-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">
        {t('council.progress.previousRevisions', { count: previous.length })}</summary>
      <div className="mt-3 space-y-3">{cards(previous)}</div>
    </details>}
    {current.length > VISIBLE_TASKS && <details className="text-xs">
      <summary className="cursor-pointer text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">
        {t('council.progress.olderTasks', { count: current.length - VISIBLE_TASKS })}</summary>
      <div className="mt-3 space-y-3">{cards(current.slice(0, -VISIBLE_TASKS))}</div>
    </details>}
    {cards(current.slice(-VISIBLE_TASKS))}
    {timeline.truncated && <p className="text-xs leading-5 text-muted-foreground">{t('council.progress.truncated')}</p>}
  </section>;
}
