import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CouncilSession } from '@shared/council.interface';
import {
  createCouncilSession, fetchCouncilSession, fetchCouncilSessions, pauseCouncilSession,
  postCouncilMessage, runCouncilSession, retryCouncilTask,
} from '@/api/council';

export function useCouncilSessions() {
  return useQuery({ queryKey: ['council', 'sessions'], queryFn: fetchCouncilSessions,
    refetchInterval: 15_000 });
}

export function useCouncilSession(id: string | null) {
  return useQuery({
    queryKey: ['council', 'session', id],
    queryFn: () => fetchCouncilSession(id!),
    enabled: Boolean(id),
    refetchInterval: (query) => query.state.data?.status === 'running' ? 2000 : 10_000,
  });
}

export function useCouncilActions() {
  const client = useQueryClient();
  const update = (session: CouncilSession) => {
    client.setQueryData(['council', 'session', session.id], session);
    void client.invalidateQueries({ queryKey: ['council', 'sessions'] });
    void client.invalidateQueries({ queryKey: ['llm-budget'] });
  };
  const create = useMutation({ mutationFn: createCouncilSession, retry: false, onSuccess: update });
  const send = useMutation({
    mutationFn: ({ id, content }: { id: string; content: string }) => postCouncilMessage(id, content),
    retry: false, onSuccess: update,
  });
  const run = useMutation({ mutationFn: runCouncilSession, retry: false, onSuccess: update });
  const pause = useMutation({ mutationFn: pauseCouncilSession, retry: false, onSuccess: update });
  const retry = useMutation({ mutationFn: ({ id, taskId }: { id: string; taskId: string }) => retryCouncilTask(id, taskId), retry: false, onSuccess: update });
  return { create, send, run, pause, retry };
}
