import {
  ChartNoAxesCombined,
  Coins,
  Globe2,
  MessagesSquare,
  Newspaper,
  ShieldCheck,
  TrendingUp,
  UserRound,
} from 'lucide-react';
import type { CouncilMember, CouncilMessage } from '@shared/council.interface';
import { cn } from '@/lib/utils';

export const COUNCIL_AVATAR_ICONS = {
  value: Coins,
  growth: TrendingUp,
  risk: ShieldCheck,
  technical: ChartNoAxesCombined,
  news: Newspaper,
  macro: Globe2,
  moderator: MessagesSquare,
};

export default function CouncilMemberAvatar({
  avatar,
  role,
  className,
}: {
  avatar?: CouncilMember['avatar'];
  role: CouncilMessage['role'];
  className?: string;
}) {
  const key =
    avatar ?? (role === 'manager' ? 'moderator' : role === 'challenger' ? 'risk' : 'value');
  const Icon = role === 'user' ? UserRound : COUNCIL_AVATAR_ICONS[key];
  return (
    <span
      aria-hidden="true"
      className={cn(
        'flex size-9 shrink-0 items-center justify-center rounded-xl',
        role === 'user'
          ? 'bg-primary text-primary-foreground'
          : role === 'challenger'
            ? 'bg-secondary text-secondary-foreground'
            : 'bg-primary/10 text-primary',
        className,
      )}
    >
      <Icon className="size-[18px]" />
    </span>
  );
}
