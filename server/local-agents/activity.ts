/**
 * local-agents 活动事件采集器：把各 CLI 的原生事件流归一成对外的
 * ResearchActivity（阶段摘要 + 工具调用起止）。
 *
 * 职责边界：只读公开协议元数据（事件类型、工具名白名单映射），绝不转发
 * provider 提供的正文/参数/原始错误；Squabble 自有 MCP 工具（本桥）一律
 * 不对外播报。
 *
 * 上下游：import node:crypto、shared 接口与 metadata 的 object；
 * 被 events.ts、doubao.ts、research.ts 组合使用。
 *
 * 关键约定：事件上限 256 条（超出静默丢弃）、单事件 id 去重；工具调用 id
 * 只接受 <= 512 字符的字符串并做 sha256 前 20 位哈希化（callId 不外泄原值）；
 * 未知工具名一律丢弃——它们可能携带参数或凭据，绝不合成工具名或生命周期。
 */
import { createHash } from 'node:crypto';
import type { LocalAgentProvider } from '../../shared/local-agents.interface';
import type { ResearchActivity, ResearchEventStatus } from '../../shared/research-events.interface';
import { object, type JsonObject } from './metadata';

/** 各 CLI 的工具名 -> 对外统一工具名（白名单；表外名字一律不播报）。 */
const PUBLIC_TOOLS: Record<string, string> = {
  web_search: 'web_search',
  WebSearch: 'web_search',
  google_web_search: 'web_search',
  search_web: 'web_search',
  websearch: 'web_search',
  WebFetch: 'web_fetch',
  web_fetch: 'web_fetch',
  webfetch: 'web_fetch',
  read_url_content: 'web_fetch',
  Read: 'read_file',
  read_file: 'read_file',
  read_many_files: 'read_file',
  view_file: 'read_file',
  read: 'read_file',
  Glob: 'find_files',
  glob: 'find_files',
  find_by_name: 'find_files',
  Grep: 'search_files',
  grep: 'search_files',
  grep_search: 'search_files',
  list_directory: 'list_directory',
  list_dir: 'list_directory',
  command_execution: 'shell',
  Bash: 'shell',
};

/** 只使用公开协议元数据的白名单。绝不转发 provider 提供的正文或参数。 */
export class NativeActivityCollector {
  private readonly emitted: Set<string> = new Set();
  private readonly calls: Map<string, { name: string; at: number }> = new Map();
  constructor(
    private readonly provider: LocalAgentProvider,
    private readonly onEvent?: (event: ResearchActivity) => void,
  ) {}

  /** 阶段级摘要事件：started/completed/ended 等粗粒度节点。 */
  private phase(key: string, status: ResearchEventStatus, summary: string): void {
    this.emit({
      id: `${this.provider}-phase-${key}`,
      kind: 'summary',
      status,
      at: new Date().toISOString(),
      summary,
    });
  }
  /** 统一出口：无订阅者、id 已发过、或总量到 256 上限即丢弃。 */
  private emit(event: ResearchActivity): void {
    if (!this.onEvent || this.emitted.has(event.id) || this.emitted.size >= 256) return;
    this.emitted.add(event.id);
    this.onEvent(event);
  }
  private tool(id: unknown, name: unknown, status: ResearchEventStatus, server?: unknown): void {
    if (typeof id !== 'string' || !id || id.length > 512) return;
    // Squabble 自有 MCP 工具（server 名或工具名以 squabble 开头）不对外播报。
    if (
      (typeof server === 'string' && /^squabble(?:_|$)/u.test(server)) ||
      (typeof name === 'string' && /^(?:mcp__)?squabble(?:_|$)/u.test(name))
    )
      return;
    // callId 用原 id 的 sha256 前 20 位：对外不暴露 CLI 的原始调用 id。
    const callId: string = `${this.provider}-${createHash('sha256').update(id).digest('hex').slice(0, 20)}`;
    const existing = this.calls.get(callId);
    const toolName: string | undefined =
      existing?.name ?? (typeof name === 'string' ? PUBLIC_TOOLS[name] : undefined);
    // 未知名字可能携带参数/凭据。绝不合成工具名或生命周期。
    if (!toolName) return;
    if (status === 'running' && !existing)
      this.calls.set(callId, { name: toolName, at: Date.now() });
    // 结束事件带时长：以首次 running 的时间为起点，负值钳为 0。
    const durationMs: number | undefined =
      status !== 'running' && existing ? Math.max(0, Date.now() - existing.at) : undefined;
    this.emit({
      id: `${callId}-${status}`,
      kind: 'tool',
      status,
      at: new Date().toISOString(),
      toolName,
      callId,
      ...(durationMs === undefined ? {} : { durationMs }),
      summary: status === 'running' ? `Using ${toolName}` : `${toolName}: ${status}`,
    });
  }
  /** 各 provider 事件分派：只读公开元数据，正文一律不进事件流。 */
  read(event: JsonObject): void {
    if (!this.onEvent) return;
    if (this.provider === 'codex') {
      const item = object(event.item);
      if (event.type === 'turn.started') this.phase('started', 'running', 'Research started');
      if (event.type === 'turn.completed')
        this.phase('completed', 'succeeded', 'Research completed');
      if (event.type === 'item.started' || event.type === 'item.completed') {
        this.tool(
          item.id,
          item.type === 'mcp_tool_call' ? item.tool : item.type,
          event.type === 'item.started'
            ? 'running'
            : item.status === 'failed' || item.error
              ? 'failed'
              : 'succeeded',
          item.server,
        );
      }
    } else if (this.provider === 'claude') {
      const message = object(event.message);
      if (event.type === 'assistant' || event.type === 'user')
        for (const value of Array.isArray(message.content) ? message.content : []) {
          const block = object(value);
          if (block.type === 'tool_use') this.tool(block.id, block.name, 'running');
          if (block.type === 'tool_result')
            this.tool(
              block.tool_use_id,
              undefined,
              block.is_error === true ? 'failed' : 'succeeded',
            );
        }
      if (event.type === 'system' && event.subtype === 'init')
        this.phase('started', 'running', 'Research started');
      if (event.type === 'result' && event.subtype === 'success')
        this.phase('completed', 'succeeded', 'Research completed');
    } else if (this.provider === 'gemini') {
      if (event.type === 'init') this.phase('started', 'running', 'Research started');
      if (event.type === 'tool_use') this.tool(event.tool_id, event.tool_name, 'running');
      if (event.type === 'tool_result' && ['success', 'error'].includes(String(event.status))) {
        this.tool(event.tool_id, undefined, event.status === 'success' ? 'succeeded' : 'failed');
      }
      if (event.type === 'result' && event.status === 'success')
        this.phase('completed', 'succeeded', 'Research completed');
    } else if (this.provider === 'antigravity') {
      const step = object(event.step_update);
      // 公开的 step_update 不保证携带调用 id 或结果状态，只能播报"工具在活动"。
      if (event.event === 'step_update' && step.step_type === 'tool')
        this.phase('tool', 'running', 'Research tool activity');
      if (event.event === 'result' && object(event.result).status === 'SUCCESS')
        this.phase('completed', 'succeeded', 'Research completed');
    } else if (this.provider === 'opencode') {
      const part = object(event.part);
      const state = object(part.state);
      if (
        event.type === 'tool_use' &&
        ['running', 'completed', 'error'].includes(String(state.status))
      ) {
        this.tool(
          part.callID,
          part.tool,
          state.status === 'running'
            ? 'running'
            : state.status === 'completed'
              ? 'succeeded'
              : 'failed',
        );
      }
      if (event.type === 'step_start') this.phase('started', 'running', 'Research started');
      if (event.type === 'step_finish' && part.reason === 'stop')
        this.phase('completed', 'succeeded', 'Research completed');
    } else if (this.provider === 'kimi') {
      if (event.role === 'assistant' && Array.isArray(event.tool_calls))
        for (const value of event.tool_calls) {
          const call = object(value);
          this.tool(call.id, object(call.function).name, 'running');
        }
      // Kimi 的 role=tool 内容没有文档化的结果状态：未完成的调用交给任务方收尾。
    } else if (this.provider === 'doubao') {
      // Doubao 只暴露粗粒度 status，没有工具级事件。
      if (event.status === 'running') this.phase('started', 'running', 'Research running');
      if (event.status === 'completed') this.phase('completed', 'succeeded', 'Research completed');
      if (event.status === 'failed' || event.status === 'cancelled')
        this.phase('ended', event.status, 'Research ended');
    }
  }
}
