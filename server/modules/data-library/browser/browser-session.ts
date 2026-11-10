import type { BrowserContext } from 'playwright-core';
import { BrowserSourceError } from './browser-source.types';

type BrowserStorageState = Awaited<ReturnType<BrowserContext['storageState']>>;

/** OAuth intermediaries may be visited, but their independent sessions must never be persisted or restored. */
export function sourceBrowserStorageState(state: BrowserStorageState, source: URL): BrowserStorageState {
  const hostname = source.hostname.toLowerCase();
  return {
    cookies: state.cookies.filter(cookie => {
      const domain = cookie.domain.toLowerCase();
      if (!domain.startsWith('.')) return hostname === domain;
      const parent = domain.slice(1);
      return Boolean(parent) && (hostname === parent || hostname.endsWith(`.${parent}`));
    }),
    origins: state.origins.filter(origin => origin.origin === source.origin),
  };
}

export function restoreSourceBrowserStorageState(input: string | undefined, source: URL): BrowserStorageState | undefined {
  if (!input) return undefined;
  if (input.length > 2 * 1024 * 1024) throw new BrowserSourceError('NEEDS_AUTH');
  let parsed: unknown;
  try { parsed = JSON.parse(input); } catch { throw new BrowserSourceError('NEEDS_AUTH'); }
  if (!parsed || typeof parsed !== 'object' || !('cookies' in parsed) || !Array.isArray(parsed.cookies)
    || !('origins' in parsed) || !Array.isArray(parsed.origins)
    || parsed.cookies.some(cookie => !cookie || typeof cookie.domain !== 'string')
    || parsed.origins.some(origin => !origin || typeof origin.origin !== 'string')) {
    throw new BrowserSourceError('NEEDS_AUTH');
  }
  return sourceBrowserStorageState(parsed as BrowserStorageState, source);
}

export function assertSourceBrowserOrigin(url: string, source: URL): void {
  let target: URL;
  try { target = new URL(url); } catch { throw new BrowserSourceError('BLOCKED'); }
  if (target.origin !== source.origin) throw new BrowserSourceError('BLOCKED');
}
