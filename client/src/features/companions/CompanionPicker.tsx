import type { PortfolioCompanionId } from '@shared/portfolio-workspace.interface';
import CouncilMemberAvatar from '@/components/AnimalAvatar';
import { companions } from './companions';

export default function CompanionPicker({ value, onChange, zh, expanded = false, disabled = false }: {
  value: PortfolioCompanionId | null; onChange: (id: PortfolioCompanionId) => void;
  zh: boolean; expanded?: boolean; disabled?: boolean;
}) {
  return <div className={`companion-picker ${expanded ? 'expanded' : ''}`} role="group" aria-label={zh ? '选择动物股友' : 'Choose an animal companion'}>
    {companions.map(companion => <button key={companion.id} type="button" disabled={disabled}
      aria-pressed={value === companion.id} className="companion-option" onClick={() => onChange(companion.id)}>
      <CouncilMemberAvatar avatar={companion.id} role="researcher" className="companion-animal" />
      <strong>{companion.name[zh ? 0 : 1]}</strong><span>{companion.focus[zh ? 0 : 1]}</span>
      {expanded && <><p>{companion.description[zh ? 0 : 1]}</p><small className="companion-blind-spot">{companion.blindSpot[zh ? 0 : 1]}</small></>}
    </button>)}
  </div>;
}
