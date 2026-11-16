import { Navigate, useSearchParams } from 'react-router-dom';
import TeamsPage from './TeamsPage';
import GuidedTeamCreate from '@/features/teams/GuidedTeamCreate';
import { hasLegacyGuidedProgress } from '@/features/teams/guided-team-storage';

/**
 * Team entry: the legacy ?guided=1 flow only continues when a real guided
 * progress record exists; fresh visits open the unified organization-template
 * dialog instead of the old auto-run onboarding.
 */
export default function TeamsEntryPage() {
  const [params] = useSearchParams();
  if (params.get('guided') === '1') {
    return hasLegacyGuidedProgress() ? <GuidedTeamCreate /> : <Navigate to="/teams?advanced=1&create=1" replace />;
  }
  return <TeamsPage />;
}
