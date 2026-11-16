/**
 * CouncilResearchTimeline.tsx — 研究事件时间线：按任务分卡的只读研究过程展示。
 *
 * 职责边界：
 *  - 把 session.researchEvents 经 researchTimeline() 归整为任务（TaskCard）与活动（ActivityRow）
 *    两级视图；每个任务对应"某成员×某轮次"的研究过程；
 *  - 运行中的任务每秒刷新一次 now 用于计算进行中耗时；非活动任务不启定时器；
 *  - 旧修订任务折叠（previousRevisions）、超量任务折叠（olderTasks），
 *    每卡只展开最近 6 条活动、更早的折叠进 olderActivities。
 * 上下游：
 *  - 上游（路由入口/谁引用）：CouncilResearchProgress。
 *  - 下游（调用哪些 hooks/api/组件）：@/utils/research-events 的 researchTimeline /
 *    researchIsActive / researchSourceUrl；lucide 图标。
 * 关键约定：
 *  - VISIBLE_ACTIVITIES=6（每卡展开的活动数）、VISIBLE_TASKS=4（尾部展开的任务数）；
 *  - RESEARCH_TOOL_NAMES 是七个内置研究工具名，命中则用译名，否则用原始工具名
 *    （非工具活动走 activityKinds 译名）；
 *  - 耗时优先用服务端 durationMs，运行中用 now-startedAt 兜底；
 *  - "查看回复"按钮滚动到 council-message-<replyMessageId> 并聚焦（不滚动视口）。
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, CircleAlert, Clock3, Loader2, MinusCircle } from 'lucide-react';
import type { CouncilSession } from '@shared/council.interface';
import type { ResearchEventStatus } from '@shared/research-events.interface';
import {
  researchIsActive,
  researchSourceUrl,
  researchTimeline,
  type ResearchActivityView,
  type ResearchTaskView,
} from '@/utils/research-events';

// 每张任务卡默认展开的活动条数；主列表默认展开的任务卡数
const VISIBLE_ACTIVITIES = 6;
const VISIBLE_TASKS = 4;
// 内置研究工具名集合（命中则显示本地化工具名）
const RESEARCH_TOOL_NAMES = new Set([
  'get_quotes',
  'get_financials',
  'get_valuation',
  'get_news',
  'get_research_report',
  'get_discussion_context',
  'search_research_web',
]);

/** 活动状态图标：running 转圈 / queued 时钟 / succeeded 勾 / failed·unavailable 警示 / 其余减号。 */
function ActivityIcon({ status }: { status: ResearchEventStatus }) {
  const className = 'mt-0.5 size-3.5 shrink-0';
  if (status === 'running')
    return <Loader2 aria-hidden className={`${className} animate-spin text-primary`} />;
  if (status === 'queued')
    return <Clock3 aria-hidden className={`${className} text-muted-foreground`} />;
  if (status === 'succeeded')
    return <CheckCircle2 aria-hidden className={`${className} text-success`} />;
  if (status === 'failed' || status === 'unavailable')
    return <CircleAlert aria-hidden className={`${className} text-destructive`} />;
  return <MinusCircle aria-hidden className={`${className} text-muted-foreground`} />;
}

/** 单条活动行：图标 + 工具名/状态 + 时间 + 耗时 + 摘要 + 可折叠来源列表。 */
function ActivityRow({ activity, now }: { activity: ResearchActivityView; now: number }) {
  const { t, i18n } = useTranslation();
  // summary 类活动是观察记录（无状态徽标，恒用时钟图标）
  const observation = activity.kind === 'summary';
  // 耗时：工具类活动优先服务端 durationMs，运行中则用 now-startedAt 现算
  const elapsed =
    activity.kind === 'tool'
      ? (activity.durationMs ??
        (researchIsActive(activity.status) ? now - Date.parse(activity.startedAt) : undefined))
      : undefined;
  // 标签：内置工具→译名；其他工具→原名；非工具活动→活动类型译名
  const label =
    activity.toolName && RESEARCH_TOOL_NAMES.has(activity.toolName)
      ? t(`council.progress.toolNames.${activity.toolName}`)
      : activity.toolName || t(`council.progress.activityKinds.${activity.kind}`);
  return (
    <li className="flex min-w-0 items-start gap-2 text-xs leading-5">
      {observation ? (
        <Clock3 aria-hidden className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
      ) : (
        <ActivityIcon status={activity.status} />
      )}
      <div className="min-w-0 flex-1 [overflow-wrap:anywhere]">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="font-medium">{label}</span>
          {/* 什么时候走到这里：非 summary 活动——追加状态徽标文字 */}
          {!observation && (
            <span className="text-muted-foreground">
              {t(`council.progress.taskStates.${activity.status}`)}
            </span>
          )}
          <time className="text-muted-foreground" dateTime={activity.at}>
            {new Date(activity.at).toLocaleTimeString(i18n.language, {
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit',
            })}
          </time>
          {/* 什么时候走到这里：能算出耗时（秒）——展示持续时间 */}
          {Number.isFinite(elapsed) && (
            <span className="tabular-nums text-muted-foreground">
              {t('council.progress.duration', {
                seconds: Math.max(0, Math.floor(elapsed! / 1000)),
              })}
            </span>
          )}
        </div>
        <p className="whitespace-pre-wrap text-muted-foreground">{activity.summary}</p>
        {/* 什么时候走到这里：活动带有来源列表——折叠展开逐条展示（有 URL 才是链接） */}
        {Boolean(activity.sources?.length) && (
          <details className="mt-1">
            <summary className="cursor-pointer text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">
              {t('council.chat.sources', { count: activity.sources!.length })}
            </summary>
            <ul className="mt-1 space-y-1 border-l border-border pl-3">
              {activity.sources?.map((source, index) => {
                const url = researchSourceUrl(source.url);
                return (
                  <li key={`${source.url ?? source.title}:${index}`}>
                    {url ? (
                      <a
                        href={url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-primary hover:underline"
                      >
                        {source.title}
                      </a>
                    ) : (
                      source.title
                    )}
                    {source.fetchedAt && (
                      <span className="ml-2 text-muted-foreground">
                        {t('council.progress.sourceAsOf', { at: source.fetchedAt })}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          </details>
        )}
      </div>
    </li>
  );
}

/** 任务卡：一个成员一轮研究的聚合视图——头部状态/耗时/来源数 + 活动列表 + 查看回复跳转。 */
function TaskCard({
  task,
  session,
  now,
}: {
  task: ResearchTaskView;
  session: CouncilSession;
  now: number;
}) {
  const { t } = useTranslation();
  // 成员职务（快照里有就显示）；早期活动折叠集合
  const member = session.members?.find((item) => item.id === task.memberId);
  const older = task.activities.slice(0, -VISIBLE_ACTIVITIES);
  // 耗时：同 ActivityRow——服务端值优先，运行中现算
  const elapsed =
    task.durationMs ??
    (researchIsActive(task.status) ? now - Date.parse(task.startedAt) : undefined);
  return (
    <article
      aria-label={`${task.memberName} · ${t('council.progress.taskTurn', { turn: task.turn + 1 })}`}
      className="min-w-0 rounded-2xl rounded-tl-sm border border-primary/20 bg-card px-3 py-3 shadow-sm sm:px-4"
    >
      {/* 头部：状态图标 + 成员名/职务/轮次 + 旧修订标记 */}
      <div className="flex items-start gap-2 text-xs leading-5">
        <ActivityIcon status={task.status} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 [overflow-wrap:anywhere]">
            <span className="font-semibold">{task.memberName}</span>
            {member && (
              <span className="text-muted-foreground">
                {member.roleTitle || t(`council.roles.${member.role}`)}
              </span>
            )}
            <span className="text-muted-foreground">
              {t('council.progress.taskTurn', { turn: task.turn + 1 })}
            </span>
            {/* 什么时候走到这里：任务属于旧修订——标注"上一版（N）" */}
            {task.isStale && (
              <span className="text-muted-foreground">
                {t('council.progress.previousRevision', { revision: task.revision })}
              </span>
            )}
          </div>
          {/* 状态行：状态文字 + 耗时 + 来源计数 */}
          <p className="flex flex-wrap gap-x-3 gap-y-0.5 text-muted-foreground">
            <span role="status">{t(`council.progress.taskStates.${task.status}`)}</span>
            {Number.isFinite(elapsed) && (
              <span className="tabular-nums">
                {t('council.progress.duration', {
                  seconds: Math.max(0, Math.floor(elapsed! / 1000)),
                })}
              </span>
            )}
            {task.sourceCount > 0 && (
              <span>{t('council.chat.sources', { count: task.sourceCount })}</span>
            )}
          </p>
          {/* 什么时候走到这里：任务带研究小结 */}
          {task.summary && (
            <p className="mt-1 whitespace-pre-wrap text-muted-foreground [overflow-wrap:anywhere]">
              {task.summary}
            </p>
          )}
        </div>
      </div>
      {/* 活动列表：早期活动折叠，尾部 VISIBLE_ACTIVITIES 条直接展开 */}
      {task.activities.length > 0 && (
        <div className="mt-3 space-y-2 border-t border-border/70 pt-3">
          {/* 什么时候走到这里：活动总数超过展开上限——更早的折叠进 details */}
          {older.length > 0 && (
            <details className="text-xs">
              <summary className="mb-2 cursor-pointer text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">
                {t('council.progress.olderActivities', { count: older.length })}
              </summary>
              <ol className="mb-3 space-y-3">
                {older.map((activity) => (
                  <ActivityRow key={activity.key} activity={activity} now={now} />
                ))}
              </ol>
            </details>
          )}
          <ol className="space-y-3">
            {task.activities.slice(-VISIBLE_ACTIVITIES).map((activity) => (
              <ActivityRow key={activity.key} activity={activity} now={now} />
            ))}
          </ol>
        </div>
      )}
      {/* 什么时候走到这里：任务有关联回复消息——跳转按钮（滚动居中并聚焦，preventScroll 防二次滚动） */}
      {task.replyMessageId && (
        <button
          type="button"
          className="mt-2 text-xs text-primary underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
          onClick={() => {
            const target = document.getElementById(`council-message-${task.replyMessageId}`);
            target?.scrollIntoView({ block: 'center', behavior: 'smooth' });
            target?.focus({ preventScroll: true });
          }}
        >
          {t('council.progress.viewReply')}
        </button>
      )}
    </article>
  );
}

export default function CouncilResearchTimeline({ session }: { session: CouncilSession }) {
  const { t } = useTranslation();
  // now：每秒更新的时钟，仅供运行中任务计算耗时
  const [now, setNow] = useState(Date.now);
  // 归整后的任务视图，按新旧修订分组
  const timeline = researchTimeline(session);
  const current = timeline.tasks.filter((task) => !task.isStale);
  const previous = timeline.tasks.filter((task) => task.isStale);
  // 是否有进行中的当前任务（决定是否启动秒级定时器）
  const active = current.some((task) => researchIsActive(task.status));
  // 运行中每秒刷新 now；停止运行则清定时器（useEffect 内语句顺序保持不动）
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  // 渲染一批任务卡
  const cards = (tasks: ResearchTaskView[]) =>
    tasks.map((task) => <TaskCard key={task.key} task={task} session={session} now={now} />);
  return (
    <section
      aria-label={t('council.progress.history')}
      className="w-full min-w-0 space-y-3 sm:max-w-[88%]"
    >
      <h3 className="text-xs font-medium text-muted-foreground">{t('council.progress.history')}</h3>
      {/* 什么时候走到这里：存在旧修订任务——整体折叠为"上一版研究" */}
      {previous.length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">
            {t('council.progress.previousRevisions', { count: previous.length })}
          </summary>
          <div className="mt-3 space-y-3">{cards(previous)}</div>
        </details>
      )}
      {/* 什么时候走到这里：当前任务超过展开上限——头部任务折叠进"更早的任务" */}
      {current.length > VISIBLE_TASKS && (
        <details className="text-xs">
          <summary className="cursor-pointer text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">
            {t('council.progress.olderTasks', { count: current.length - VISIBLE_TASKS })}
          </summary>
          <div className="mt-3 space-y-3">{cards(current.slice(0, -VISIBLE_TASKS))}</div>
        </details>
      )}
      {/* 尾部 VISIBLE_TASKS 张任务卡直接展开 */}
      {cards(current.slice(-VISIBLE_TASKS))}
      {/* 什么时候走到这里：事件总量被服务端截断——尾部提示 */}
      {timeline.truncated && (
        <p className="text-xs leading-5 text-muted-foreground">{t('council.progress.truncated')}</p>
      )}
    </section>
  );
}
