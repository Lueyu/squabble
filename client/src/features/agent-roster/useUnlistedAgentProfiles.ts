import { useQueries, type UseQueryResult } from '@tanstack/react-query';
import type { AgentProfile } from '@shared/agent-roster.interface';
import { agentRosterApi } from '@/api/agent-roster';

function combineProfiles(results: UseQueryResult<AgentProfile>[]) {
  return { profiles: results.flatMap(result => result.data ? [result.data] : []), pending: results.some(result => result.isPending) };
}

export function useUnlistedAgentProfiles(listed: readonly AgentProfile[] | undefined, referencedIds: readonly (string | null | undefined)[]) {
  const ids = listed ? [...new Set(referencedIds)] : [];
  return useQueries({
    queries: ids.flatMap(id => id && !listed?.some(profile => profile.id === id)
      ? [{ queryKey: ['agent-roster', id], queryFn: () => agentRosterApi.detail(id), retry: false }]
      : []),
    combine: combineProfiles,
  });
}
