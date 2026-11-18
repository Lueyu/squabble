import { getAuthMode } from '@/api/auth-mode';

/** Used only to partition browser caches. All commands still use server-side owner checks. */
export function workspaceOwnerScope(): string | null {
  if (getAuthMode() === 'local') return 'local';
  try {
    const token = window.localStorage.getItem('sq-at');
    const payload = token && JSON.parse(window.atob(token.split('.')[1].replace(/-/gu, '+').replace(/_/gu, '/')));
    return typeof payload?.sub === 'string' && payload.sub ? `account:${payload.sub}` : null;
  } catch { return null; }
}

function recoveryKey(operation: string): string | null {
  const owner = workspaceOwnerScope();
  return owner ? `squabble.recovery.${encodeURIComponent(owner)}.${operation}` : null;
}

export function readTabRecovery(operation: string): unknown {
  try {
    const key = recoveryKey(operation);
    return key ? JSON.parse(window.sessionStorage.getItem(key) ?? 'null') : null;
  } catch { return null; }
}

export function writeTabRecovery(operation: string, value: unknown): boolean {
  try {
    const key = recoveryKey(operation);
    if (!key) return false;
    if (value === null) window.sessionStorage.removeItem(key);
    else window.sessionStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch { return false; }
}
