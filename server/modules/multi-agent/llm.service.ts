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
import { Injectable, Logger, Optional } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { ModuleRef } from '@nestjs/core';
import axios from 'axios';
import { SettingsService } from '../settings/settings.service';
import { normalizePublicLlmBaseUrl, publicHttpsAgent } from '../settings/settings-security';
import { LlmBudgetService } from '../llm-budget/llm-budget.service';
import type { ModelRoute } from '../../../shared/model-route.interface';
import { LocalAgentsService } from '../local-agents/local-agents.service';
import { parseModelRoute } from '../settings/model-route.rules';

export interface LlmCallOptions {
  route?: ModelRoute;
  connectionId?: string;
  taskId?: string;
  purpose?: string;
  maxOutputTokens?: number;
  /** Interactive rooms retain a failed turn rather than retrying a possibly billed request. */
  retryPolicy?: 'none' | 'transient';
  timeoutMs?: number;
  /** Checked before every paid attempt, including transport retries. */
  shouldContinue?: () => Promise<boolean>;
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
interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** The raw content + token usage returned by a chat call. */
interface ChatResponse {
  content: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Native Agent usage may be unavailable; zero tokens must not imply known zero cost. */
  usageKnown?: boolean;
}

interface ProviderChatPayload {
  choices?: Array<{ message?: { content?: string | null }; finish_reason?: string | null }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

@Injectable()
export class LlmService {
  private static readonly localQueues = new Map<string, Promise<void>>();
  private readonly logger = new Logger(LlmService.name);
  private readonly timeoutMs = 60_000;
  /** Number of retries after the initial attempt (so max total = 1 + 2 = 3). */
  private readonly maxRetries = 2;

  constructor(
    private readonly settings: SettingsService,
    private readonly budgets: LlmBudgetService,
    @Optional() private readonly moduleRef?: ModuleRef,
  ) {}

  private localAgents(): LocalAgentsService {
    try {
      const agents = this.moduleRef?.get(LocalAgentsService, { strict: false });
      if (agents) return agents;
    } catch { /* The local Agent module is optional in reduced test modules. */ }
    throw new Error('LOCAL_UNAVAILABLE');
  }

  private async routeFor(userId: string, route?: ModelRoute): Promise<ModelRoute> {
    if (route) return parseModelRoute(route);
    if (typeof this.settings.getDefaultModelRoute === 'function') return this.settings.getDefaultModelRoute(userId);
    if (typeof this.settings.getSettings === 'function') {
      return (await this.settings.getSettings(userId)).llm.engine === 'basic' ? { mode: 'basic' } : { mode: 'api' };
    }
    return { mode: 'api' };
  }

  async validateRoute(userId: string, route: ModelRoute): Promise<void> {
    const selected = parseModelRoute(route);
    if (selected.mode === 'local') return this.localAgents().validate(userId, selected.agentId, selected.agentSettings);
    if (selected.mode === 'api' && !await this.settings.getLlmConfig(userId)) throw new Error('No LLM API key configured');
  }

  /** A broken saved key is still configured: callers must not silently downgrade it. */
  async isConfigured(userId: string, connectionId?: string, route?: ModelRoute): Promise<boolean> {
    if (connectionId) return Boolean(await this.settings.getLlmConfig(userId, connectionId));
    const selected = await this.routeFor(userId, route);
    if (selected.mode === 'local') {
      try { await this.localAgents().validate(userId, selected.agentId, selected.agentSettings); return true; }
      catch { return false; }
    }
    if (selected.mode === 'basic') return false;
    if (await this.settings.getLlmConfig(userId)) return true;
    // A saved but unreadable key still requires attention; do not treat it as
    // permission to silently switch an existing model workflow to Basic.
    return typeof this.settings.getSettings === 'function'
      && (await this.settings.getSettings(userId)).llm.needsReentry === true;
  }

  async validateConnectionIds(userId: string, ids: string[]): Promise<void> {
    for (const id of new Set(ids)) await this.settings.getLlmConfig(userId, id);
  }

  /** Public execution metadata only; credentials never enter reports. */
  async getExecutionInfo(userId: string, route?: ModelRoute): Promise<{
    provider: string;
    modelFast: string;
    modelSlow: string;
  } | null> {
    const selected = await this.routeFor(userId, route);
    if (selected.mode === 'basic') return null;
    if (selected.mode === 'local') return { provider: 'local', modelFast: selected.agentSettings?.model || selected.agentId,
      modelSlow: selected.agentSettings?.model || selected.agentId };
    if (route) {
      const config = await this.settings.getLlmConfig(userId);
      if (!config) throw new Error('No LLM API key configured');
      return { provider: config.source, modelFast: config.fastModel, modelSlow: config.slowModel };
    }
    const { llm } = await this.settings.getSettings(userId);
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
  async chatFastJSON(messages: ChatMessage[], userId: string, options?: LlmCallOptions): Promise<{ data: unknown; tokens: number; tokensKnown?: boolean }> {
    return this.chatJSON(messages, 'fast', userId, options);
  }

  /** JSON-mode chat on the slow model; returns parsed object + token count. */
  async chatSlowJSON(messages: ChatMessage[], userId: string, options?: LlmCallOptions): Promise<{ data: unknown; tokens: number; tokensKnown?: boolean }> {
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
    const route = options.connectionId ? { mode: 'api' as const } : await this.routeFor(userId, options.route);
    if (route.mode === 'basic') throw new Error('LLM_BASIC_ROUTE');
    if (route.mode === 'local') return this.chatLocal(messages, userId, route, options);
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
      const reservation = await this.budgets.reserve(userId, { ...options, taskId, model, messages });
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

  private async chatLocal(messages: ChatMessage[], userId: string, route: Extract<ModelRoute, { mode: 'local' }>,
    options: LlmCallOptions): Promise<ChatResponse> {
    const key = route.agentId;
    const previous = LlmService.localQueues.get(key) ?? Promise.resolve();
    let release!: () => void;
    const done = new Promise<void>(resolve => { release = resolve; });
    const queued = previous.catch(() => undefined).then(() => done);
    LlmService.localQueues.set(key, queued);
    try {
      await previous.catch(() => undefined);
      if (options.shouldContinue && !await options.shouldContinue()) throw new Error('LLM request cancelled');
      const agents = this.localAgents();
      await agents.validate(userId, route.agentId, route.agentSettings);
      const taskId = options.taskId ?? randomUUID();
      const purpose = options.purpose ?? randomUUID();
      const messageId = createHash('sha256').update(JSON.stringify([userId, taskId, purpose, route.agentId])).digest('hex');
      const result = await agents.execute(userId, {
        agentId: route.agentId, agentSettings: route.agentSettings, messageId,
        prompt: messages.map(message => `${message.role.toUpperCase()}:\n${message.content}`).join('\n\n'),
        onTask: async () => undefined, onProgress: async () => undefined,
        shouldContinue: options.shouldContinue ?? (async () => true),
      });
      if (options.shouldContinue && !await options.shouldContinue()) throw new Error('LLM request cancelled');
      if (!result.text.trim()) throw new ModelResponseError('LLM_EMPTY_RESPONSE');
      const known = typeof result.usageTokens === 'number';
      return { content: result.text, promptTokens: 0, completionTokens: 0,
        totalTokens: typeof result.usageTokens === 'number' ? result.usageTokens : 0, usageKnown: known };
    } finally {
      release();
      if (LlmService.localQueues.get(key) === queued) LlmService.localQueues.delete(key);
    }
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
  ): Promise<{ data: unknown; tokens: number; tokensKnown?: boolean }> {
    const systemMsg: ChatMessage = {
      role: 'system',
      content: '你必须严格按照用户要求的 JSON 格式输出，不要添加任何解释、说明或 markdown 格式。只输出合法的 JSON 字符串。',
    };

    // Preserve any caller-supplied system messages, then append our strict-JSON
    // instruction, then user/assistant messages.
    const userMsgs = messages.filter((m) => m.role !== 'system');
    const systemMsgs = messages.filter((m) => m.role === 'system');

    const allMessages: ChatMessage[] = [...systemMsgs, systemMsg, ...userMsgs];

    const result = await this.chat(allMessages, tier, userId, options);

    let cleaned = result.content.trim();
    // Strip markdown code fences (```json … ```) if the LLM wrapped the output.
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    }

    try {
      const parsed = JSON.parse(cleaned);
      return { data: parsed, tokens: result.totalTokens,
        ...(result.usageKnown === undefined ? {} : { tokensKnown: result.usageKnown }) };
    } catch (parseError) {
      // Fallback: extract the first balanced-looking JSON object from the text.
      const match = cleaned.match(/\{[\s\S]*\}/);
      if (match) {
        try {
          const parsed = JSON.parse(match[0]);
          return { data: parsed, tokens: result.totalTokens,
            ...(result.usageKnown === undefined ? {} : { tokensKnown: result.usageKnown }) };
        } catch {
          // fall through to final throw
        }
      }
      throw new ModelResponseError('LLM_INVALID_JSON');
    }
  }
}
