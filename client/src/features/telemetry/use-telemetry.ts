import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchTelemetryDiagnostics, fetchTelemetryRun, fetchTelemetryWorkspace, saveTelemetryFeedback } from '@/api/telemetry';
import type { TelemetryFeedback, TelemetryFeedbackInput, TelemetryFilters, TelemetryRunDetail } from '@shared/telemetry.interface';
import { diagnosticAccessDenied } from './telemetry-diagnostics-state';

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

export function useTelemetryDiagnostics(id: string, active: boolean) {
  const client = useQueryClient();
  return useQuery({
    queryKey: ['telemetry-diagnostics', id],
    queryFn: async ({ signal }) => {
      try {
        return await fetchTelemetryDiagnostics(id, signal);
      } catch (error) {
        if (diagnosticAccessDenied(error)) {
          client.setQueryData(['telemetry-diagnostics', id], null);
          // A diagnostic denial revokes the same source as the surrounding detail.
          // Do not retain old spans, feedback controls or report links on a completed run.
          await client.cancelQueries({ queryKey: ['telemetry-run', id] });
          client.setQueryData(['telemetry-run', id], null);
        }
        throw error;
      }
    },
    enabled: Boolean(id), retry: false,
    refetchIntervalInBackground: false,
    refetchInterval: query => {
      if (diagnosticAccessDenied(query.state.error)) return false;
      const running = query.state.data?.tasks?.some(task => ['staged', 'queued', 'running', 'cancelling'].includes(task.state));
      const awaitingAcceptance = query.state.data?.tasks?.some(task => task.acceptance === 'pending');
      // A report publisher can run after the CLI and local parser have completed.
      // An absent publication outcome cannot establish that no further update will arrive.
      const awaitingPublication = query.state.data?.publication === 'pending'
        || query.state.data?.publication === 'unknown' && query.state.data.tasks.some(task => task.retained);
      return active || running || awaitingAcceptance || awaitingPublication ? 2_000 : false;
    },
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
