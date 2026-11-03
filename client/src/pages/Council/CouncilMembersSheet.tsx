import { useTranslation } from 'react-i18next';
import { ArrowUpRight, Users } from 'lucide-react';
import type { CouncilMember, CouncilSession } from '@shared/council.interface';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import CouncilMemberAvatar from './CouncilMemberAvatar';
import { councilPersona } from './council-persona';
import { useCouncilModels } from './useCouncilModels';

export default function CouncilMembersSheet({ session, onClose, onUseTeam }: {
  session: CouncilSession; onClose: () => void; onUseTeam: () => void;
}) {
  const { t } = useTranslation();
  const models = useCouncilModels();
  const members = session.members ?? [];
  return <Sheet open onOpenChange={(open: boolean) => { if (!open) onClose(); }}>
    <SheetContent className="w-[min(440px,96vw)] gap-0 p-0 sm:max-w-[440px]">
      <SheetHeader className="border-b border-border px-5 py-5 pr-12 text-left">
        <SheetTitle className="flex items-center gap-2"><Users className="size-4" />{t('council.members.groupTitle', { count: members.length })}</SheetTitle>
        <SheetDescription>{t('council.members.snapshotHint')}</SheetDescription>
      </SheetHeader>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
        {members.length === 0 && <p className="text-sm text-muted-foreground">{t('council.members.legacySnapshot')}</p>}
        {members.map((member: CouncilMember) => <article key={member.id} data-persona={councilPersona(member.avatar, member.role)} className="council-member-card rounded-xl border border-border p-4">
          <div className="flex items-center gap-3"><CouncilMemberAvatar role={member.role} avatar={member.avatar} />
            <div className="min-w-0"><h3 className="break-words text-sm font-semibold">{member.name}</h3>
              <p className="break-words text-xs text-muted-foreground [overflow-wrap:anywhere]">{member.roleTitle || t(`council.roles.${member.role}`)}
                {member.role === 'manager' && ` · ${t('council.members.moderator')}`}</p></div>
          </div>
          {member.personality && <p className="mt-3 break-words text-sm leading-6">{member.personality}</p>}
          <div className="mt-3 flex flex-wrap gap-1.5 text-[11px] text-muted-foreground">
            {(member.researchFocus ?? []).map((focus) => <span key={focus} className="rounded-md bg-muted px-2 py-1">{t(`council.members.focuses.${focus}`)}</span>)}
            {member.speakingStyle && <span className="rounded-md bg-muted px-2 py-1">{t(`council.members.styles.${member.speakingStyle}`)}</span>}
          </div>
          <p className="mt-3 break-words text-xs text-muted-foreground">{models.memberLabel(member)}</p>
          {member.instructions && <details className="mt-3 text-xs"><summary className="cursor-pointer text-muted-foreground">{t('council.members.prompt')}</summary>
            <p className="mt-2 whitespace-pre-wrap break-words leading-6">{member.instructions}</p></details>}
        </article>)}
        <p className="text-xs leading-5 text-muted-foreground">{t(members.every(member => member.executionMode === 'local')
          ? 'council.localAgents.toolsHint' : session.webResearch ? 'council.members.webEnabledSnapshot' : 'council.members.webDisabledSnapshot')}</p>
      </div>
      <div className="shrink-0 border-t border-border p-4"><Button type="button" className="h-auto min-h-9 w-full whitespace-normal" onClick={onUseTeam}>
        <ArrowUpRight className="size-4" />{t('council.members.useTeam')}</Button></div>
    </SheetContent>
  </Sheet>;
}
