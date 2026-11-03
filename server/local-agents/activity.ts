import { createHash } from 'node:crypto';
import type { LocalAgentProvider } from '../../shared/local-agents.interface';
import type { ResearchActivity, ResearchEventStatus } from '../../shared/research-events.interface';
import { object, type JsonObject } from './metadata';

const PUBLIC_TOOLS: Record<string, string> = {
  web_search: 'web_search', WebSearch: 'web_search', google_web_search: 'web_search', search_web: 'web_search', websearch: 'web_search',
  WebFetch: 'web_fetch', web_fetch: 'web_fetch', webfetch: 'web_fetch', read_url_content: 'web_fetch',
  Read: 'read_file', read_file: 'read_file', read_many_files: 'read_file', view_file: 'read_file', read: 'read_file',
  Glob: 'find_files', glob: 'find_files', find_by_name: 'find_files', Grep: 'search_files', grep: 'search_files', grep_search: 'search_files',
  list_directory: 'list_directory', list_dir: 'list_directory', command_execution: 'shell', Bash: 'shell',
};

/** Uses an allowlist of public protocol metadata. Never forwards provider-supplied prose or arguments. */
export class NativeActivityCollector {
  private readonly emitted: Set<string> = new Set();
  private readonly calls: Map<string, { name: string; at: number }> = new Map();
  constructor(private readonly provider: LocalAgentProvider, private readonly onEvent?: (event: ResearchActivity) => void) {}

  private phase(key: string, status: ResearchEventStatus, summary: string): void {
    this.emit({ id: `${this.provider}-phase-${key}`, kind: 'summary', status, at: new Date().toISOString(), summary });
  }
  private emit(event: ResearchActivity): void {
    if (!this.onEvent || this.emitted.has(event.id) || this.emitted.size >= 256) return;
    this.emitted.add(event.id); this.onEvent(event);
  }
  private tool(id: unknown, name: unknown, status: ResearchEventStatus, server?: unknown): void {
    if (typeof id !== 'string' || !id || id.length > 512) return;
    if ((typeof server === 'string' && /^squabble(?:_|$)/u.test(server))
      || (typeof name === 'string' && /^(?:mcp__)?squabble(?:_|$)/u.test(name))) return;
    const callId: string = `${this.provider}-${createHash('sha256').update(id).digest('hex').slice(0, 20)}`;
    const existing = this.calls.get(callId);
    const toolName: string | undefined = existing?.name ?? (typeof name === 'string' ? PUBLIC_TOOLS[name] : undefined);
    // Unknown names could contain arguments/credentials. No synthetic tool names or lifecycle.
    if (!toolName) return;
    if (status === 'running' && !existing) this.calls.set(callId, { name: toolName, at: Date.now() });
    const durationMs: number | undefined = status !== 'running' && existing ? Math.max(0, Date.now() - existing.at) : undefined;
    this.emit({ id: `${callId}-${status}`, kind: 'tool', status, at: new Date().toISOString(), toolName, callId,
      ...(durationMs === undefined ? {} : { durationMs }), summary: status === 'running' ? `Using ${toolName}` : `${toolName}: ${status}` });
  }
  read(event: JsonObject): void {
    if (!this.onEvent) return;
    if (this.provider === 'codex') {
      const item = object(event.item);
      if (event.type === 'turn.started') this.phase('started', 'running', 'Research started');
      if (event.type === 'turn.completed') this.phase('completed', 'succeeded', 'Research completed');
      if (event.type === 'item.started' || event.type === 'item.completed') {
        this.tool(item.id, item.type === 'mcp_tool_call' ? item.tool : item.type,
          event.type === 'item.started' ? 'running' : item.status === 'failed' || item.error ? 'failed' : 'succeeded', item.server);
      }
    } else if (this.provider === 'claude') {
      const message = object(event.message);
      if (event.type === 'assistant' || event.type === 'user') for (const value of Array.isArray(message.content) ? message.content : []) {
        const block = object(value);
        if (block.type === 'tool_use') this.tool(block.id, block.name, 'running');
        if (block.type === 'tool_result') this.tool(block.tool_use_id, undefined, block.is_error === true ? 'failed' : 'succeeded');
      }
      if (event.type === 'system' && event.subtype === 'init') this.phase('started', 'running', 'Research started');
      if (event.type === 'result' && event.subtype === 'success') this.phase('completed', 'succeeded', 'Research completed');
    } else if (this.provider === 'gemini') {
      if (event.type === 'init') this.phase('started', 'running', 'Research started');
      if (event.type === 'tool_use') this.tool(event.tool_id, event.tool_name, 'running');
      if (event.type === 'tool_result' && ['success', 'error'].includes(String(event.status))) {
        this.tool(event.tool_id, undefined, event.status === 'success' ? 'succeeded' : 'failed');
      }
      if (event.type === 'result' && event.status === 'success') this.phase('completed', 'succeeded', 'Research completed');
    } else if (this.provider === 'antigravity') {
      const step = object(event.step_update);
      // The public step_update does not guarantee a call ID or an outcome.
      if (event.event === 'step_update' && step.step_type === 'tool') this.phase('tool', 'running', 'Research tool activity');
      if (event.event === 'result' && object(event.result).status === 'SUCCESS') this.phase('completed', 'succeeded', 'Research completed');
    } else if (this.provider === 'opencode') {
      const part = object(event.part); const state = object(part.state);
      if (event.type === 'tool_use' && ['running', 'completed', 'error'].includes(String(state.status))) {
        this.tool(part.callID, part.tool, state.status === 'running' ? 'running' : state.status === 'completed' ? 'succeeded' : 'failed');
      }
      if (event.type === 'step_start') this.phase('started', 'running', 'Research started');
      if (event.type === 'step_finish' && part.reason === 'stop') this.phase('completed', 'succeeded', 'Research completed');
    } else if (this.provider === 'kimi') {
      if (event.role === 'assistant' && Array.isArray(event.tool_calls)) for (const value of event.tool_calls) {
        const call = object(value); this.tool(call.id, object(call.function).name, 'running');
      }
      // Kimi's role=tool content has no documented outcome: let the task owner close unfinished calls.
    } else if (this.provider === 'doubao') {
      if (event.status === 'running') this.phase('started', 'running', 'Research running');
      if (event.status === 'completed') this.phase('completed', 'succeeded', 'Research completed');
      if (event.status === 'failed' || event.status === 'cancelled') this.phase('ended', event.status, 'Research ended');
    }
  }
}
