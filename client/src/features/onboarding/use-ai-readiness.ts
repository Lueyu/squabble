import { useQuery } from '@tanstack/react-query';
import { fetchModelConnections } from '@/api/model-connections';
import { fetchResearchExecutionReadiness } from '@/api/research-conversations';
import { LOCAL_ONBOARDING_PATH, MODEL_ONBOARDING_PATH, usableAiConnection } from './onboarding-state';

export const LOCAL_AI_READINESS_KEY = ['settings', 'local-agents', 'readiness'];

export function useAiReadiness({ enabled = true, watch = false }: { enabled?: boolean; watch?: boolean } = {}) {
  const local = useQuery({
    queryKey: LOCAL_AI_READINESS_KEY,
    queryFn: fetchResearchExecutionReadiness,
    enabled,
    refetchInterval: watch ? 5_000 : false,
    retry: false,
  });
  const models = useQuery({
    queryKey: ['settings', 'model-connections'],
    queryFn: fetchModelConnections,
    enabled,
    retry: false,
  });
  const connection = usableAiConnection(local.isSuccess ? local.data : [], models.isSuccess ? models.data : []);
  return {
    connection,
    connectionPath: models.data?.length && !local.data?.some(row => row.connected) ? MODEL_ONBOARDING_PATH : LOCAL_ONBOARDING_PATH,
    pending: !connection && (local.isPending || models.isPending),
    error: !connection && (local.isError || models.isError),
    locals: local.data ?? [],
    models: models.data ?? [],
    reload: () => Promise.all([local.refetch(), models.refetch()]),
  };
}
