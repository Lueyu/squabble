import type { ApiErrorResponse } from '../interfaces/api_response.interface';

type SafeTeamError = Pick<ApiErrorResponse['error'], 'code' | 'message' | 'actualRevision' | 'field' | 'roleId' | 'relationId' | 'retryable' | 'fieldErrors'>;
const FIELD = /^[A-Za-z][A-Za-z0-9_.\[\]-]{0,127}$/u;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;
function teamCode(value: unknown): string | null {
  return typeof value === 'string' && value.length <= 96 && /^TEAM_[A-Z0-9_]+$/u.test(value) ? value : null;
}

/** Only this domain's bounded wire metadata may leave the HTTP boundary. Raw exception objects never become details. */
export function safeTeamErrorResponse(value: unknown): SafeTeamError | null {
  const body = value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
  const code = teamCode(body?.code) ?? teamCode(body?.message) ?? teamCode(value);
  if (!code) return null;
  const result: SafeTeamError = { code, message: typeof body?.message === 'string' ? body.message.slice(0, 1000) : code };
  if (Number.isSafeInteger(body?.actualRevision) && Number(body.actualRevision) >= 0) result.actualRevision = Number(body.actualRevision);
  if (typeof body?.field === 'string' && FIELD.test(body.field)) result.field = body.field;
  if (typeof body?.roleId === 'string' && UUID.test(body.roleId)) result.roleId = body.roleId;
  if (typeof body?.relationId === 'string' && UUID.test(body.relationId)) result.relationId = body.relationId;
  if (typeof body?.retryable === 'boolean') result.retryable = body.retryable;
  if (body?.fieldErrors !== null && typeof body?.fieldErrors === 'object' && !Array.isArray(body.fieldErrors)) {
    const errors: Record<string, string[]> = {};
    for (const [field, messages] of Object.entries(body.fieldErrors).slice(0, 30)) {
      if (!FIELD.test(field) || !Array.isArray(messages) || !messages.every(message => typeof message === 'string')) continue;
      errors[field] = messages.slice(0, 10).map((message: string) => message.slice(0, 300));
    }
    if (Object.keys(errors).length) result.fieldErrors = errors;
  }
  return result;
}

/** Preserve standard Nest 4xx diagnostics, without forwarding custom request/provider payloads. */
export function safeStandardHttpDetails(value: unknown, status: number): string | undefined {
  if (status < 400 || status >= 500 || !value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const body = value as Record<string, unknown>;
  const details: { statusCode?: number; error?: string; message?: string | string[] } = {};
  if (body.statusCode === status) details.statusCode = status;
  if (typeof body.error === 'string' && ['Bad Request', 'Unauthorized', 'Forbidden', 'Not Found', 'Conflict',
    'Unprocessable Entity', 'Too Many Requests', 'Method Not Allowed', 'Payload Too Large'].includes(body.error)) details.error = body.error;
  if (typeof body.message === 'string') details.message = body.message.slice(0, 1000);
  else if (Array.isArray(body.message) && body.message.every(message => typeof message === 'string'))
    details.message = body.message.slice(0, 20).map((message: string) => message.slice(0, 300));
  return Object.keys(details).length ? JSON.stringify(details) : undefined;
}
