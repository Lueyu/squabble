import { UserRound } from 'lucide-react';
import type { CouncilMember, CouncilMessage } from '@shared/council.interface';
import { cn } from '@/lib/utils';
import { councilPersona } from './council-persona';
import './council-chat.css';

export default function CouncilMemberAvatar({ avatar, role, className }: {
  avatar?: CouncilMember['avatar']; role: CouncilMessage['role']; className?: string;
}) {
  const key = councilPersona(avatar, role);
  return <span aria-hidden="true" data-persona={key} className={cn('council-avatar size-10 shrink-0', className)}>
    {key === 'user' ? <UserRound className="size-5" /> : <svg viewBox="0 0 64 64" fill="none" stroke="var(--mascot-ink)" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round">
      {key === 'value' && <>
        <path d="M15 24Q9 23 6 12L16 8L23 24M42 24L48 8L58 12Q56 23 48 25" fill="var(--mascot-light)" />
        <path d="M13 28Q12 20 26 20H40Q52 20 52 31L50 48Q48 56 36 56H25Q15 55 14 47Z" fill="var(--mascot-fill)" />
        <path d="M24 20L28 15L33 20" fill="var(--mascot-fill)" />
        <rect x="22" y="38" width="23" height="12" rx="6" fill="var(--mascot-light)" stroke="none" />
        <path d="M29 43V45M38 43V45" /><circle cx="24" cy="30" r="2" fill="var(--mascot-ink)" /><circle cx="42" cy="30" r="2" fill="var(--mascot-ink)" />
      </>}
      {key === 'growth' && <>
        <path d="M20 28Q10 4 18 4Q26 3 29 25M35 25Q38 2 46 5Q53 9 43 29" fill="var(--mascot-fill)" />
        <path d="M19 11L23 22M43 12L40 22" stroke="var(--mascot-light)" strokeWidth="4" />
        <path d="M13 38Q12 23 32 23Q52 23 51 38L49 47Q46 57 32 57Q16 57 14 46Z" fill="var(--mascot-fill)" />
        <circle cx="24" cy="36" r="2" fill="var(--mascot-ink)" /><circle cx="41" cy="36" r="2" fill="var(--mascot-ink)" />
        <path d="M29 43L32 46L35 43M32 46V50" /><path d="M19 44H22M43 44H46" stroke="var(--mascot-light)" strokeWidth="4" />
      </>}
      {key === 'risk' && <>
        <rect x="13" y="20" width="39" height="36" rx="14" fill="var(--mascot-fill)" />
        <circle cx="17" cy="18" r="8" fill="var(--mascot-fill)" /><circle cx="47" cy="18" r="8" fill="var(--mascot-fill)" />
        <circle cx="17" cy="18" r="3.5" fill="var(--mascot-light)" stroke="none" /><circle cx="47" cy="18" r="3.5" fill="var(--mascot-light)" stroke="none" />
        <ellipse cx="33" cy="44" rx="10" ry="8" fill="var(--mascot-light)" stroke="none" />
        <path d="M29 41Q33 39 37 41L33 45Z" fill="var(--mascot-ink)" /><path d="M33 45V48M21 28L26 30M39 30L44 28" />
        <circle cx="24" cy="33" r="1.8" fill="var(--mascot-ink)" /><circle cx="41" cy="33" r="1.8" fill="var(--mascot-ink)" />
      </>}
      {key === 'technical' && <>
        <path d="M12 39L13 10L27 20H38L51 10L53 39Q53 55 33 56Q12 55 12 39Z" fill="var(--mascot-fill)" />
        <path d="M18 18L24 24M46 18L41 24M28 42L32 45L36 42M32 45V49M8 39L20 41M8 46L20 45M45 41L57 39M45 45L57 47" />
        <path d="M21 31L25 33L29 28M37 32H44" strokeWidth="2.7" />
      </>}
      {key === 'news' && <>
        <path d="M10 11L28 22H37L54 11L52 37Q48 49 32 57Q16 49 12 37Z" fill="var(--mascot-fill)" />
        <path d="M17 21L23 27M47 21L41 27" />
        <path d="M13 37Q26 34 32 48Q38 34 51 37Q47 48 32 55Q18 48 13 37" fill="var(--mascot-light)" stroke="none" />
        <circle cx="23" cy="33" r="2" fill="var(--mascot-ink)" /><circle cx="41" cy="33" r="2" fill="var(--mascot-ink)" />
        <path d="M29 46H35L32 50Z" fill="var(--mascot-ink)" />
      </>}
      {key === 'macro' && <>
        <path d="M8 37Q8 21 28 21Q46 21 47 39Q54 40 57 30Q62 42 54 49Q46 56 29 55Q8 54 8 37Z" fill="var(--mascot-fill)" />
        <path d="M12 44Q22 53 40 47" stroke="var(--mascot-light)" strokeWidth="6" />
        <path d="M28 22V14M28 15Q20 7 17 15M28 15Q34 6 39 13M32 42Q35 47 39 42" />
        <circle cx="18" cy="34" r="2" fill="var(--mascot-ink)" />
      </>}
      {key === 'moderator' && <>
        <path d="M12 12L27 20H37L52 12L50 42Q49 56 32 56Q15 56 14 42Z" fill="var(--mascot-fill)" />
        <path d="M15 29Q22 19 32 29Q43 19 50 29L47 41Q41 47 32 39Q23 47 17 41Z" fill="var(--mascot-light)" stroke="none" />
        <circle cx="24" cy="33" r="7" /><circle cx="41" cy="33" r="7" /><path d="M31 32H34M29 43L33 47L37 43" />
        <circle cx="24" cy="33" r="1.7" fill="var(--mascot-ink)" /><circle cx="41" cy="33" r="1.7" fill="var(--mascot-ink)" />
      </>}
    </svg>}
  </span>;
}
