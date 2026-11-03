import type { LocalAgentProvider } from '../../shared/local-agents.interface';
import type { ResearchActivity } from '../../shared/research-events.interface';
import { NativeActivityCollector } from './activity';

interface JsonObject { [key: string]: unknown }
function object(value: unknown): JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
}
function checkedTokenSum(usage: JsonObject, optional: string[] = []): number | null {
  let total: number = 0;
  for (const key of ['input_tokens', 'output_tokens', ...optional]) {
    if (optional.includes(key) && !Object.hasOwn(usage, key)) continue;
    const value: unknown = usage[key];
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return null;
    total += value;
    if (!Number.isSafeInteger(total)) return null;
  }
  return total;
}

function redactCredentials(text: string): string {
  return text.replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}/g, '[REDACTED]')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, '[REDACTED]');
}

/** Parse only public text/result events. Tool inputs, raw errors and stderr never reach the browser. */
export class NativeEventCollector {
  private text: string = '';
  private terminal: boolean = false;
  private usageTokens: number | null = null;
  private lastProgress: string = '';
  private readonly activity: NativeActivityCollector;
  constructor(private readonly provider: LocalAgentProvider, private readonly onProgress: (text: string) => void,
    onEvent?: (event: ResearchActivity) => void) { this.activity = new NativeActivityCollector(provider, onEvent); }

  read(line: string): void {
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { return; }
    const event: JsonObject = object(parsed);
    this.activity.read(event);
    if (this.provider === 'codex') this.codex(event);
    else if (this.provider === 'claude') this.claude(event);
    else if (this.provider === 'gemini') this.gemini(event);
    else if (this.provider === 'antigravity') this.antigravity(event);
    else if (this.provider === 'opencode') this.opencode(event);
    else if (this.provider === 'kimi') this.kimi(event);
    else if (this.provider === 'doubao') this.doubao(event);
  }

  private progress(text: string): void {
    if (this.lastProgress === text) return;
    this.lastProgress = text;
    this.onProgress(text);
  }

  private codex(event: JsonObject): void {
    if (event.type === 'turn.failed' || event.type === 'error') throw new Error('NATIVE_AGENT_FAILED');
    const item: JsonObject = object(event.item);
    if (event.type === 'item.started') this.progress(item.type === 'web_search' ? 'Searching sources…' : 'Analyzing sources…');
    if (event.type === 'item.completed' && item.type === 'agent_message' && typeof item.text === 'string') {
      if (item.phase !== 'commentary') this.text = item.text;
      this.progress('Preparing research results…');
    }
    if (event.type === 'turn.completed') {
      this.terminal = true;
      const usage: JsonObject = object(event.usage);
      this.usageTokens = checkedTokenSum(usage);
    }
  }

  private claude(event: JsonObject): void {
    if (event.type === 'assistant') {
      const message: JsonObject = object(event.message);
      if (Array.isArray(message.content)) {
        for (const value of message.content) {
          const block: JsonObject = object(value);
          if (block.type === 'tool_use') this.progress(block.name === 'WebSearch' ? 'Searching sources…' : 'Analyzing sources…');
          if (block.type === 'text' && typeof block.text === 'string') this.text += block.text;
        }
      }
    }
    if (event.type === 'result') {
      if (event.is_error === true || event.subtype !== 'success') throw new Error('NATIVE_AGENT_FAILED');
      this.terminal = true;
      if (typeof event.result === 'string') this.text = event.result;
      const usage: JsonObject = object(event.usage);
      this.usageTokens = checkedTokenSum(usage, ['cache_creation_input_tokens', 'cache_read_input_tokens']);
    }
  }

  private gemini(event: JsonObject): void {
    if (event.type === 'error' && event.severity === 'error') throw new Error('NATIVE_AGENT_FAILED');
    if (event.type === 'tool_use') this.progress('Searching sources…');
    if (event.type === 'message' && event.role === 'assistant' && typeof event.content === 'string') {
      this.text = event.delta === true ? this.text + event.content : event.content;
      this.progress('Preparing research results…');
    }
    if (event.type === 'result') {
      if (event.status !== 'success' || event.error) throw new Error('NATIVE_AGENT_FAILED');
      this.terminal = true;
      const stats: JsonObject = object(event.stats);
      this.usageTokens = checkedTokenSum(stats);
    }
  }

  private antigravity(event: JsonObject): void {
    if (event.event === 'step_update') {
      const step: JsonObject = object(event.step_update);
      this.progress(step.step_type === 'tool' ? 'Searching sources…' : 'Analyzing sources…');
    }
    if (event.event !== 'result') return;
    const result: JsonObject = object(event.result);
    if (result.status !== 'SUCCESS' || result.error) throw new Error('NATIVE_AGENT_FAILED');
    this.terminal = true;
    if (typeof result.response === 'string') this.text = result.response;
    this.usageTokens = checkedTokenSum(object(result.usage));
  }

  private opencode(event: JsonObject): void {
    if (event.type === 'error') throw new Error('NATIVE_AGENT_FAILED');
    const part: JsonObject = object(event.part);
    if (event.type === 'tool_use') { this.terminal = false; this.progress('Searching sources…'); }
    if (event.type === 'text' && typeof part.text === 'string') { this.text = part.text; this.progress('Preparing research results…'); }
    if (event.type === 'step_finish') {
      this.terminal = part.reason === 'stop';
      const tokens: JsonObject = object(part.tokens);
      const usage: number | null = checkedTokenSum({ input_tokens: tokens.input, output_tokens: tokens.output });
      if (usage !== null) this.usageTokens = (this.usageTokens ?? 0) + usage;
    }
  }

  private kimi(event: JsonObject): void {
    if (event.type === 'error' || event.role === 'error') throw new Error('NATIVE_AGENT_FAILED');
    if (event.role !== 'assistant') return;
    this.terminal = false;
    if (Array.isArray(event.tool_calls) && event.tool_calls.length) {
      this.text = ''; this.progress('Searching sources…'); return;
    }
    if (typeof event.content === 'string') this.text = event.content;
    else if (Array.isArray(event.content)) this.text = event.content.map((value: unknown) => {
      const block: JsonObject = object(value);
      return block.type === 'text' && typeof block.text === 'string' ? block.text : '';
    }).join('');
    this.usageTokens = checkedTokenSum(object(event.usage));
    this.progress('Preparing research results…');
  }

  private doubao(event: JsonObject): void {
    if (event.status === 'running') return;
    if (event.status !== 'completed') throw new Error('NATIVE_AGENT_INCOMPLETE');
    const reply: JsonObject = object(event.reply);
    if (reply.role !== 'assistant' || typeof reply.text !== 'string') throw new Error('NATIVE_AGENT_INCOMPLETE');
    this.text = reply.text; this.terminal = true;
  }

  /** Kimi's print protocol has no terminal event: zero exit plus a final non-tool assistant message is its completion contract. */
  completeProcess(): void {
    if (this.provider === 'kimi' && this.text.trim()) this.terminal = true;
  }

  result(): { text: string; usageTokens: number | null } {
    if (!this.terminal || !this.text.trim()) throw new Error('NATIVE_AGENT_INCOMPLETE');
    return { text: redactCredentials(this.text.trim()), usageTokens: this.usageTokens };
  }
}
