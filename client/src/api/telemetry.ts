import http from './http';
import type { TelemetryDiagnostics } from '@shared/telemetry-diagnostics.interface';
import type {
  TelemetryFeedback, TelemetryFeedbackInput, TelemetryFilters,
  TelemetryRunDetail, TelemetryWorkspace,
} from '@shared/telemetry.interface';

/** Reading telemetry never dispatches research or model work. */
export async function fetchTelemetryWorkspace(filters: TelemetryFilters): Promise<TelemetryWorkspace> {
  return (await http.get<TelemetryWorkspace>('/api/telemetry/workspace', { params: filters })).data;
}

export async function fetchTelemetryRun(id: string): Promise<TelemetryRunDetail> {
  return (await http.get<TelemetryRunDetail>(`/api/telemetry/runs/${encodeURIComponent(id)}`)).data;
}

/** Every snapshot rechecks source visibility; aborting this read never stops execution. */
export async function fetchTelemetryDiagnostics(id: string, signal?: AbortSignal): Promise<TelemetryDiagnostics> {
  return (await http.get<TelemetryDiagnostics>(
    `/api/telemetry/runs/${encodeURIComponent(id)}/diagnostics`, { signal },
  )).data;
}

export async function saveTelemetryFeedback(
  id: string, input: TelemetryFeedbackInput,
): Promise<TelemetryFeedback> {
  return (await http.put<TelemetryFeedback>(
    `/api/telemetry/runs/${encodeURIComponent(id)}/feedback`, input,
  )).data;
}
