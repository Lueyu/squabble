import type { PortfolioCompanionId } from '@shared/portfolio-workspace.interface';
import CouncilMemberAvatar from '@/components/AnimalAvatar';
import { companionById } from './companions';

export default function CompanionIdentity({ id, zh, compact = false }: {
  id?: PortfolioCompanionId | null; zh: boolean; compact?: boolean;
}) {
  const companion = companionById(id);
  return <div className={`companion-identity ${compact ? 'compact' : ''}`}>
    <CouncilMemberAvatar avatar={companion?.id ?? 'moderator'} role="researcher" className="companion-animal" />
    <div><strong>{companion ? companion.name[zh ? 0 : 1] : zh ? '等待你的股友' : 'Choose your companion'}</strong>
      {!compact && <p>{companion ? companion.focus[zh ? 0 : 1] : zh ? '每个想法，一个独立模拟仓' : 'An independent account for each idea'}</p>}</div>
  </div>;
}
