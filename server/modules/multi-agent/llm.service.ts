/**
 * LlmService — per-user OpenAI-compatible chat-completions client.
 *
 * Responsibilities:
 *  - Read each user's encrypted Settings credential, falling back to the
 *    server's legacy Doubao environment variables.
 *  - Expose four entry points: chatFast / chatSlow (free text) and
 *    chatFastJSON / chatSlowJSON (JSON output).
 *  - Apply exponential-backoff retries on network and transient HTTP errors.
 *  - Time out each call after 60s via AbortController.
 *  - For JSON calls, strip markdown code fences and attempt a regex brace-scan
 *    fallback when the first JSON.parse fails (LLMs occasionally wrap JSON in
 *    prose or emit trailing commas).
 *
 * Two model tiers:
 *  - fast (doubao-lite-4k by default): cheap, low-latency, good for simple tasks.
 *  - slow (doubao-pro-32k by default): higher quality, larger context; used for
 *    debate, critique, and rating aggregation.
 */
import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import axios from 'axios';
import { SettingsService } from '../settings/settings.service';
import { normalizePublicLlmBaseUrl, publicHttpsAgent } from '../settings/settings-security';
import { LlmBudgetService } from '../llm-budget/llm-budget.service';

export interface LlmCallOptions {
  connectionId?: string;
  taskId?: string;
  purpose?: string;
  maxOutputTokens?: number;
  /** Interactive rooms retain a failed turn rather than retrying a possibly billed request. */
  retryPolicy?: 'none' | 'transient';
  timeoutMs?: number;
  /** Checked before every paid attempt, including transport retries. */
  shouldContinue?: () => Promise<boolean>;
  /** Runs after a committed reservation, immediately before transport. Failure prevents transport and releases that reservation. */
  onDispatch?: () => Promise<void>;
}

class ProviderHttpError extends Error {
  constructor(readonly status: number) {
    super(`LLM provider returned HTTP ${status}`);
  }
}

class ModelResponseError extends Error {
  constructor(readonly code: 'LLM_OUTPUT_LIMIT' | 'LLM_EMPTY_RESPONSE' | 'LLM_INVALID_JSON') {
    super(code);
  }
}

/** Use an explicit mode for models whose thinking behavior could exhaust a bounded response. */
function boundedDeepSeekMode(baseUrl: string, model: string) {
  // These documented IDs support an explicit mode switch. Do not guess the
  // capabilities of legacy aliases, custom gateways or similarly named hosts.
  if (!['deepseek-flash', 'deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp'].includes(model)) return {};
  try {
    const url = new URL(baseUrl);
    if (url.protocol === 'https:' && url.hostname === 'api.deepseek.com') {
      return { thinking: { type: 'disabled' as const } };
    }
  } catch { /* Invalid server configuration is handled by the safe transport error. */ }
  return {};
}

/** A single chat-completion message in OpenAI-compatible format. */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** Shared with request packing so the injected instruction is included in the same budget estimate. */
export function jsonChatMessages(messages: readonly ChatMessage[]): ChatMessage[] {
  return [...messages.filter(message => message.role === 'system'), {
    role: 'system', content: '你必须严格按照用户要求的 JSON 格式输出，不要添加任何解释、说明或 markdown 格式。只输出合法的 JSON 字符串。',
  }, ...messages.filter(message => message.role !== 'system')];
}

/** The raw content + token usage returned by a chat call. */
interface ChatResponse {
  content: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

interface ProviderChatPayload {
  choices?: Array<{ message?: { content?: string | null }; finish_reason?: string | null }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

@Injectable()
export class LlmService {
  private readonly logger = new Logger(LlmService.name);
  private readonly timeoutMs = 60_000;
  /** Number of retries after the initial attempt (so max total = 1 + 2 = 3). */
  private readonly maxRetries = 2;

  constructor(
    private readonly settings: SettingsService,
    private readonly budgets: LlmBudgetService,
  ) {}

  /** A broken saved key is still configured: callers must not silently downgrade it. */
  async isConfigured(userId: string, connectionId?: string): Promise<boolean> {
    if (connectionId) return Boolean(await this.settings.getLlmConfig(userId, connectionId));
    return (await this.settings.getSettings(userId)).llm.engine === 'llm';
  }

  async validateConnectionIds(userId: string, ids: string[]): Promise<void> {
    for (const id of new Set(ids)) await this.settings.getLlmConfig(userId, id);
  }

  /** Respect explicit higher limits without changing saved settings. Unlimited billing still uses a finite context envelope. */
  async getInputLimit(userId: string): Promise<number> {
    const settings = await this.budgets.getSettings(userId);
    return settings.enabled ? settings.maxInputTokens : 6000;
  }

  /** Public execution metadata only; credentials never enter reports. */
  async getExecutionInfo(userId: string): Promise<{
    provider: string;
    modelFast: string;
    modelSlow: string;
  } | null> {
    const { llm } = await this.settings.getSettings(userId);
    if (llm.engine === 'basic') return null;
    return { provider: llm.source, modelFast: llm.fastModel, modelSlow: llm.slowModel };
  }

  /** Free-text chat on the fast (cheap) model. */
  async chatFast(messages: ChatMessage[], userId: string, options?: LlmCallOptions): Promise<ChatResponse> {
    return this.chat(messages, 'fast', userId, options);
  }

  /** Free-text chat on the slow (pro) model. */
  async chatSlow(messages: ChatMessage[], userId: string, options?: LlmCallOptions): Promise<ChatResponse> {
    return this.chat(messages, 'slow', userId, options);
  }

  /** JSON-mode chat on the fast model; returns parsed object + token count. */
  async chatFastJSON(messages: ChatMessage[], userId: string, options?: LlmCallOptions): Promise<{ data: unknown; tokens: number }> {
    return this.chatJSON(messages, 'fast', userId, options);
  }

  /** JSON-mode chat on the slow model; returns parsed object + token count. */
  async chatSlowJSON(messages: ChatMessage[], userId: string, options?: LlmCallOptions): Promise<{ data: unknown; tokens: number }> {
    return this.chatJSON(messages, 'slow', userId, options);
  }

  /**
   * Core HTTP call with retry + timeout. Authentication and malformed-request
   * errors return immediately; transient failures retry with backoff.
   * Throws the last error if all attempts fail.
   */
  private async chat(
    messages: ChatMessage[],
    tier: 'fast' | 'slow',
    userId: string,
    options: LlmCallOptions = {},
  ): Promise<ChatResponse> {
    const config = await this.settings.getLlmConfig(userId, options.connectionId);
    if (!config) throw new Error('No LLM API key configured');
    const baseUrl = config.source === 'user'
      ? await normalizePublicLlmBaseUrl(config.baseUrl)
      : config.baseUrl.replace(/\/+$/u, '');
    const model = tier === 'fast' ? config.fastModel : config.slowModel;

    // All retries share a task id, but every attempted HTTP request has its own reservation.
    const taskId = options.taskId ?? randomUUID();
    const maxRetries = options.retryPolicy === 'none' ? 0 : this.maxRetries;
    const timeoutMs = Number.isFinite(options.timeoutMs)
      ? Math.max(1000, Math.min(120_000, Math.trunc(options.timeoutMs))) : this.timeoutMs;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      if (options.shouldContinue && !(await options.shouldContinue())) throw new Error('LLM request cancelled');
      // Deliberately outside the network catch: budget/DB failures must never retry or bypass accounting.
      const reservation = await this.budgets.reserve(userId, { ...options, taskId, model, messages }, options.onDispatch);
      const outputLimit = reservation.omitOutputLimit ? {} : /^(?:o[1-9](?:-|$)|gpt-5(?:[.-]|$))/u.test(model)
        ? { max_completion_tokens: reservation.maxOutputTokens }
        : { max_tokens: reservation.maxOutputTokens };
      const body = { model, messages, ...outputLimit, ...boundedDeepSeekMode(baseUrl, model) };
      let result: ProviderChatPayload;
      try {
        const response = await axios.post<ProviderChatPayload>(
          `${baseUrl}/chat/completions`,
          body,
          {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${config.apiKey}`,
          },
          timeout: timeoutMs,
          maxRedirects: 0,
          proxy: false,
          httpsAgent: config.source === 'user' ? publicHttpsAgent() : undefined,
          validateStatus: () => true,
          },
        );
        if (response.status < 200 || response.status >= 300) {
          throw new ProviderHttpError(response.status);
        }

        result = response.data;
      } catch (error) {
        // Timeouts/errors are ambiguous: keep the full charge, including on retries.
        // If settlement itself fails, the persisted reservation remains charged and execution stops.
        await this.budgets.settle(userId, reservation.id, undefined, true);
        const safeError = error instanceof ProviderHttpError
          ? error
          : axios.isAxiosError(error) && ['ECONNABORTED', 'ETIMEDOUT'].includes(error.code ?? '')
            ? new Error('LLM_REQUEST_TIMEOUT') : new Error('LLM request failed. Check provider URL and server network.');
        if (
          attempt === maxRetries
          || (error instanceof ProviderHttpError && error.status < 500 && error.status !== 429)
        ) {
          throw safeError;
        }
        // Exponential backoff: 1s, 2s, 4s… (capped implicitly by retry count).
        const delayMs = 1000 * Math.pow(2, attempt);
        this.logger.warn(`LLM call attempt ${attempt + 1} failed; retrying in ${delayMs}ms`);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }
      const usage = await this.budgets.settle(userId, reservation.id, result?.usage);
      const choice = result?.choices?.[0];
      // A billed but incomplete response is not a decision. Do not retry or
      // substitute hidden reasoning for final content, and keep its usage.
      if (choice?.finish_reason === 'length') throw new ModelResponseError('LLM_OUTPUT_LIMIT');
      const content = choice?.message?.content;
      if (typeof content !== 'string' || !content.trim()) throw new ModelResponseError('LLM_EMPTY_RESPONSE');
      return {
        content,
        promptTokens: usage.inputTokens,
        completionTokens: usage.outputTokens,
        totalTokens: usage.chargedTokens,
      };
    }

    // Unreachable: loop always either returns or throws.
    throw new Error('Unreachable');
  }

  /**
   * JSON-mode wrapper: prepend a system message forcing strict JSON output,
   * then clean + parse the response. Cleaning steps:
   *   1. Strip leading/trailing ```json fences if present.
   *   2. Try JSON.parse directly.
   *   3. On failure, regex-scan for the outermost {…} block and retry parse
   *      (handles LLM prose around the JSON).
   *   4. Still failing → return a safe error without echoing private model content.
   */
  private async chatJSON(
    messages: ChatMessage[],
    tier: 'fast' | 'slow',
    userId: string,
    options?: LlmCallOptions,
  ): Promise<{ data: unknown; tokens: number }> {
    const result = await this.chat(jsonChatMessages(messages), tier, userId, options);

    let cleaned = result.content.trim();
    // Strip markdown code fences (```json … ```) if the LLM wrapped the output.
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    }

    try {
      const parsed = JSON.parse(cleaned);
      return { data: parsed, tokens: result.totalTokens };
    } catch (parseError) {
      // Fallback: extract the first balanced-looking JSON object from the text.
      const match = cleaned.match(/\{[\s\S]*\}/);
      if (match) {
        try {
          const parsed = JSON.parse(match[0]);
          return { data: parsed, tokens: result.totalTokens };
        } catch {
          // fall through to final throw
        }
      }
      throw new ModelResponseError('LLM_INVALID_JSON');
    }
  }
}
