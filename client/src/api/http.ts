/**
 * @file api/http.ts
 * @description First-party HTTP client for the Squabble backend.
 *
 * Account mode uses a localStorage-backed JWT session and refreshes expired
 * tokens. Local workspace mode leaves stored credentials untouched and makes
 * requests without a Bearer token or login redirects.
 *
 * Drop-in replacement for the retired platform `axiosForBackend`: call it
 * with `{ url, method, data }` and read `response.data`.
 */
import axios, { type AxiosInstance } from 'axios';
import { getAuthMode } from './auth-mode';

/** localStorage keys for the JWT session. */
export const ACCESS_TOKEN_KEY = 'sq-at';
export const REFRESH_TOKEN_KEY = 'sq-rt';

/** Token storage helpers shared with the auth pages. */
export const tokenStore = {
  getAccessToken(): string | null {
    return localStorage.getItem(ACCESS_TOKEN_KEY);
  },
  getRefreshToken(): string | null {
    return localStorage.getItem(REFRESH_TOKEN_KEY);
  },
  save(accessToken: string, refreshToken: string): void {
    localStorage.setItem(ACCESS_TOKEN_KEY, accessToken);
    localStorage.setItem(REFRESH_TOKEN_KEY, refreshToken);
  },
  clear(): void {
    localStorage.removeItem(ACCESS_TOKEN_KEY);
    localStorage.removeItem(REFRESH_TOKEN_KEY);
  },
};

/** Local workspaces need no session; account token validity is server-side. */
export function hasSession(): boolean {
  return getAuthMode() === 'local' || tokenStore.getAccessToken() !== null;
}

const http: AxiosInstance = axios.create({
  baseURL: '',
  timeout: 30000,
});

http.interceptors.request.use((config) => {
  if (getAuthMode() === 'local' || config.url === '/api/auth/mode') {
    config.headers.delete('Authorization');
  } else {
    const token = tokenStore.getAccessToken();
    if (token) config.headers.Authorization = `Bearer ${token}`;
  }
  // Tell the server which language the client is using (bilingual errors).
  const lang = localStorage.getItem('sq-lang') ?? 'zh-CN';
  config.headers['X-Lang'] = lang;
  return config;
});

/** Public auth endpoints: a 401 here is just "wrong credentials", not a
 * dead session — never clear the token or redirect for these. */
const PUBLIC_AUTH_PATHS = [
  '/api/auth/mode',
  '/api/auth/login',
  '/api/auth/register',
  '/api/auth/refresh',
  '/api/auth/recover',
];

let refreshPromise: Promise<{ accessToken: string; refreshToken: string }> | null = null;

function refreshSession(refreshToken: string) {
  if (!refreshPromise) {
    refreshPromise = http.post('/api/auth/refresh', { refreshToken })
      .then((response) => response.data as { accessToken: string; refreshToken: string })
      .finally(() => { refreshPromise = null; });
  }
  return refreshPromise;
}

http.interceptors.response.use(
  (response) => response,
  async (error) => {
    const status = error?.response?.status;
    const url: string = error?.config?.url ?? '';
    const isPublicAuth = PUBLIC_AUTH_PATHS.some((p) => url.includes(p));
    if (status === 401 && !isPublicAuth && getAuthMode() === 'account') {
      const retryConfig = error?.config;
      const refreshToken = tokenStore.getRefreshToken();
      if (refreshToken && retryConfig && !retryConfig._sessionRetried) {
        retryConfig._sessionRetried = true;
        try {
          const fresh = await refreshSession(refreshToken);
          tokenStore.save(fresh.accessToken, fresh.refreshToken);
          return http(retryConfig);
        } catch {
          // Invalid or revoked refresh token: clear the session below.
        }
      }
      // Session expired or token invalid (e.g. after a server rebuild or
      // database reset): drop the stale session and send the user to the
      // login page. /api/auth/me IS covered here so a stale token can
      // never trap the app in a redirect loop.
      tokenStore.clear();
      if (!window.location.pathname.startsWith('/login')) {
        window.location.assign('/login');
      }
    }
    return Promise.reject(error);
  },
);

export default http;
