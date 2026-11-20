/**
 * llm-budget.rules.ts — LLM 预算的纯规则函数：默认预算、设置校验、token 估算与用量结算。
 *
 * 职责边界：
 *  - normalizeBudgetSettings：整体替换式校验预算设置（未知字段/越界/不一致直接拒绝）。
 *  - estimateInputTokens：按 UTF-8 字节数保守估算输入 token。
 *  - settleTokenUsage：按 provider 回报结算真实用量，无效回报回退为预留估算。
 *  - BudgetExceededException：限额被超出时的 HTTP 429 异常（reason/taskId 随响应返回）。
 * 上下游：
 *  - 上游：LlmBudgetService、LlmService（估算与结算）、council.context（estimateInputTokens 预算闸门）。
 *  - 下游：无（仅依赖 @nestjs/common 与共享类型）。
 * 关键约定：
 *  - 限额必须满足 input+output ≤ perTask ≤ daily ≤ monthly，且 maxCallsPerTask ≤ dailyCallLimit。
 *  - 有效用量回报：prompt_tokens>0、completion_tokens≥0，且 total ≥ prompt+completion；超出部分按输出计费。
 */
import { BadRequestException, HttpException, HttpStatus } from '@nestjs/common';
import type { LlmBudgetSettings } from '@shared/council.interface';

/** 默认预算：日 6 万 / 月 60 万 / 单任务 2.4 万 token；输入 ≤6000、输出 ≤1000；单任务 ≤8 次、日 ≤30 次。 */
export const DEFAULT_LLM_BUDGET: Readonly<LlmBudgetSettings> = Object.freeze({
  enabled: true,
  dailyTokenLimit: 60_000,
  monthlyTokenLimit: 600_000,
  perTaskTokenLimit: 24_000,
  maxInputTokens: 6_000,
  maxOutputTokens: 1_000,
  maxCallsPerTask: 8,
  dailyCallLimit: 30,
  inputUsdPerMillion: null,
  outputUsdPerMillion: null,
});

/** 限额被超出的原因：input_tokens / daily_tokens / monthly_tokens / task_tokens / daily_calls / task_calls。 */
export type BudgetReason =
  'input_tokens' | 'daily_tokens' | 'monthly_tokens' | 'task_tokens' | 'daily_calls' | 'task_calls';

/** 限额异常：HTTP 429，响应体携带 code/reason/taskId 与用户可读文案。 */
export class BudgetExceededException extends HttpException {
  readonly code = 'LLM_BUDGET_EXCEEDED';
  constructor(
    readonly reason: BudgetReason,
    readonly taskId?: string,
  ) {
    super(
      {
        code: 'LLM_BUDGET_EXCEEDED',
        reason,
        taskId,
        message: `LLM budget limit reached: ${reason}. Review the budget before retrying.`,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}

/** 一条对话消息（role 仅允许 system/user/assistant）。 */
export interface BudgetMessage {
  role: string;
  content: string;
}
/** 预留时的 token 计数：估算输入、输出上限与预留总量。 */
export interface TokenReservation {
  inputTokens: number;
  maxOutputTokens: number;
  reservedTokens: number;
}
/** 结算结果：真实/估算用量与 known 标记（false 表示按预留估算）。 */
export interface SettledTokenUsage {
  inputTokens: number;
  outputTokens: number;
  chargedTokens: number;
  known: boolean;
}

/** 采用整体替换式校验，避免把拼错的限额字段当作未使用属性默默接受。 */
export function normalizeBudgetSettings(value: unknown): LlmBudgetSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequestException('Budget settings must be an object');
  }
  const input = value as Record<string, unknown>;
  const keys = Object.keys(DEFAULT_LLM_BUDGET);
  if (Object.keys(input).some((key) => !keys.includes(key))) {
    throw new BadRequestException('Unknown budget setting');
  }
  const integer = (key: string, maximum: number): number => {
    const number = input[key];
    if (
      typeof number !== 'number' ||
      !Number.isSafeInteger(number) ||
      number < 1 ||
      number > maximum
    ) {
      throw new BadRequestException(`${key} must be an integer from 1 to ${maximum}`);
    }
    return number;
  };
  const rate = (key: string): number | null => {
    const number = input[key];
    if (number === null) return null;
    if (typeof number !== 'number' || !Number.isFinite(number) || number < 0 || number > 100_000) {
      throw new BadRequestException(`${key} must be null or a nonnegative rate up to 100000`);
    }
    return number;
  };
  const result: LlmBudgetSettings = {
    enabled: input.enabled === undefined ? true : (input.enabled as boolean),
    dailyTokenLimit: integer('dailyTokenLimit', 1_000_000_000),
    monthlyTokenLimit: integer('monthlyTokenLimit', 1_000_000_000),
    perTaskTokenLimit: integer('perTaskTokenLimit', 1_000_000_000),
    maxInputTokens: integer('maxInputTokens', 1_000_000),
    maxOutputTokens: integer('maxOutputTokens', 1_000_000),
    maxCallsPerTask: integer('maxCallsPerTask', 10_000),
    dailyCallLimit: integer('dailyCallLimit', 100_000),
    inputUsdPerMillion: rate('inputUsdPerMillion'),
    outputUsdPerMillion: rate('outputUsdPerMillion'),
  };
  if (typeof result.enabled !== 'boolean')
    throw new BadRequestException('Budget enabled must be a boolean');
  // 一致性校验：input+output ≤ 任务 ≤ 日 ≤ 月，且任务调用数 ≤ 日调用数。
  if (
    result.perTaskTokenLimit > result.dailyTokenLimit ||
    result.dailyTokenLimit > result.monthlyTokenLimit ||
    result.maxInputTokens + result.maxOutputTokens > result.perTaskTokenLimit ||
    result.maxCallsPerTask > result.dailyCallLimit
  ) {
    throw new BadRequestException(
      'Budget limits must fit: input + output <= task <= day <= month and task calls <= day calls',
    );
  }
  return result;
}

/** 对未知的 provider 分词器，按 UTF-8 字节数做保守估算（+32 基数、每条消息 +16）。 */
export function estimateInputTokens(messages: readonly BudgetMessage[]): number {
  if (
    !Array.isArray(messages) ||
    !messages.length ||
    messages.some(
      (message) =>
        !message ||
        !['system', 'user', 'assistant'].includes(message.role) ||
        typeof message.content !== 'string',
    )
  ) {
    throw new BadRequestException('Invalid chat messages');
  }
  return Buffer.byteLength(JSON.stringify(messages), 'utf8') + 32 + messages.length * 16;
}

/** 按 provider 回报结算用量；回报无效（缺失/为 0/自相矛盾）时回退为预留估算（known=false）。 */
export function settleTokenUsage(reservation: TokenReservation, usage: unknown): SettledTokenUsage {
  const unknownUsage: SettledTokenUsage = {
    inputTokens: reservation.inputTokens,
    outputTokens: reservation.maxOutputTokens,
    chargedTokens: reservation.reservedTokens,
    known: false,
  };
  if (!usage || typeof usage !== 'object') return unknownUsage;
  const data = usage as Record<string, unknown>;
  const valid = (value: unknown): value is number =>
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= 1_000_000_000;
  // 非空请求必然消耗 prompt token。兼容的 provider 在无法核算用量时可能返回 0 占位；
  // 那不代表本次调用免费。
  if (!valid(data.prompt_tokens) || data.prompt_tokens === 0 || !valid(data.completion_tokens))
    return unknownUsage;
  const sum = data.prompt_tokens + data.completion_tokens;
  if (
    sum > 1_000_000_000 ||
    (data.total_tokens !== undefined && (!valid(data.total_tokens) || data.total_tokens < sum))
  )
    return unknownUsage;
  const total = data.total_tokens === undefined ? sum : (data.total_tokens as number);
  // total 超出 prompt+completion 的部分（例如推理 token）按输出计费。
  return {
    inputTokens: data.prompt_tokens,
    outputTokens: total - data.prompt_tokens,
    chargedTokens: total,
    known: true,
  };
}
