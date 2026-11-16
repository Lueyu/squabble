/**
 * local-agents MCP 工具桥：为本任务临时启动一个无状态 Streamable HTTP
 * MCP 端点，把 Squabble 的只读研究工具暴露给 CLI 子进程。
 *
 * 职责边界：只做 HTTP/JSON-RPC 转发与安全约束（鉴权/白名单/限额）；工具
 * 的真实实现由调用方通过 NativeResearchTools.call 提供；不落盘任何配置。
 *
 * 上下游：import node:crypto/http/net 与 shared 的 research-tools 接口；
 * 被 research.ts 创建，token/url 经 tool-config.ts 注入 CLI。
 *
 * 关键约定：授权只在本任务生命周期内有效（token=randomBytes(32) base64url，
 * 常数时间比较）；只放行 readOnlyHint===true 且 destructiveHint===false 的
 * 工具，最多 32 个；限额——请求体 64KiB、结果 256KiB、并发调用 8、总请求
 * 512、总调用 128；服务端只绑 127.0.0.1 随机端口，Host/Origin 必须精确
 * 等于 authority（不做后缀匹配、不信任转发头）；调用结果按请求 id 缓存去重
 * （同 id 不同参数即 -32602），丢失的 HTTP 响应可重试且共享同一个在途结果。
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type {
  ResearchToolBundle,
  ResearchToolRequest,
  ResearchToolResult,
} from '../../shared/research-tools.interface';

export type NativeResearchTools = ResearchToolBundle & {
  call: (request: ResearchToolRequest, signal: AbortSignal) => Promise<ResearchToolResult>;
};
export interface ResearchToolBridge {
  url: string;
  token: string;
  close: () => Promise<void>;
}
// 限额常量：单位均为字节（*BYTES）或次数/并发数。
const MAX_REQUEST_BYTES: number = 64 * 1024;
const MAX_RESULT_BYTES: number = 256 * 1024;
const MAX_ACTIVE_CALLS: number = 8;
const MAX_REQUESTS: number = 512;
const MAX_CALLS: number = 128;

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
/** 统一 JSON 响应出口：连接已断/已结束时静默放弃。 */
function send(response: ServerResponse, status: number, body?: unknown): void {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(body === undefined ? '' : JSON.stringify(body));
}
/** 失败/取消的统一 ResearchToolResult：取消时附带上游可能仍在执行的说明。 */
function failure(code: string, cancelled: boolean = false): ResearchToolResult {
  return {
    status: cancelled ? 'cancelled' : 'failed',
    data: {
      message: code,
      ...(cancelled
        ? {
            completion:
              'The upstream request may still continue; its completion and any provider charge are unknown.',
          }
        : {}),
    },
    sources: [],
    asOf: new Date().toISOString(),
    truncated: false,
    errorCode: code,
  };
}

/**
 * 参数规范化序列化：对象键排序后递归序列化（数组保持顺序，嵌套最深 32 层），
 * 用于生成与键序无关的指纹。
 */
function canonical(value: unknown, depth: number = 0): string {
  if (depth > 32) throw new Error('Invalid tool arguments');
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item, depth + 1)).join(',')}]`;
  const record = object(value);
  if (record)
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key], depth + 1)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
interface CachedCall {
  fingerprint: string;
  result: Promise<ResearchToolResult>;
}

/** 无状态 Streamable HTTP MCP 端点，其授权只在本任务期间有效。 */
export async function createResearchToolBridge(
  tools: NativeResearchTools,
  signal: AbortSignal,
): Promise<ResearchToolBridge> {
  if (signal.aborted) throw new Error('NATIVE_AGENT_CANCELLED');
  // 工具白名单：名字合法 + 显式只读 + 非破坏性，最多 32 个。
  const descriptors = tools.descriptors
    .filter(
      (tool) =>
        /^[a-zA-Z0-9_-]{1,64}$/u.test(tool.name) &&
        tool.annotations.readOnlyHint === true &&
        tool.annotations.destructiveHint === false,
    )
    .slice(0, 32);
  const allowed: Set<string> = new Set(descriptors.map((tool) => tool.name));
  const token: string = randomBytes(32).toString('base64url');
  const expectedAuth: Buffer = Buffer.from(`Bearer ${token}`);
  const active: Map<string, AbortController> = new Map();
  const cache: Map<string, CachedCall> = new Map();
  let authority: string = '';
  let closed: boolean = false;
  let requests: number = 0;
  let closing: Promise<void> | undefined;
  // 处理函数抛出的异常统一收敛成 400，绝不让未处理拒绝击穿进程。
  const server = createServer((request, response) => {
    void handle(request, response).catch(() => send(response, 400));
  });
  // 激进的超时/连接上限：端点只服务一个 CLI 子进程的短暂会话。
  server.requestTimeout = 10_000;
  server.headersTimeout = 5000;
  server.keepAliveTimeout = 1000;
  server.maxConnections = 16;
  // 关闭流程：中断全部在途调用、清缓存、关服务器并断开所有连接（幂等）。
  const close = (): Promise<void> => {
    if (closing) return closing;
    closed = true;
    signal.removeEventListener('abort', cancel);
    for (const controller of active.values()) controller.abort();
    cache.clear();
    closing = new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    return closing;
  };
  const cancel = (): void => {
    void close();
  };

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (closed || signal.aborted) {
      send(response, 503);
      return;
    }
    // Host 与 Origin 是精确匹配的授权对象，绝不做后缀检查或信任转发头。
    if (
      request.headers.host !== authority ||
      (request.headers.origin !== undefined && request.headers.origin !== `http://${authority}`)
    ) {
      send(response, 403);
      return;
    }
    // Bearer token 常数时间比较：先比长度（timingSafeEqual 要求等长）。
    const auth: Buffer = Buffer.from(request.headers.authorization ?? '');
    if (auth.length !== expectedAuth.length || !timingSafeEqual(auth, expectedAuth)) {
      send(response, 401);
      return;
    }
    if (request.url !== '/mcp') {
      send(response, 404);
      return;
    }
    if (request.method !== 'POST') {
      send(response, 405);
      return;
    }
    if (++requests > MAX_REQUESTS) {
      send(response, 429);
      return;
    }
    if (!/^application\/json(?:\s*;|$)/iu.test(request.headers['content-type'] ?? '')) {
      send(response, 415);
      return;
    }
    // 请求体硬限 64KiB：边收边计，超限立即 413。
    const chunks: Buffer[] = [];
    let bytes: number = 0;
    for await (const chunk of request) {
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_REQUEST_BYTES) {
        send(response, 413);
        return;
      }
      chunks.push(Buffer.from(chunk));
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      send(response, 400);
      return;
    }
    const rpc = object(parsed);
    const id: unknown = rpc?.id;
    // JSON-RPC 错误也走 200 + error body（MCP 语义），id 回显原值。
    const error = (code: number, message: string): void =>
      send(response, 200, { jsonrpc: '2.0', id: id ?? null, error: { code, message } });
    if (
      !rpc ||
      rpc.jsonrpc !== '2.0' ||
      typeof rpc.method !== 'string' ||
      (id !== undefined &&
        !(typeof id === 'string' && id.length <= 160) &&
        !(typeof id === 'number' && Number.isSafeInteger(id)))
    ) {
      error(-32600, 'Invalid request');
      return;
    }
    const params = object(rpc.params) ?? {};
    if (rpc.method === 'notifications/cancelled') {
      active.get(JSON.stringify(params.requestId))?.abort();
      send(response, 202);
      return;
    }
    // 无 id 的通知类消息：确认收到即可，不产生结果。
    if (id === undefined) {
      send(response, 202);
      return;
    }
    const reply = (result: unknown): void => send(response, 200, { jsonrpc: '2.0', id, result });
    if (rpc.method === 'initialize') {
      // 协议版本协商：仅接受已知的三版，未知一律回落 2025-03-26。
      const version = ['2024-11-05', '2025-03-26', '2025-06-18'].includes(
        String(params.protocolVersion),
      )
        ? params.protocolVersion
        : '2025-03-26';
      reply({
        protocolVersion: version,
        capabilities: { tools: {} },
        serverInfo: { name: 'squabble-research', version: '1.0.0' },
      });
      return;
    }
    if (rpc.method === 'ping') {
      reply({});
      return;
    }
    if (rpc.method === 'tools/list') {
      reply({ tools: descriptors });
      return;
    }
    if (rpc.method !== 'tools/call') {
      error(-32601, 'Method not found');
      return;
    }
    // 工具必须在白名单内，arguments 若给出必须是对象。
    if (
      typeof params.name !== 'string' ||
      !allowed.has(params.name) ||
      (params.arguments !== undefined && !object(params.arguments))
    ) {
      error(-32602, 'Invalid tool request');
      return;
    }
    // 以请求 id 为缓存键、参数规范串为指纹：同 id 复用同一在途结果，
    // 同 id 但参数不同视为重放攻击直接拒绝。
    const key: string = JSON.stringify(id);
    let fingerprint: string;
    try {
      fingerprint = createHash('sha256')
        .update(canonical({ name: params.name, arguments: params.arguments ?? {} }))
        .digest('hex');
    } catch {
      error(-32602, 'Invalid tool arguments');
      return;
    }
    let entry: CachedCall | undefined = cache.get(key);
    if (entry && entry.fingerprint !== fingerprint) {
      error(-32602, 'Request ID already used');
      return;
    }
    if (!entry) {
      if (active.size >= MAX_ACTIVE_CALLS || cache.size >= MAX_CALLS) {
        error(-32000, 'Tool request limit');
        return;
      }
      entry = {
        fingerprint,
        result: performCall(key, params.name, object(params.arguments) ?? {}),
      };
      cache.set(key, entry);
    }
    const bounded: ResearchToolResult = await entry.result;
    reply({
      content: [{ type: 'text', text: JSON.stringify(bounded) }],
      structuredContent: bounded,
      isError: !['succeeded', 'partial'].includes(bounded.status),
    });
  }

  async function performCall(
    key: string,
    name: string,
    args: Record<string, unknown>,
  ): Promise<ResearchToolResult> {
    const controller: AbortController = new AbortController();
    active.set(key, controller);
    // HTTP 响应丢失是可重试的。只有任务取消、MCP 取消通知或这个 60s 截止
    // 会中断调用；重试共享同一个有界的在途结果（不重复执行工具）。
    const timer = setTimeout(() => controller.abort(), 60_000);
    let aborted: (() => void) | undefined;
    try {
      const cancellation = new Promise<ResearchToolResult>((resolve) => {
        aborted = () => resolve(failure('RESEARCH_TOOL_CANCELLED', true));
        controller.signal.addEventListener('abort', aborted, { once: true });
      });
      const result = await Promise.race([
        Promise.resolve()
          .then(() =>
            tools.call({ callId: randomUUID(), name, arguments: args }, controller.signal),
          )
          .catch(() => failure('RESEARCH_TOOL_FAILED')),
        cancellation,
      ]);
      const serialized: string = JSON.stringify(result);
      return Buffer.byteLength(serialized) > MAX_RESULT_BYTES
        ? failure('RESEARCH_TOOL_OUTPUT_LIMIT')
        : result;
    } catch {
      return failure('RESEARCH_TOOL_FAILED');
    } finally {
      clearTimeout(timer);
      if (aborted) controller.signal.removeEventListener('abort', aborted);
      active.delete(key);
    }
  }
  // 绑定 127.0.0.1 的随机端口；listen 成功前抛出的错误直接拒绝创建。
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  authority = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  signal.addEventListener('abort', cancel, { once: true });
  // 竞态兜底：listen 期间 signal 可能已触发，此时立即关闭并报取消。
  if (signal.aborted) {
    await close();
    throw new Error('NATIVE_AGENT_CANCELLED');
  }
  return { url: `http://${authority}/mcp`, token, close };
}
