import { Injectable } from '@nestjs/common';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { normalizePublicLlmBaseUrl, publicHttpsAgent } from '../settings/settings-security';

export interface RegisteredToolService { id: string; endpoint: string }

/** A cancelled Web body must stop its HTTP source before a pending read can publish. */
function boundedResponseBody(response: IncomingMessage, maxBytes: number): ReadableStream<Uint8Array> {
  const input = response[Symbol.asyncIterator]();
  let bytes = 0, closed = false;
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const fail = (error: Error) => {
    if (closed) return;
    closed = true;
    controller.error(error);
    response.destroy();
  };
  const aborted = () => fail(new Error('TOOL_NETWORK_ERROR'));
  // Keep an error listener until HTTP close, including cancellation before the first pull.
  response.on('error', fail);
  response.once('aborted', aborted);
  response.once('close', () => {
    if (!response.complete) aborted();
    response.off('error', fail);
    response.off('aborted', aborted);
  });
  return new ReadableStream<Uint8Array>({
    start(value) { controller = value; },
    async pull() {
      if (closed) return;
      try {
        const next = await input.next();
        // Cancellation can close the controller while the HTTP read is pending.
        if (closed) return;
        if (next.done) { closed = true; controller.close(); return; }
        const chunk = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value);
        bytes += chunk.length;
        if (bytes > maxBytes) { fail(new Error('TOOL_OUTPUT_LIMIT')); return; }
        controller.enqueue(chunk);
      } catch (error) { fail(error instanceof Error ? error : new Error('TOOL_NETWORK_ERROR')); }
    },
    cancel() {
      if (closed) return;
      closed = true;
      response.destroy();
    },
  });
}

/** Private endpoints are deployment configuration, never an owner supplied exception. */
export function registeredToolServices(): RegisteredToolService[] {
  if (!process.env.TOOL_MCP_LOCAL_SERVICES_JSON) return [];
  const value: unknown = JSON.parse(process.env.TOOL_MCP_LOCAL_SERVICES_JSON);
  if (!Array.isArray(value) || value.length > 20) throw new Error('INVALID_TOOL_SERVICE_REGISTRY');
  return value.map((item: unknown) => {
    if (!item || typeof item !== 'object' || !('id' in item) || !('endpoint' in item)
      || typeof item.id !== 'string' || typeof item.endpoint !== 'string') throw new Error('INVALID_TOOL_SERVICE_REGISTRY');
    const url = new URL(item.endpoint);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error('INVALID_TOOL_SERVICE_REGISTRY');
    }
    return { id: item.id, endpoint: url.href };
  });
}

@Injectable()
export class ToolTransportPolicy {
  private readonly services: RegisteredToolService[];
  constructor(services: RegisteredToolService[] = registeredToolServices()) { this.services = services; }

  async normalizeEndpoint(input: string): Promise<string> {
    let url: URL;
    try { url = new URL(input); } catch { throw new Error('ENDPOINT_RESTRICTED'); }
    if (url.username || url.password || url.search || url.hash || url.href.length > 500) throw new Error('ENDPOINT_RESTRICTED');
    if (this.services.some(service => service.endpoint === url.href)) return url.href;
    try { await normalizePublicLlmBaseUrl(url.href); return url.href; }
    catch { throw new Error('ENDPOINT_RESTRICTED'); }
  }

  /** HTTP implementation pins DNS at socket connection and never follows redirects. */
  async fetch(input: string | URL, init: RequestInit = {}, exactEndpoint?: string, maxBytes = 2_000_000): Promise<Response> {
    const target = new URL(String(input));
    if (exactEndpoint && target.href !== new URL(exactEndpoint).href) throw new Error('ENDPOINT_RESTRICTED');
    const validationTarget = new URL(target.href);
    if (exactEndpoint) validationTarget.search = '';
    const endpoint = await this.normalizeEndpoint(validationTarget.href);
    const local = this.services.some(service => service.endpoint === endpoint);
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const body = init.body;
    if (body != null && typeof body !== 'string') throw new Error('REQUEST_BODY_RESTRICTED');
    return new Promise<Response>((resolve, reject) => {
      const request = (target.protocol === 'https:' ? httpsRequest : httpRequest)(target, {
        method: init.method ?? 'GET', headers, signal: init.signal ?? undefined,
        agent: target.protocol === 'https:' && !local ? publicHttpsAgent() : undefined,
      }, response => {
        if ((response.statusCode ?? 500) >= 300 && (response.statusCode ?? 500) < 400) {
          response.destroy(); reject(new Error('REDIRECT_RESTRICTED')); return;
        }
        const responseHeaders = new Headers();
        for (const [key, value] of Object.entries(response.headers)) {
          if (value !== undefined) responseHeaders.set(key, Array.isArray(value) ? value.join(', ') : value);
        }
        const status = response.statusCode ?? 500;
        if (status === 204 || status === 205 || init.method === 'HEAD') {
          let bytes = 0;
          response.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > maxBytes) response.destroy(); });
          response.on('error', reject);
          response.resume(); resolve(new Response(null, { status, headers: responseHeaders }));
        } else {
          resolve(new Response(boundedResponseBody(response, maxBytes), { status, headers: responseHeaders }));
        }
      });
      request.setTimeout(30_000, () => request.destroy(new Error('TOOL_NETWORK_TIMEOUT')));
      request.on('error', () => reject(new Error(init.signal?.aborted ? 'TOOL_CANCELLED_UNKNOWN' : 'TOOL_NETWORK_ERROR')));
      request.end(body ?? undefined);
    });
  }
}
