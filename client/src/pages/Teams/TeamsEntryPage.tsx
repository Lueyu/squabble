import { useSearchParams } from 'react-router-dom';
import TeamsPage from './TeamsPage';
import GuidedTeamCreate from '@/features/teams/GuidedTeamCreate';
import { guidedOwnerScope, hasLegacyGuidedProgress, readGuidedProgress } from '@/features/teams/guided-team-storage';

export default function TeamsEntryPage() {
  const [params] = useSearchParams();
  const onboarding = params.get('guided') === '1';
  if (onboarding && (readGuidedProgress(guidedOwnerScope()) || hasLegacyGuidedProgress())) return <GuidedTeamCreate />;
  return <TeamsPage key={onboarding ? 'guided' : 'list'} onboarding={onboarding} />;
}
