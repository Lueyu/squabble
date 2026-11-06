import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Clock3, CircleHelp, Search } from 'lucide-react';
import type { ResearchConversationView } from '@shared/simple-conversation.interface';
import { researchTimeline } from '@/utils/research-events';
import CouncilMemberAvatar from './CouncilMemberAvatar';
import { councilPersona } from './council-persona';

export default function CouncilMemberActivity({ session, onDetails }: { session: ResearchConversationView; onDetails: () => void }) {
  const { i18n } = useTranslation(); const zh = i18n.language.startsWith('zh');
  const [now, setNow] = useState(Date.now);
  const active = session.memberStates?.some(item => ['running', 'queued'].includes(item.status));
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [active]);
  const tasks = researchTimeline(session).tasks;
  const participants = session.members?.filter(member => session.memberStates?.some(item => item.memberId === member.id)
    || session.actualExecutors?.some(item => item.memberId === member.id) || tasks.some(item => item.memberId === member.id)) || [];
  if (!participants.length) return null;
  return <section className="research-member-strip" aria-label={zh ? '股友当前活动' : 'Current member activity'}>
    <div className="research-member-grid">{participants.map(member => {
      const state = session.memberStates?.find(item => item.memberId === member.id);
      const task = tasks.filter(item => item.memberId === member.id && !item.isStale).at(-1);
      const last = task?.activities.at(-1);
      const status = state?.status || (task ? ({ succeeded: 'completed', interrupted: 'unknown', unavailable: 'failed' }[task.status] || task.status) : 'unknown');
      const accepted = state?.resultAcceptance === 'accepted' || (!state && task?.replyMessageId);
      const rejected = state?.resultAcceptance === 'rejected';
      const started = state?.startedAt || task?.startedAt;
      const lastAt = state?.lastActivityAt || last?.at || task?.endedAt || started;
      const end = state?.completedAt || task?.endedAt;
      const elapsed = started ? Math.max(0, Math.floor(((end ? Date.parse(end) : now) - Date.parse(started)) / 1000)) : null;
      const label = rejected ? (zh ? '内容整理未完成' : 'Content needs formatting') : accepted ? (zh ? '已提交观点' : 'View accepted')
        : status === 'running' ? (last?.kind === 'tool' && last.status === 'running' ? (zh ? '正在查阅资料' : 'Checking evidence') : (zh ? '正在分析' : 'Analyzing'))
        : status === 'queued' ? (zh ? '排队中' : 'Queued') : status === 'failed' ? (zh ? '这位暂未完成' : 'Could not finish')
        : status === 'completed' ? (zh ? '研究已返回，正在整理' : 'Research returned; formatting')
        : ['cancelled', 'skipped'].includes(status) ? (zh ? '已停止本次研究' : 'This attempt stopped') : (zh ? '暂未收到新状态' : 'No new status received');
      return <button type="button" className="research-member-card" key={member.id} data-persona={councilPersona(member.avatar, member.role)} onClick={onDetails}
        aria-label={`${member.name}: ${label}. ${zh ? '查看研究详情' : 'View research details'}`}>
        <CouncilMemberAvatar avatar={member.avatar} role={member.role} className="size-10" />
        <div className="min-w-0 flex-1"><strong className="block truncate text-sm">{member.name}</strong><p className="mt-1 flex items-center gap-1.5 text-xs">{accepted ? <Check size={12} /> : status === 'queued' ? <Clock3 size={12} /> : status === 'running' ? <Search size={12} /> : <CircleHelp size={12} />}<span className="min-w-0 [overflow-wrap:anywhere]">{label}</span></p>
          <p className="research-member-time mt-1 text-[11px] text-muted-foreground">{elapsed !== null && Number.isFinite(elapsed) && <span className="tabular-nums">{elapsed < 60 ? `${elapsed}${zh ? '秒' : 's'}` : `${Math.floor(elapsed / 60)}${zh ? '分' : 'm'} ${elapsed % 60}${zh ? '秒' : 's'}`} · </span>}{lastAt && <time dateTime={lastAt}>{zh ? '最近 ' : 'Last '}{new Date(lastAt).toLocaleTimeString(i18n.language, { hour: '2-digit', minute: '2-digit' })}</time>}</p>
        </div>
      </button>;
    })}</div>
  </section>;
}
