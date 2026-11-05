import { useQuery } from '@tanstack/react-query';
import { fetchExperiencePreferences } from '@/api/simple-experience';
import { hasSession } from '@/api/http';

export function useSimpleExperience() {
  const query = useQuery({ queryKey: ['experience', 'preferences'], queryFn: fetchExperiencePreferences,
    enabled: hasSession(), retry: false, staleTime: 60_000 });
  return { ...query, enabled: query.data?.enabled === true };
}
