import { lookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import { request } from 'node:https';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';
import { BadRequestException } from '@nestjs/common';
export class DataLibraryError extends BadRequestException { constructor(readonly code: string) { super(code); } }
export type ResolvePublic = (host: string) => Promise<LookupAddress[]>;
const resolver: ResolvePublic = host => lookup(host, { all: true });
export const MAX_WEB_BYTES = 4 * 1024 * 1024;
export async function publicSourceUrl(input: string, resolve: ResolvePublic = resolver) {
  let url: URL;
  try { url = new URL(input); } catch { throw new DataLibraryError('INVALID_URL'); }
  const host = url.hostname.toLowerCase();
  if (input.length > 2000 || url.protocol !== 'https:' || url.username || url.password || url.hash
    || url.port && url.port !== '443' || !host.includes('.') || isIP(host) || host.includes(':')
    || /(?:^|\.)(?:localhost|local|internal|test|invalid|example)$/u.test(host)
    || [...url.searchParams.keys()].some(key => /token|secret|password|api.?key|authorization|session|cookie/i.test(key))) {
    throw new DataLibraryError('UNSAFE_URL');
  }
  let addresses: LookupAddress[];
  try { addresses = await resolve(host); } catch { throw new DataLibraryError('DNS_UNAVAILABLE'); }
  if (!addresses.length || addresses.some(a => !ipaddr.isValid(a.address) || ipaddr.parse(a.address).range() !== 'unicast')) {
    throw new DataLibraryError('PRIVATE_ADDRESS_BLOCKED');
  }
  return { url, addresses };
}
export interface LibraryHttpResponse { status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }
export type LibraryTransport = (url: URL, headers: Record<string, string>, addresses: LookupAddress[]) => Promise<LibraryHttpResponse>;
export const libraryTransport: LibraryTransport = (url, headers, addresses) => new Promise((resolve, reject) => {
  const req = request(url, { method: 'GET', headers, agent: false,
    lookup: (_host, options, callback) => {
      const family = options.family === 4 || options.family === 6 ? options.family : undefined;
      const eligible = addresses.filter(a => !family || a.family === family);
      if (!eligible.length) { callback(new Error('DNS_FAMILY_UNAVAILABLE'), ''); return; }
      if (options.all) callback(null, eligible); else callback(null, eligible[0].address, eligible[0].family);
    },
  }, response => {
    const chunks: Buffer[] = []; let size = 0;
    if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') {
      response.destroy(); reject(new DataLibraryError('UNSUPPORTED_ENCODING')); return;
    }
    response.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_WEB_BYTES) { response.destroy(); reject(new DataLibraryError('RESPONSE_TOO_LARGE')); }
      else chunks.push(chunk);
    });
    response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) }));
    response.on('error', () => reject(new DataLibraryError('NETWORK_ERROR')));
  });
  const timer = setTimeout(() => req.destroy(new DataLibraryError('TIMEOUT')), 15_000);
  req.on('close', () => clearTimeout(timer));
  req.on('error', e => reject(e instanceof DataLibraryError ? e : new DataLibraryError('NETWORK_ERROR')));
  req.end();
});
export async function fetchLibraryUrl(input: string, authorization: Record<string, string> = {},
  transport: LibraryTransport = libraryTransport, resolve: ResolvePublic = resolver) {
  let next = input; const origin = new URL(input).origin;
  for (let hop = 0; hop <= 3; hop++) {
    const { url, addresses } = await publicSourceUrl(next, resolve);
    if (Object.keys(authorization).length && url.origin !== origin) throw new DataLibraryError('AUTH_REDIRECT_BLOCKED');
    const response = await transport(url, { 'User-Agent': 'Squabble/2 DataLibrary', Accept: 'text/html, application/json, application/xml, text/plain',
      'Accept-Encoding': 'identity', ...authorization }, addresses);
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (hop === 3 || typeof response.headers.location !== 'string') throw new DataLibraryError('REDIRECT_LIMIT');
      next = new URL(response.headers.location, url).toString(); continue;
    }
    if (response.status === 401 || response.status === 403) throw new DataLibraryError('NEEDS_AUTH');
    if (response.status === 429) throw new DataLibraryError('RATE_LIMITED');
    if (response.status < 200 || response.status >= 300) throw new DataLibraryError('HTTP_ERROR');
    if (response.body.length > MAX_WEB_BYTES) throw new DataLibraryError('RESPONSE_TOO_LARGE');
    return { ...response, url: url.toString() };
  }
  throw new DataLibraryError('REDIRECT_LIMIT');
}
