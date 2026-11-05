import type { IncomingMessage, ServerResponse } from 'node:http';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function authMode(env: NodeJS.ProcessEnv = process.env): 'local' | 'account' {
  const mode = env.AUTH_MODE?.trim() || 'account';
  if (mode !== 'local' && mode !== 'account') throw new Error('AUTH_MODE must be local or account');
  return mode;
}

export function isLocalWorkspaceMode(): boolean { return authMode() === 'local'; }

function appOrigins(env: NodeJS.ProcessEnv): URL[] {
  return (env.LOCAL_APP_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean).map(value => {
    let url: URL;
    try { url = new URL(value); } catch { throw new Error('LOCAL_APP_ORIGINS must contain loopback HTTP origins'); }
    if (url.protocol !== 'http:' || !LOOPBACK_HOSTS.has(url.hostname) || url.origin !== value) {
      throw new Error('LOCAL_APP_ORIGINS must contain loopback HTTP origins without paths or credentials');
    }
    return url;
  });
}

export function validateLocalWorkspaceConfig(env: NodeJS.ProcessEnv = process.env): void {
  if (authMode(env) !== 'local') return;
  if (!['localhost', '127.0.0.1', '::1'].includes(env.SERVER_HOST || '')) {
    throw new Error('AUTH_MODE=local requires a loopback SERVER_HOST');
  }
  if (env.TRUST_PROXY === 'true') throw new Error('AUTH_MODE=local cannot enable TRUST_PROXY');
  const port = Number(env.SERVER_PORT || '3000');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid local SERVER_PORT');
  appOrigins(env);
}

/** Native local access is a device capability, never a remotely trusted header. */
export function localWorkspaceRequestGuard(env: NodeJS.ProcessEnv = process.env) {
  validateLocalWorkspaceConfig(env);
  const port = env.SERVER_PORT || '3000';
  const origins = new Set([...LOOPBACK_HOSTS].map(host => new URL(`http://${host}:${port}`).origin));
  for (const origin of appOrigins(env)) origins.add(origin.origin);
  const hosts = new Set([...origins].map(origin => new URL(origin).host));
  return (request: IncomingMessage, response: ServerResponse, next: () => void): void => {
    const origin = request.headers.origin;
    const site = request.headers['sec-fetch-site'];
    if (!LOOPBACK_ADDRESSES.has(request.socket.remoteAddress || '')
      || !hosts.has(request.headers.host || '')
      || (origin !== undefined && !origins.has(origin))
      || (site !== undefined && site !== 'same-origin' && site !== 'none')) {
      response.statusCode = 403;
      response.end('Local workspace access is limited to this computer');
      return;
    }
    next();
  };
}
