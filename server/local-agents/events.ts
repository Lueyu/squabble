/**
 * local-agents 输出事件解析器：把 CLI stdout 的 JSON 行解析成研究结果
 * （最终文本 + token 用量）与进度提示，并同步喂给活动采集器。
 *
 * 职责边界：只解析公开的 text/result 事件；工具输入、原始错误与 stderr
 * 绝不进入浏览器；失败通过抛 NATIVE_AGENT_* 错误码表达。
 *
 * 上下游：import shared 接口与 activity 的 NativeActivityCollector；
 * 被 research.ts、doubao.ts 使用。
 *
 * 关键约定：最终文本在 result() 出口统一做凭据脱敏（Bearer/sk-/GitHub
 * token 三类）；usageTokens 用 checkedTokenSum 校验（必须是安全非负整数，
 * 任一项不合法整体返回 null）；kimi 的 print 协议没有终止事件——零退出
 * 码 + 末条非工具 assistant 消息即其完成契约（completeProcess）。
 */
import type { LocalAgentProvider } from '../../shared/local-agents.interface';
import type { ResearchActivity } from '../../shared/research-events.interface';
import { NativeActivityCollector } from './activity';

interface JsonObject {
  [key: string]: unknown;
}
/** 仅当 value 是非数组对象时返回它，否则返回空对象（读字段防炸）。 */
function object(value: unknown): JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}
/** 求和 usage 字段：任一项缺失（可选键除外）/非安全整数/负值 → 整体 null。 */
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

/** 出口脱敏：Bearer 头、OpenAI 风格 sk- key、GitHub PAT 三类凭据打码。 */
function redactCredentials(text: string): string {
  return text
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}/g, '[REDACTED]')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, '[REDACTED]');
}

/** 只解析公开的 text/result 事件。工具输入、原始错误与 stderr 绝不进浏览器。 */
export class NativeEventCollector {
  private text: string = '';
  private terminal: boolean = false;
  private usageTokens: number | null = null;
  private lastProgress: string = '';
  private readonly activity: NativeActivityCollector;
  constructor(
    private readonly provider: LocalAgentProvider,
    private readonly onProgress: (text: string) => void,
    onEvent?: (event: ResearchActivity) => void,
  ) {
    this.activity = new NativeActivityCollector(provider, onEvent);
  }

  /** 单行解析入口：非 JSON 行静默忽略；先喂活动采集器再走 provider 分支。 */
  read(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
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

  /** 进度去重：同一文本只回调一次。 */
  private progress(text: string): void {
    if (this.lastProgress === text) return;
    this.lastProgress = text;
    this.onProgress(text);
  }

  /** codex：turn.failed/error 即失败；agent_message 是最终文本（commentary 阶段除外）。 */
  private codex(event: JsonObject): void {
    if (event.type === 'turn.failed' || event.type === 'error')
      throw new Error('NATIVE_AGENT_FAILED');
    const item: JsonObject = object(event.item);
    if (event.type === 'item.started')
      this.progress(item.type === 'web_search' ? 'Searching sources…' : 'Analyzing sources…');
    if (
      event.type === 'item.completed' &&
      item.type === 'agent_message' &&
      typeof item.text === 'string'
    ) {
      if (item.phase !== 'commentary') this.text = item.text;
      this.progress('Preparing research results…');
    }
    if (event.type === 'turn.completed') {
      this.terminal = true;
      const usage: JsonObject = object(event.usage);
      this.usageTokens = checkedTokenSum(usage);
    }
  }

  /** claude：assistant 流式累积 text 块；result.is_error / 非 success 即失败。 */
  private claude(event: JsonObject): void {
    if (event.type === 'assistant') {
      const message: JsonObject = object(event.message);
      if (Array.isArray(message.content)) {
        for (const value of message.content) {
          const block: JsonObject = object(value);
          if (block.type === 'tool_use')
            this.progress(block.name === 'WebSearch' ? 'Searching sources…' : 'Analyzing sources…');
          if (block.type === 'text' && typeof block.text === 'string') this.text += block.text;
        }
      }
    }
    if (event.type === 'result') {
      if (event.is_error === true || event.subtype !== 'success')
        throw new Error('NATIVE_AGENT_FAILED');
      this.terminal = true;
      if (typeof event.result === 'string') this.text = event.result;
      // claude 的用量含 cache 读写两项（键可能缺省，缺省不计入）。
      const usage: JsonObject = object(event.usage);
      this.usageTokens = checkedTokenSum(usage, [
        'cache_creation_input_tokens',
        'cache_read_input_tokens',
      ]);
    }
  }

  /** gemini：delta=true 为增量拼接；stats 里取用量；error(severity=error) 即失败。 */
  private gemini(event: JsonObject): void {
    if (event.type === 'error' && event.severity === 'error')
      throw new Error('NATIVE_AGENT_FAILED');
    if (event.type === 'tool_use') this.progress('Searching sources…');
    if (
      event.type === 'message' &&
      event.role === 'assistant' &&
      typeof event.content === 'string'
    ) {
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

  /** antigravity：result.status 必须是 SUCCESS 且无 error；response 是最终文本。 */
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

  /** opencode：text 覆盖式更新；step_finish 只有 reason=stop 才算终止，tokens 累加。 */
  private opencode(event: JsonObject): void {
    if (event.type === 'error') throw new Error('NATIVE_AGENT_FAILED');
    const part: JsonObject = object(event.part);
    if (event.type === 'tool_use') {
      this.terminal = false;
      this.progress('Searching sources…');
    }
    if (event.type === 'text' && typeof part.text === 'string') {
      this.text = part.text;
      this.progress('Preparing research results…');
    }
    if (event.type === 'step_finish') {
      this.terminal = part.reason === 'stop';
      const tokens: JsonObject = object(part.tokens);
      const usage: number | null = checkedTokenSum({
        input_tokens: tokens.input,
        output_tokens: tokens.output,
      });
      // 多段 step_finish 的用量累加（此前无值则从 0 起算）。
      if (usage !== null) this.usageTokens = (this.usageTokens ?? 0) + usage;
    }
  }

  /** kimi：assistant 消息覆盖文本；带 tool_calls 的消息清空文本（工具阶段无产出）。 */
  private kimi(event: JsonObject): void {
    if (event.type === 'error' || event.role === 'error') throw new Error('NATIVE_AGENT_FAILED');
    if (event.role !== 'assistant') return;
    this.terminal = false;
    if (Array.isArray(event.tool_calls) && event.tool_calls.length) {
      this.text = '';
      this.progress('Searching sources…');
      return;
    }
    if (typeof event.content === 'string') this.text = event.content;
    else if (Array.isArray(event.content))
      // content 块数组：只取 type=text 的块拼接。
      this.text = event.content
        .map((value: unknown) => {
          const block: JsonObject = object(value);
          return block.type === 'text' && typeof block.text === 'string' ? block.text : '';
        })
        .join('');
    this.usageTokens = checkedTokenSum(object(event.usage));
    this.progress('Preparing research results…');
  }

  /** doubao：只有 completed 且 reply 是 assistant 文本才算完成，其余视为未完成。 */
  private doubao(event: JsonObject): void {
    if (event.status === 'running') return;
    if (event.status !== 'completed') throw new Error('NATIVE_AGENT_INCOMPLETE');
    const reply: JsonObject = object(event.reply);
    if (reply.role !== 'assistant' || typeof reply.text !== 'string')
      throw new Error('NATIVE_AGENT_INCOMPLETE');
    this.text = reply.text;
    this.terminal = true;
  }

  /** kimi 的 print 协议没有终止事件：零退出码 + 末条非工具 assistant 消息即其完成契约。 */
  completeProcess(): void {
    if (this.provider === 'kimi' && this.text.trim()) this.terminal = true;
  }

  /** 结果出口：必须已到终态且文本非空；文本统一脱敏后返回。 */
  result(): { text: string; usageTokens: number | null } {
    if (!this.terminal || !this.text.trim()) throw new Error('NATIVE_AGENT_INCOMPLETE');
    return { text: redactCredentials(this.text.trim()), usageTokens: this.usageTokens };
  }
}
