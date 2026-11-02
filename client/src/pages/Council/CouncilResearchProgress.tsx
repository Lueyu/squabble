import { useTranslation } from 'react-i18next';
import { CheckCircle2, CircleAlert, Loader2, Search } from 'lucide-react';
import type { CouncilSession } from '@shared/council.interface';

export default function CouncilResearchProgress({ session }: { session: CouncilSession }) {
  const { t } = useTranslation();
  const events = session.messages.filter((message) => message.acquisition || message.phase === 'progress');
  // Native CLIs may report the same tool step several times. Keep the latest occurrence of each
  // public update so the chat shows actual changes instead of repeated "researching" rows.
  const seen = new Set<string>();
  const distinct = [...events].reverse().filter((message) => {
    const key = `${message.memberName}\u0000${message.acquisition?.status ?? ''}\u0000${message.acquisition?.detail ?? message.content}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).reverse();
  const progress = session.progress;
  const activeMember = session.members?.find((member) => member.id === progress?.memberId);
  const latest = distinct.at(-1);
  if (!progress && events.length === 0) return null;
  const running = session.status === 'running';
  const phase = progress?.phase ?? 'progress';
  return <section aria-label={t('council.progress.history')} className="max-w-[84%] rounded-2xl rounded-tl-sm border border-primary/20 bg-card px-4 py-3 text-xs shadow-sm">
    <div className="flex items-center gap-2">
      {running ? <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" /> : <Search className="size-3.5 shrink-0 text-muted-foreground" />}
      <span className="min-w-0 flex-1 truncate" role="status">
        {running ? activeMember ? `${activeMember.name} · ${t(`council.progress.phases.${phase}`)}`
          : t(`council.progress.phases.${phase}`) : t('council.progress.history')}
        {!progress && running && latest?.acquisition?.source && ` · ${latest.acquisition.source}`}
      </span>
      {running && progress && progress.totalTurns > 0 && <span className="shrink-0 tabular-nums text-muted-foreground">
        {t('council.progress.turn', { turn: Math.min(progress.turn, progress.totalTurns), total: progress.totalTurns })}</span>}
    </div>
    <div className="mt-3 space-y-2 border-t border-border/70 pt-3">
      {distinct.length === 0 && <p className="leading-5 text-muted-foreground">{t('council.progress.waiting')}</p>}
      {distinct.slice(-4).map((message) => {
        const acquisition = message.acquisition;
        const failed = acquisition?.status === 'failed' || acquisition?.status === 'partial';
        return <div key={message.id} className="flex items-start gap-2 leading-5">
          {failed ? <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
            : acquisition?.status === 'started' ? <Search className="mt-0.5 size-3.5 shrink-0 text-primary" />
              : <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-primary" />}
          <p className="min-w-0 break-words"><span className="font-medium">{acquisition?.source ?? message.memberName}</span>
            {acquisition && <span className="ml-2 text-muted-foreground">{t(`council.progress.acquisition.${acquisition.status}`)}</span>}
            <span className="mt-0.5 block text-muted-foreground">{acquisition?.detail || message.content}</span></p>
        </div>;
      })}
    </div>
  </section>;
}
