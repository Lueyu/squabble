import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CouncilSession, CouncilScene, CouncilMessageInput, ForkCouncilSession } from '@shared/council.interface';
import {
  createCouncilSession, fetchCouncilSession, fetchCouncilSessions, pauseCouncilSession,
  postCouncilMessage, runCouncilSession, retryCouncilTask, forkCouncilSession,
} from '@/api/council';

export function useCouncilSessions(filters: { scene?: CouncilScene; topic?: string } = {}) {
  return useQuery({ queryKey: ['council', 'sessions', filters], queryFn: () => fetchCouncilSessions(filters),
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
    mutationFn: ({ id, content, ...details }: { id: string } & CouncilMessageInput) => postCouncilMessage(id, content, details),
    retry: false, onSuccess: update,
  });
  const run = useMutation({ mutationFn: runCouncilSession, retry: false, onSuccess: update });
  const pause = useMutation({ mutationFn: pauseCouncilSession, retry: false, onSuccess: update });
  const retry = useMutation({ mutationFn: ({ id, taskId }: { id: string; taskId: string }) => retryCouncilTask(id, taskId), retry: false, onSuccess: update });
  const fork = useMutation({ mutationFn: ({ id, ...input }: { id: string } & ForkCouncilSession) => forkCouncilSession(id, input), retry: false, onSuccess: update });
  return { create, send, run, pause, retry, fork };
}
