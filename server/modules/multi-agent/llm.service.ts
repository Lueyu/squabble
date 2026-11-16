/**
 * llm.service.ts — LlmService — 面向单用户的 OpenAI 兼容 chat-completions 客户端。
 *
 * 职责边界：
 *  - 负责：读取每个用户加密的 Settings 凭据（缺省回退到服务端遗留的豆包环境变量）；
 *  暴露四个入口 chatFast / chatSlow（自由文本）与 chatFastJSON / chatSlowJSON（JSON 输出）；
 *  对网络错误与瞬时 HTTP 错误做指数退避重试；每次调用经 AbortController 60 秒超时；
 *  JSON 调用会剥掉 markdown 代码围栏，首次 JSON.parse 失败时再用正则花括号扫描兜底
 *  （LLM 偶尔会在 JSON 外包一层散文或输出尾逗号）。
 *  - 不负责：token 预算的记账与限额（由 LlmBudgetService 负责，本类只调用其 reserve/settle）。
 *  上下游：
 *  - 上游（谁调用这里）：pipeline.service.ts（辩论/评审/评级各阶段）、
 *    multi-agent.module.ts 装配、council.service.ts、paper-trading 的 agent-builder.service.ts。
 *  - 下游（本文件调用谁）：SettingsService（取用户 LLM 配置）、LlmBudgetService
 *    （每次付费尝试前的 reserve 与事后的 settle）、settings-security 的
 *    normalizePublicLlmBaseUrl / publicHttpsAgent。
 * 关键约定：
 *  - 两档模型：fast（默认 doubao-lite-4k，便宜低延迟）与 slow（默认 doubao-pro-32k，
 *    质量更高、上下文更大，用于辩论/评审/评级聚合）。
 *  - 重试上限 2 次（总尝试 1+2=3 次）；鉴权类（<500 且非 429）错误立即抛出不重试。
 *  - 超时/网络错误属于"结果不确定"：结算时全额扣费（charged=true），不退还。
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
  /** 互动房间的失败回合直接保留，不重试可能已计费的请求。 */
  retryPolicy?: 'none' | 'transient';
  timeoutMs?: number;
  /** 每次付费尝试（含传输层重试）之前都会检查。 */
  shouldContinue?: () => Promise<boolean>;
}

/** 供应商返回非 2xx 状态码（消息含状态码，供上层白名单映射）。 */
class ProviderHttpError extends Error {
  constructor(readonly status: number) {
    super(`LLM provider returned HTTP ${status}`);
  }
}

/** 模型响应不完整/为空/非法 JSON（code 即用户可见分类，文案冻结）。 */
class ModelResponseError extends Error {
  constructor(readonly code: 'LLM_OUTPUT_LIMIT' | 'LLM_EMPTY_RESPONSE' | 'LLM_INVALID_JSON') {
    super(code);
  }
}

/** 对思考行为可能耗尽有界响应的模型，显式指定模式。 */
function boundedDeepSeekMode(baseUrl: string, model: string) {
  // 只有这些文档明确支持的 ID 允许显式模式开关；不要猜测遗留别名、
  // 自定义网关或相似域名的模型能力。
  if (
    ![
      'deepseek-flash',
      'deepseek-v4-pro',
      'deepseek-v4-flash',
      'deepseek-v4-flash-vision-exp',
    ].includes(model)
  )
    return {};
  try {
    const url = new URL(baseUrl);
    if (url.protocol === 'https:' && url.hostname === 'api.deepseek.com') {
      return { thinking: { type: 'disabled' as const } };
    }
  } catch {
    /* 无效的服务端配置由后面的安全传输错误统一处理。 */
  }
  return {};
}

/** OpenAI 兼容格式的单条对话消息。 */
interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** 一次对话调用返回的原始内容与 token 用量。 */
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
  /** 初始尝试之后的重试次数（总尝试次数 = 1 + 2 = 3）。 */
  private readonly maxRetries = 2;

  constructor(
    private readonly settings: SettingsService,
    private readonly budgets: LlmBudgetService,
  ) {}

  /** 已保存的密钥即使损坏也算"已配置"：调用方不得静默降级到 basic 引擎。 */
  async isConfigured(userId: string, connectionId?: string): Promise<boolean> {
    if (connectionId) return Boolean(await this.settings.getLlmConfig(userId, connectionId));
    return (await this.settings.getSettings(userId)).llm.engine === 'llm';
  }

  async validateConnectionIds(userId: string, ids: string[]): Promise<void> {
    for (const id of new Set(ids)) await this.settings.getLlmConfig(userId, id);
  }

  /** 只返回可对外的执行元数据；凭据绝不进入报告。 */
  async getExecutionInfo(userId: string): Promise<{
    provider: string;
    modelFast: string;
    modelSlow: string;
  } | null> {
    const { llm } = await this.settings.getSettings(userId);
    if (llm.engine === 'basic') return null;
    return { provider: llm.source, modelFast: llm.fastModel, modelSlow: llm.slowModel };
  }

  /** 在便宜的 fast 模型上做自由文本对话。 */
  async chatFast(
    messages: ChatMessage[],
    userId: string,
    options?: LlmCallOptions,
  ): Promise<ChatResponse> {
    return this.chat(messages, 'fast', userId, options);
  }

  /** 在高质量的 slow 模型上做自由文本对话。 */
  async chatSlow(
    messages: ChatMessage[],
    userId: string,
    options?: LlmCallOptions,
  ): Promise<ChatResponse> {
    return this.chat(messages, 'slow', userId, options);
  }

  /** fast 模型的 JSON 模式对话；返回解析后的对象与 token 数。 */
  async chatFastJSON(
    messages: ChatMessage[],
    userId: string,
    options?: LlmCallOptions,
  ): Promise<{ data: unknown; tokens: number }> {
    return this.chatJSON(messages, 'fast', userId, options);
  }

  /** slow 模型的 JSON 模式对话；返回解析后的对象与 token 数。 */
  async chatSlowJSON(
    messages: ChatMessage[],
    userId: string,
    options?: LlmCallOptions,
  ): Promise<{ data: unknown; tokens: number }> {
    return this.chatJSON(messages, 'slow', userId, options);
  }

  /**
   * 核心 HTTP 调用，带重试与超时。鉴权错误和请求格式错误立即返回；
   * 瞬时失败按退避重试。全部尝试失败后抛出最后一个错误。
   */
  private async chat(
    messages: ChatMessage[],
    tier: 'fast' | 'slow',
    userId: string,
    options: LlmCallOptions = {},
  ): Promise<ChatResponse> {
    // 读取用户配置；未配置密钥直接抛错（上层 safeAnalysisError 会归一化文案）
    const config = await this.settings.getLlmConfig(userId, options.connectionId);
    if (!config) throw new Error('No LLM API key configured');
    // 用户自配源要做公网地址规范化；服务端源只剥尾部斜杠
    const baseUrl =
      config.source === 'user'
        ? await normalizePublicLlmBaseUrl(config.baseUrl)
        : config.baseUrl.replace(/\/+$/u, '');
    const model = tier === 'fast' ? config.fastModel : config.slowModel;

    // 所有重试共用同一个任务 id，但每次 HTTP 请求都有各自独立的预算预留
    const taskId = options.taskId ?? randomUUID();
    const maxRetries = options.retryPolicy === 'none' ? 0 : this.maxRetries;
    const timeoutMs = Number.isFinite(options.timeoutMs)
      ? Math.max(1000, Math.min(120_000, Math.trunc(options.timeoutMs)))
      : this.timeoutMs;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      // 每次付费尝试前检查调用方是否要求继续（如流水线已停止）
      if (options.shouldContinue && !(await options.shouldContinue()))
        throw new Error('LLM request cancelled');
      // 刻意放在网络 catch 之外：预算/数据库失败绝不能重试或绕过记账
      const reservation = await this.budgets.reserve(userId, {
        ...options,
        taskId,
        model,
        messages,
      });
      // 输出上限字段按模型家族选择：o 系列/gpt-5 系用 max_completion_tokens，其余用 max_tokens
      const outputLimit = reservation.omitOutputLimit
        ? {}
        : /^(?:o[1-9](?:-|$)|gpt-5(?:[.-]|$))/u.test(model)
          ? { max_completion_tokens: reservation.maxOutputTokens }
          : { max_tokens: reservation.maxOutputTokens };
      const body = { model, messages, ...outputLimit, ...boundedDeepSeekMode(baseUrl, model) };
      let result: ProviderChatPayload;
      try {
        // validateStatus 恒真：HTTP 状态由下面的分支自己判定，便于区分重试类错误
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
        // 超时/网络错误结果不确定：全额扣费，重试也不例外。
        // 若结算本身失败，持久化的预留保持已扣费状态并停止执行。
        await this.budgets.settle(userId, reservation.id, undefined, true);
        // 归一化为三类安全错误：HTTP 状态、超时、网络不可达
        const safeError =
          error instanceof ProviderHttpError
            ? error
            : axios.isAxiosError(error) && ['ECONNABORTED', 'ETIMEDOUT'].includes(error.code ?? '')
              ? new Error('LLM_REQUEST_TIMEOUT')
              : new Error('LLM request failed. Check provider URL and server network.');
        // 鉴权/请求格式类（<500 且非 429）不重试，立即抛出
        if (
          attempt === maxRetries ||
          (error instanceof ProviderHttpError && error.status < 500 && error.status !== 429)
        ) {
          throw safeError;
        }
        // 指数退避：1s、2s、4s…（由重试次数隐式封顶）
        const delayMs = 1000 * Math.pow(2, attempt);
        this.logger.warn(`LLM call attempt ${attempt + 1} failed; retrying in ${delayMs}ms`);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }
      // 成功路径：按实际用量结算预算预留
      const usage = await this.budgets.settle(userId, reservation.id, result?.usage);
      const choice = result?.choices?.[0];
      // 已计费但不完整的响应不能作为决策：不重试、不拿隐藏推理当正文，保留其用量
      if (choice?.finish_reason === 'length') throw new ModelResponseError('LLM_OUTPUT_LIMIT');
      const content = choice?.message?.content;
      if (typeof content !== 'string' || !content.trim())
        throw new ModelResponseError('LLM_EMPTY_RESPONSE');
      return {
        content,
        promptTokens: usage.inputTokens,
        completionTokens: usage.outputTokens,
        totalTokens: usage.chargedTokens,
      };
    }

    // 不可达：循环要么返回要么抛出
    throw new Error('Unreachable');
  }

  /**
   * JSON 模式包装：先前置一条强制严格 JSON 输出的系统消息，再清洗并解析响应。
   * 清洗步骤：
   *   1. 若首尾存在 ```json 围栏则剥掉。
   *   2. 直接尝试 JSON.parse。
   *   3. 失败则用正则扫描最外层 {…} 块再试一次（处理 LLM 在 JSON 外包散文的情况）。
   *   4. 仍失败 → 抛安全错误，不回显模型私有内容。
   */
  private async chatJSON(
    messages: ChatMessage[],
    tier: 'fast' | 'slow',
    userId: string,
    options?: LlmCallOptions,
  ): Promise<{ data: unknown; tokens: number }> {
    // 附加的严格 JSON 系统指令（中文原文即协议的一部分）
    const systemMsg: ChatMessage = {
      role: 'system',
      content:
        '你必须严格按照用户要求的 JSON 格式输出，不要添加任何解释、说明或 markdown 格式。只输出合法的 JSON 字符串。',
    };

    // 保留调用方自带的 system 消息，再追加严格 JSON 指令，最后放 user/assistant 消息
    const userMsgs = messages.filter((m) => m.role !== 'system');
    const systemMsgs = messages.filter((m) => m.role === 'system');

    const allMessages: ChatMessage[] = [...systemMsgs, systemMsg, ...userMsgs];

    const result = await this.chat(allMessages, tier, userId, options);

    // 清洗：剥掉 markdown 代码围栏（```json … ```），若 LLM 给输出包了围栏
    let cleaned = result.content.trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    }

    try {
      // 第一步：直接解析清洗后的全文
      const parsed = JSON.parse(cleaned);
      return { data: parsed, tokens: result.totalTokens };
    } catch (parseError) {
      // 兜底：从文本中提取第一个"看起来平衡"的 JSON 对象再解析
      const match = cleaned.match(/\{[\s\S]*\}/);
      if (match) {
        try {
          const parsed = JSON.parse(match[0]);
          return { data: parsed, tokens: result.totalTokens };
        } catch {
          // 落入最终抛错
        }
      }
      throw new ModelResponseError('LLM_INVALID_JSON');
    }
  }
}
