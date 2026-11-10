import { randomBytes, timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import { createServer, type Server, type IncomingMessage } from 'node:http';
import { connect as netConnect, type AddressInfo, type Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import type { Duplex } from 'node:stream';
import { publicSourceUrl, type ResolvePublic } from '../data-library.fetch';
import { BrowserSourceError } from './browser-source.types';

export type PublicTunnelConnector = (
  address: LookupAddress, port: number, signal: AbortSignal,
) => Promise<Duplex>;

export interface BrowserEgressOptions {
  resolve?: ResolvePublic;
  connect?: PublicTunnelConnector;
  upstream?: URL;
  maxBytes?: number;
  maxConnects?: number;
}

/** The upstream is trusted private configuration; destinations always remain pinned public IPs. */
export async function connectPublicTunnel(
  address: LookupAddress, port: number, signal: AbortSignal, upstream?: URL,
): Promise<Duplex> {
  if (signal.aborted) throw new BrowserSourceError('CANCELLED');
  if (upstream && !['http:', 'https:'].includes(upstream.protocol)) {
    throw new BrowserSourceError('UNAVAILABLE');
  }
  let upstreamAuthorization = '';
  if (upstream?.username || upstream?.password) {
    try {
      const credentials = `${decodeURIComponent(upstream.username)}:${decodeURIComponent(upstream.password)}`;
      upstreamAuthorization = `Proxy-Authorization: Basic ${Buffer.from(credentials).toString('base64')}\r\n`;
    } catch { throw new BrowserSourceError('UNAVAILABLE'); }
  }
  return new Promise<Duplex>((resolve, reject) => {
    let settled = false;
    const options = upstream
      ? { host: upstream.hostname, port: Number(upstream.port || (upstream.protocol === 'https:' ? 443 : 80)) }
      : { host: address.address, port, family: address.family };
    const socket = upstream?.protocol === 'https:'
      ? tlsConnect({ ...options, servername: upstream.hostname, rejectUnauthorized: true })
      : netConnect(options);
    const fail = (): void => {
      if (!settled) { settled = true; reject(new BrowserSourceError(signal.aborted ? 'CANCELLED' : 'NETWORK_ERROR')); }
      socket.destroy();
    };
    const timer = setTimeout(fail, 10_000);
    const abort = (): void => fail();
    signal.addEventListener('abort', abort, { once: true });
    socket.once('close', () => { clearTimeout(timer); signal.removeEventListener('abort', abort); });
    socket.on('error', fail);
    const ready = (): void => {
      clearTimeout(timer);
      if (signal.aborted) { fail(); return; }
      settled = true;
      resolve(socket);
    };
    socket.once(upstream?.protocol === 'https:' ? 'secureConnect' : 'connect', () => {
      if (!upstream) { ready(); return; }
      const authority = `${address.family === 6 ? `[${address.address}]` : address.address}:${port}`;
      socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${upstreamAuthorization}\r\n`);
      let response = Buffer.alloc(0);
      const receive = (chunk: Buffer): void => {
        response = Buffer.concat([response, chunk]);
        if (response.length > 8192) { fail(); return; }
        const end = response.indexOf('\r\n\r\n');
        if (end < 0) return;
        socket.removeListener('data', receive);
        if (!/^HTTP\/1[.][01] 200(?: |\r)/u.test(response.subarray(0, end).toString('ascii'))) {
          fail(); return;
        }
        const remaining = response.subarray(end + 4);
        if (remaining.length) socket.unshift(remaining);
        ready();
      };
      socket.on('data', receive);
    });
  });
}

/** One short-lived authenticated proxy per browser operation; no request may bypass DNS validation. */
export class BrowserEgressProxy {
  readonly username = randomBytes(18).toString('hex');
  readonly password = randomBytes(32).toString('hex');
  private readonly controller = new AbortController();
  private readonly sockets = new Set<Duplex>();
  private readonly server: Server;
  private bytes = 0;
  private connects = 0;
  private closing?: Promise<void>;
  failure?: BrowserSourceError;
  port = 0;

  private constructor(private readonly options: BrowserEgressOptions) {
    this.server = createServer((_request, response) => { response.writeHead(403); response.end(); });
    this.server.on('connection', socket => this.track(socket));
    this.server.on('connect', (request, socket, head) => { void this.tunnel(request, socket, head); });
    this.server.on('clientError', (_error, socket) => socket.destroy());
  }

  static async create(options: BrowserEgressOptions = {}): Promise<BrowserEgressProxy> {
    const proxy = new BrowserEgressProxy(options);
    await new Promise<void>((resolve, reject) => {
      proxy.server.once('error', reject);
      proxy.server.listen(0, '127.0.0.1', () => {
        proxy.server.removeListener('error', reject);
        proxy.port = (proxy.server.address() as AddressInfo).port;
        resolve();
      });
    });
    return proxy;
  }

  private track(socket: Duplex): void {
    this.sockets.add(socket);
    socket.on('error', () => socket.destroy());
    socket.once('close', () => this.sockets.delete(socket));
  }

  private authorized(request: IncomingMessage): boolean {
    const expected = Buffer.from(`Basic ${Buffer.from(`${this.username}:${this.password}`).toString('base64')}`);
    const actual = Buffer.from(request.headers['proxy-authorization'] ?? '');
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  private async tunnel(request: IncomingMessage, client: Duplex, head: Buffer): Promise<void> {
    if (!this.authorized(request)) {
      client.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="Squabble"\r\n\r\n');
      return;
    }
    if (this.failure || this.controller.signal.aborted) { client.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
    this.connects++;
    if (this.connects > (this.options.maxConnects ?? 160)) {
      this.failure = new BrowserSourceError('BLOCKED');
      client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    let validated = false;
    try {
      const authority = request.url ?? '';
      if (!/^[a-z0-9.-]+:443$/iu.test(authority)) throw new BrowserSourceError('BLOCKED');
      const { addresses } = await publicSourceUrl(`https://${authority}/`, this.options.resolve
        ?? (host => lookup(host, { all: true })));
      validated = true;
      if (this.controller.signal.aborted) throw new BrowserSourceError('CANCELLED');
      const connector = this.options.connect ?? ((address, port, signal) =>
        connectPublicTunnel(address, port, signal, this.options.upstream));
      const upstream = await connector(addresses[0], 443, this.controller.signal);
      this.track(upstream);
      if (this.controller.signal.aborted || client.destroyed) { upstream.destroy(); return; }
      upstream.on('data', (chunk: Buffer) => {
        this.bytes += chunk.length;
        if (this.bytes > (this.options.maxBytes ?? 16 * 1024 * 1024)) {
          this.failure = new BrowserSourceError('RESPONSE_TOO_LARGE');
          void this.close();
        }
      });
      client.once('close', () => upstream.destroy());
      upstream.once('close', () => client.destroy());
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    } catch {
      if (!validated && !this.controller.signal.aborted) this.failure ??= new BrowserSourceError('BLOCKED');
      if (!client.destroyed) client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    }
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.controller.abort();
    for (const socket of this.sockets) socket.destroy();
    this.closing = new Promise<void>(resolve => this.server.close(() => resolve()));
    return this.closing;
  }
}
