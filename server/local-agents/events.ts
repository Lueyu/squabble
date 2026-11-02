import type { LocalAgentProvider } from '../../shared/local-agents.interface';

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
  constructor(private readonly provider: LocalAgentProvider, private readonly onProgress: (text: string) => void) {}

  read(line: string): void {
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { return; }
    const event: JsonObject = object(parsed);
    if (this.provider === 'codex') this.codex(event);
    else this.claude(event);
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

  result(): { text: string; usageTokens: number | null } {
    if (!this.terminal || !this.text.trim()) throw new Error('NATIVE_AGENT_INCOMPLETE');
    return { text: redactCredentials(this.text.trim()), usageTokens: this.usageTokens };
  }
}
