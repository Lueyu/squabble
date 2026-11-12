import { useSearchParams } from 'react-router-dom';
import TeamsPage from './TeamsPage';
import GuidedTeamCreate from '@/features/teams/GuidedTeamCreate';

export default function TeamsEntryPage() {
  const [params] = useSearchParams();
  return params.get('guided') === '1' ? <GuidedTeamCreate /> : <TeamsPage />;
}
