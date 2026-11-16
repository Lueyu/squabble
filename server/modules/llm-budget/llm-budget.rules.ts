import { BadRequestException, HttpException, HttpStatus } from '@nestjs/common';
import type { LlmBudgetSettings } from '@shared/council.interface';

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

export type BudgetReason =
  'input_tokens' | 'daily_tokens' | 'monthly_tokens' | 'task_tokens' | 'daily_calls' | 'task_calls';

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

export interface BudgetMessage {
  role: string;
  content: string;
}
export interface TokenReservation {
  inputTokens: number;
  maxOutputTokens: number;
  reservedTokens: number;
}
export interface SettledTokenUsage {
  inputTokens: number;
  outputTokens: number;
  chargedTokens: number;
  known: boolean;
}

/** Full replacement avoids accepting misspelled limits as unused properties. */
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

/** UTF8 bytes are deliberately conservative for unknown provider tokenizers. */
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
  // Nonempty requests always consume prompt tokens. Compatible providers may
  // use zero placeholders when accounting is unavailable; those are not free calls.
  if (!valid(data.prompt_tokens) || data.prompt_tokens === 0 || !valid(data.completion_tokens))
    return unknownUsage;
  const sum = data.prompt_tokens + data.completion_tokens;
  if (
    sum > 1_000_000_000 ||
    (data.total_tokens !== undefined && (!valid(data.total_tokens) || data.total_tokens < sum))
  )
    return unknownUsage;
  const total = data.total_tokens === undefined ? sum : (data.total_tokens as number);
  // Extra total usage (for example reasoning tokens) is charged as output.
  return {
    inputTokens: data.prompt_tokens,
    outputTokens: total - data.prompt_tokens,
    chargedTokens: total,
    known: true,
  };
}
