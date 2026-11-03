import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ResearchToolBundle, ResearchToolRequest, ResearchToolResult } from '../../shared/research-tools.interface';

export type NativeResearchTools = ResearchToolBundle & {
  call: (request: ResearchToolRequest, signal: AbortSignal) => Promise<ResearchToolResult>;
};
export interface ResearchToolBridge { url: string; token: string; close: () => Promise<void> }
const MAX_REQUEST_BYTES: number = 64 * 1024;
const MAX_RESULT_BYTES: number = 256 * 1024;
const MAX_ACTIVE_CALLS: number = 8;
const MAX_REQUESTS: number = 512;
const MAX_CALLS: number = 128;

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function send(response: ServerResponse, status: number, body?: unknown): void {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  response.end(body === undefined ? '' : JSON.stringify(body));
}
function failure(code: string, cancelled: boolean = false): ResearchToolResult {
  return { status: cancelled ? 'cancelled' : 'failed', data: { message: code,
    ...(cancelled ? { completion: 'The upstream request may still continue; its completion and any provider charge are unknown.' } : {}) },
  sources: [], asOf: new Date().toISOString(), truncated: false, errorCode: code };
}

function canonical(value: unknown, depth: number = 0): string {
  if (depth > 32) throw new Error('Invalid tool arguments');
  if (Array.isArray(value)) return `[${value.map(item => canonical(item, depth + 1)).join(',')}]`;
  const record = object(value);
  if (record) return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key], depth + 1)}`).join(',')}}`;
  return JSON.stringify(value);
}
interface CachedCall { fingerprint: string; result: Promise<ResearchToolResult> }

/** A stateless Streamable HTTP MCP endpoint whose authority lasts only for this task. */
export async function createResearchToolBridge(tools: NativeResearchTools, signal: AbortSignal): Promise<ResearchToolBridge> {
  if (signal.aborted) throw new Error('NATIVE_AGENT_CANCELLED');
  const descriptors = tools.descriptors.filter(tool => /^[a-zA-Z0-9_-]{1,64}$/u.test(tool.name)
    && tool.annotations.readOnlyHint === true && tool.annotations.destructiveHint === false).slice(0, 32);
  const allowed: Set<string> = new Set(descriptors.map(tool => tool.name));
  const token: string = randomBytes(32).toString('base64url');
  const expectedAuth: Buffer = Buffer.from(`Bearer ${token}`);
  const active: Map<string, AbortController> = new Map();
  const cache: Map<string, CachedCall> = new Map();
  let authority: string = '';
  let closed: boolean = false;
  let requests: number = 0;
  let closing: Promise<void> | undefined;
  const server = createServer((request, response) => { void handle(request, response).catch(() => send(response, 400)); });
  server.requestTimeout = 10_000;
  server.headersTimeout = 5000;
  server.keepAliveTimeout = 1000;
  server.maxConnections = 16;
  const close = (): Promise<void> => {
    if (closing) return closing;
    closed = true;
    signal.removeEventListener('abort', cancel);
    for (const controller of active.values()) controller.abort();
    cache.clear();
    closing = new Promise<void>(resolve => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    return closing;
  };
  const cancel = (): void => { void close(); };

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (closed || signal.aborted) { send(response, 503); return; }
    // Host and Origin are exact authorities, never suffix checks or forwarded headers.
    if (request.headers.host !== authority || (request.headers.origin !== undefined && request.headers.origin !== `http://${authority}`)) {
      send(response, 403); return;
    }
    const auth: Buffer = Buffer.from(request.headers.authorization ?? '');
    if (auth.length !== expectedAuth.length || !timingSafeEqual(auth, expectedAuth)) { send(response, 401); return; }
    if (request.url !== '/mcp') { send(response, 404); return; }
    if (request.method !== 'POST') { send(response, 405); return; }
    if (++requests > MAX_REQUESTS) { send(response, 429); return; }
    if (!/^application\/json(?:\s*;|$)/iu.test(request.headers['content-type'] ?? '')) { send(response, 415); return; }
    const chunks: Buffer[] = [];
    let bytes: number = 0;
    for await (const chunk of request) {
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_REQUEST_BYTES) { send(response, 413); return; }
      chunks.push(Buffer.from(chunk));
    }
    let parsed: unknown;
    try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { send(response, 400); return; }
    const rpc = object(parsed);
    const id: unknown = rpc?.id;
    const error = (code: number, message: string): void => send(response, 200, { jsonrpc: '2.0', id: id ?? null, error: { code, message } });
    if (!rpc || rpc.jsonrpc !== '2.0' || typeof rpc.method !== 'string'
      || (id !== undefined && !(typeof id === 'string' && id.length <= 160) && !(typeof id === 'number' && Number.isSafeInteger(id)))) {
      error(-32600, 'Invalid request'); return;
    }
    const params = object(rpc.params) ?? {};
    if (rpc.method === 'notifications/cancelled') {
      active.get(JSON.stringify(params.requestId))?.abort(); send(response, 202); return;
    }
    if (id === undefined) { send(response, 202); return; }
    const reply = (result: unknown): void => send(response, 200, { jsonrpc: '2.0', id, result });
    if (rpc.method === 'initialize') {
      const version = ['2024-11-05', '2025-03-26', '2025-06-18'].includes(String(params.protocolVersion)) ? params.protocolVersion : '2025-03-26';
      reply({ protocolVersion: version, capabilities: { tools: {} }, serverInfo: { name: 'squabble-research', version: '1.0.0' } }); return;
    }
    if (rpc.method === 'ping') { reply({}); return; }
    if (rpc.method === 'tools/list') { reply({ tools: descriptors }); return; }
    if (rpc.method !== 'tools/call') { error(-32601, 'Method not found'); return; }
    if (typeof params.name !== 'string' || !allowed.has(params.name) || (params.arguments !== undefined && !object(params.arguments))) {
      error(-32602, 'Invalid tool request'); return;
    }
    const key: string = JSON.stringify(id);
    let fingerprint: string;
    try { fingerprint = createHash('sha256').update(canonical({ name: params.name, arguments: params.arguments ?? {} })).digest('hex'); }
    catch { error(-32602, 'Invalid tool arguments'); return; }
    let entry: CachedCall | undefined = cache.get(key);
    if (entry && entry.fingerprint !== fingerprint) { error(-32602, 'Request ID already used'); return; }
    if (!entry) {
      if (active.size >= MAX_ACTIVE_CALLS || cache.size >= MAX_CALLS) { error(-32000, 'Tool request limit'); return; }
      entry = { fingerprint, result: performCall(key, params.name, object(params.arguments) ?? {}) };
      cache.set(key, entry);
    }
    const bounded: ResearchToolResult = await entry.result;
    reply({ content: [{ type: 'text', text: JSON.stringify(bounded) }], structuredContent: bounded,
      isError: !['succeeded', 'partial'].includes(bounded.status) });
  }

  async function performCall(key: string, name: string, args: Record<string, unknown>): Promise<ResearchToolResult> {
    const controller: AbortController = new AbortController();
    active.set(key, controller);
    // A lost HTTP response is retryable. Only task cancellation, MCP cancellation or
    // this deadline aborts a call; retries share the same bounded in-flight result.
    const timer = setTimeout(() => controller.abort(), 60_000);
    let aborted: (() => void) | undefined;
    try {
      const cancellation = new Promise<ResearchToolResult>(resolve => {
        aborted = () => resolve(failure('RESEARCH_TOOL_CANCELLED', true));
        controller.signal.addEventListener('abort', aborted, { once: true });
      });
      const result = await Promise.race([
        Promise.resolve().then(() => tools.call({ callId: randomUUID(), name, arguments: args }, controller.signal))
          .catch(() => failure('RESEARCH_TOOL_FAILED')),
        cancellation,
      ]);
      const serialized: string = JSON.stringify(result);
      return Buffer.byteLength(serialized) > MAX_RESULT_BYTES ? failure('RESEARCH_TOOL_OUTPUT_LIMIT') : result;
    } catch {
      return failure('RESEARCH_TOOL_FAILED');
    } finally {
      clearTimeout(timer); if (aborted) controller.signal.removeEventListener('abort', aborted);
      active.delete(key);
    }
  }
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  authority = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) { await close(); throw new Error('NATIVE_AGENT_CANCELLED'); }
  return { url: `http://${authority}/mcp`, token, close };
}
