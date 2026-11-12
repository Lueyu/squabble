import { ANIMAL_AVATAR_IDS, ANIMAL_AVATAR_LABELS, type AnimalAvatarId } from '@shared/animal-avatar';
import { cn } from '@/lib/utils';
import { AgentIdentity } from './AgentIdentity';

export function AnimalAvatarPicker({ value, onChange, zh, disabled = false }: {
  value: AnimalAvatarId;
  onChange: (avatar: AnimalAvatarId) => void;
  zh: boolean;
  disabled?: boolean;
}) {
  return <fieldset className="space-y-2" disabled={disabled}>
    <legend className="text-sm font-medium">{zh ? '动物头像' : 'Animal avatar'}</legend>
    <p className="text-xs text-muted-foreground">
      {zh ? '这是股友的身份标记，加入团队或换专长都不会自动更换。' : 'This identifies your agent across teams and specialties.'}
    </p>
    <div className="flex flex-wrap gap-2">
      {ANIMAL_AVATAR_IDS.map(avatar => {
        const label = ANIMAL_AVATAR_LABELS[avatar][zh ? 'zh' : 'en'];
        return <label key={avatar} className={cn(
          'relative flex cursor-pointer flex-col items-center gap-1 rounded-lg border p-2 text-xs',
          value === avatar ? 'border-primary bg-primary/10' : 'hover:bg-muted',
        )}>
          <input className="peer sr-only" type="radio" name="agent-avatar" value={avatar}
            checked={value === avatar} onChange={() => onChange(avatar)} aria-label={label} />
          <span className="rounded-md peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-primary">
            <AgentIdentity avatar={avatar} />
          </span>
          <span>{label}</span>
        </label>;
      })}
    </div>
  </fieldset>;
}
