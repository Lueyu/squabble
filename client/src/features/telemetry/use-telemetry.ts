import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchTelemetryRun, fetchTelemetryWorkspace, saveTelemetryFeedback } from '@/api/telemetry';
import type { TelemetryFeedback, TelemetryFeedbackInput, TelemetryFilters, TelemetryRunDetail } from '@shared/telemetry.interface';

export function useTelemetryWorkspace(filters: TelemetryFilters) {
  return useQuery({
    queryKey: ['telemetry-workspace', filters],
    queryFn: () => fetchTelemetryWorkspace(filters),
    staleTime: 30_000,
  });
}

export function useTelemetryRun(id: string) {
  return useQuery({
    queryKey: ['telemetry-run', id], queryFn: () => fetchTelemetryRun(id), enabled: Boolean(id),
    refetchInterval: query => ['running', 'queued'].includes(query.state.data?.run.status ?? '') ? 15_000 : false,
  });
}

export function useTelemetryFeedback(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: TelemetryFeedbackInput) => saveTelemetryFeedback(id, input),
    retry: false,
    onSuccess: async (feedback: TelemetryFeedback) => {
      // A late read must not replace the just-saved feedback. The form remains
      // mounted for the run so a subsequent refresh cannot discard a new draft.
      await client.cancelQueries({ queryKey: ['telemetry-run', id] });
      client.setQueryData<TelemetryRunDetail>(['telemetry-run', id], current => current
        ? { ...current, feedback } : current);
      await client.invalidateQueries({ queryKey: ['telemetry-workspace'] });
    },
  });
}
