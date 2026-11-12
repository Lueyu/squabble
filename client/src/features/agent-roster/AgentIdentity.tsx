import type { AnimalAvatarId } from '@shared/animal-avatar';
import AnimalAvatar from '@/components/AnimalAvatar';
import { cn } from '@/lib/utils';

/** A person's appearance stays the same in a roster, a team and a conversation. */
export function AgentIdentity({ avatar, name, className, avatarClassName }: {
  avatar?: AnimalAvatarId;
  name?: string;
  className?: string;
  avatarClassName?: string;
}) {
  return <span className={cn('inline-flex min-w-0 items-center gap-3', className)}>
    <AnimalAvatar avatar={avatar} role="researcher" className={avatarClassName} />
    {name && <span className="min-w-0 break-words">{name}</span>}
  </span>;
}
