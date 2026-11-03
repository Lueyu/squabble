import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ResearchMemoryQuery, UpdateResearchThesis } from '@shared/research-memory.interface';
import { deleteResearchMemory, deleteResearchThesis, fetchResearchMemory, fetchResearchMemoryPreferences,
  fetchResearchThesisVersions, saveResearchMemoryPreferences, updateResearchMemory, updateResearchThesis } from '@/api/research-memory';

export function useResearchMemory(query: ResearchMemoryQuery) {
  return useQuery({ queryKey: ['research-memory', 'list', query], queryFn: () => fetchResearchMemory(query),
    enabled: Boolean(query.ticker.trim()), refetchInterval: 15_000 });
}
export function useResearchMemoryPreferences() {
  return useQuery({ queryKey: ['research-memory', 'preferences'], queryFn: fetchResearchMemoryPreferences });
}
export function useResearchThesisVersions(id: string | null) {
  return useQuery({ queryKey: ['research-memory', 'versions', id],
    queryFn: () => fetchResearchThesisVersions(id!), enabled: Boolean(id) });
}
export function useResearchMemoryActions() {
  const client = useQueryClient();
  const refresh = () => client.invalidateQueries({ queryKey: ['research-memory'] });
  const preferences = useMutation({ mutationFn: saveResearchMemoryPreferences, retry: false, onSuccess: refresh });
  const updateMemory = useMutation({ mutationFn: ({ id, excluded }: { id: string; excluded: boolean }) =>
    updateResearchMemory(id, excluded), retry: false, onSuccess: refresh });
  const deleteMemory = useMutation({ mutationFn: deleteResearchMemory, retry: false, onSuccess: refresh });
  const updateThesis = useMutation({ mutationFn: ({ id, input }: { id: string; input: UpdateResearchThesis }) =>
    updateResearchThesis(id, input), retry: false, onSuccess: refresh, onError: refresh });
  const deleteThesis = useMutation({ mutationFn: ({ id, expectedVersion }: { id: string; expectedVersion: number }) =>
    deleteResearchThesis(id, expectedVersion), retry: false, onSuccess: refresh, onError: refresh });
  return { preferences, updateMemory, deleteMemory, updateThesis, deleteThesis };
}
