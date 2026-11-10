import type {
  TelemetryFilters, TelemetryIntegration, TelemetryRun, TelemetrySpan, TelemetryStatus,
} from '@shared/telemetry.interface';
import type { CouncilMember } from '@shared/council.interface';

export type TelemetryView = 'overview' | 'agents' | 'runs' | 'quality';
export const TELEMETRY_PAGE_SIZE = 12;
const STATUSES: TelemetryStatus[] = ['queued', 'running', 'completed', 'failed', 'cancelled', 'unknown'];

export function telemetryView(value: string | null): TelemetryView {
  return value === 'agents' || value === 'runs' || value === 'quality' ? value : 'overview';
}

export function telemetryFilters(params: URLSearchParams): TelemetryFilters {
  const status: string | null = params.get('status');
  const offset: number = Number(params.get('offset'));
  const filters: TelemetryFilters = {
    offset: Number.isSafeInteger(offset) && offset >= 0 ? offset : 0,
    limit: TELEMETRY_PAGE_SIZE,
  };
  for (const key of ['from', 'to'] as const) {
    const value: string | null = params.get(key);
    if (value && Number.isFinite(Date.parse(value))) filters[key] = new Date(value).toISOString();
  }
  for (const key of ['scene', 'agentId', 'executionMode', 'search'] as const) {
    const value: string | undefined = params.get(key)?.trim();
    if (value) filters[key] = value;
  }
  if (status && STATUSES.includes(status as TelemetryStatus)) filters.status = status as TelemetryStatus;
  return filters;
}

/** Filter changes reset the page; changing tabs or paging retains the current filter context. */
export function updateTelemetryParams(
  params: URLSearchParams, changes: Record<string, string | undefined>, resetPage = true,
): URLSearchParams {
  const next: URLSearchParams = new URLSearchParams(params);
  if (resetPage) next.delete('offset');
  for (const [key, value] of Object.entries(changes)) {
    if (value) next.set(key, value);
    else next.delete(key);
  }
  return next;
}

export function telemetryRunPath(id: string, params: URLSearchParams): string {
  const query: string = params.toString();
  return `/telemetry/runs/${encodeURIComponent(id)}${query ? `?${query}` : ''}`;
}

export function formatAmount(value: number | null, compact = false): string {
  if (value === null || !Number.isFinite(value)) return '—';
  return new Intl.NumberFormat('en', { notation: compact ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(value);
}
export function formatDuration(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  return `${(value / 1000).toFixed(1)} s`;
}
export function formatCost(value: number | null): string {
  return value === null || !Number.isFinite(value) ? '—' : `$${value.toFixed(2)}`;
}
export function formatRate(value: number | null): string {
  return value === null || !Number.isFinite(value) ? '—' : `${(value * 100).toFixed(1)}%`;
}
export function formatTime(value: string, language: string, dateOnly = false): string {
  const date: Date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '—';
  return date.toLocaleString(language, dateOnly
    ? { month: '2-digit', day: '2-digit' }
    : { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
}

/** Trend bucket keys are UTC calendar dates, not local timestamps. */
export function formatTrendDate(value: string, language: string): string {
  const date: Date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleDateString(language, { month: '2-digit', day: '2-digit', timeZone: 'UTC' }) : '—';
}

/** A trace URL is available only for a ready project, with no credentials embedded in its URL. */
export function langfuseLink(integration: TelemetryIntegration, traceId?: string | null): string | null {
  if (integration.status !== 'ready' || !integration.configured || !integration.projectUrl) return null;
  try {
    const url: URL = new URL(integration.projectUrl);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
    url.search = '';
    url.hash = '';
    const project: string = url.toString().replace(/\/$/u, '');
    return traceId ? `${project}/traces/${encodeURIComponent(traceId)}` : project;
  } catch {
    return null;
  }
}

export function spanGeometry(
  run: Pick<TelemetryRun, 'startedAt' | 'durationMs'>,
  span: Pick<TelemetrySpan, 'startedAt' | 'durationMs'>,
): { left: number; width: number; known: boolean } {
  const duration: number | null = run.durationMs;
  const start: number = Date.parse(span.startedAt) - Date.parse(run.startedAt);
  if (duration === null || duration <= 0 || span.durationMs === null || !Number.isFinite(start)) {
    return { left: 0, width: 0, known: false };
  }
  const left: number = Math.min(100, Math.max(0, start / duration * 100));
  return { left, width: Math.min(100 - left, Math.max(0, span.durationMs / duration * 100)), known: true };
}

/** Use only explicit role identities; unrecognized members retain the neutral moderator animal. */
export function telemetryAvatar(role: string): CouncilMember['avatar'] {
  const normalized: string = role.toLowerCase();
  if (/value|价值/u.test(normalized)) return 'value';
  if (/growth|成长/u.test(normalized)) return 'growth';
  if (/risk|challenge|风险|核查/u.test(normalized)) return 'risk';
  if (/technical|技术/u.test(normalized)) return 'technical';
  if (/macro|宏观/u.test(normalized)) return 'macro';
  if (/news|新闻/u.test(normalized)) return 'news';
  return 'moderator';
}
