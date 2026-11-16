/**
 * llm-budget.service.ts — LLM 调用预算服务（预留/结算/查询）。
 *
 * 职责边界：
 *  - reserve：调用前预留 token（估算输入 + 输出上限），校验日/月/任务三层 token 与调用次数限额。
 *  - settle：调用后按 provider 回报结算真实用量；失败标记 failed_unknown。
 *  - getSettings/saveSettings/getUsage：预算设置 CRUD 与用量统计（含最近 30 条记录）。
 *  - 不做模型调用；预算关闭时预留仍记录用量但不拦截。
 * 上下游：
 *  - 上游：LlmService（每次调用前 reserve、调用后 settle）、CouncilService（publish 汇总 chargedTokens）、前端设置页（经 LlmBudgetController）。
 *  - 下游：llm-budget.rules（DEFAULT_LLM_BUDGET/estimateInputTokens/settleTokenUsage）、llm-budget.schema（Postgres 表）。
 * 关键约定：
 *  - 所有统计周期按 UTC 计算；owner 级 advisory 事务锁串行化并发预留。
 *  - 预算关闭时输出上限取请求值或 4096，且不作为 cap 下发（omitOutputLimit）。
 *  - 单条费用估算 =（月输入 × 输入单价 + 月输出 × 输出单价）/ 1e6，单价未配置时返回 null。
 */
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '../../common/platform';
import { llmBudgetSettings, llmBudgetUsage } from '../../database/llm-budget.schema';
import type { LlmBudgetSettings, LlmBudgetUsage } from '@shared/council.interface';
import {
  BudgetExceededException,
  DEFAULT_LLM_BUDGET,
  estimateInputTokens,
  normalizeBudgetSettings,
  settleTokenUsage,
  type BudgetMessage,
  type BudgetReason,
  type SettledTokenUsage,
  type TokenReservation,
} from './llm-budget.rules';

type Transaction = Parameters<Parameters<PostgresJsDatabase['transaction']>[0]>[0];
type SettingsRow = typeof llmBudgetSettings.$inferSelect;
/** 一次预算预留：预留 id、任务 id 与 token 计数（可携带输出上限豁免标记）。 */
export interface BudgetReservation extends TokenReservation {
  id: string;
  taskId: string;
  omitOutputLimit?: boolean;
}
/** 预留请求：任务/用途标识（可选）、模型名、消息列表与可选输出上限。 */
export interface ReserveBudgetRequest {
  taskId?: string;
  purpose?: string;
  model: string;
  messages: readonly BudgetMessage[];
  maxOutputTokens?: number;
}

@Injectable()
export class LlmBudgetService {
  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase) {}

  /** 数据库设置行 → 领域设置对象（无行时返回默认预算）。 */
  private settingsFromRow(row?: SettingsRow): LlmBudgetSettings {
    if (!row) return { ...DEFAULT_LLM_BUDGET };
    return normalizeBudgetSettings({
      enabled: row.enabled,
      dailyTokenLimit: row.dailyTokenLimit,
      monthlyTokenLimit: row.monthlyTokenLimit,
      perTaskTokenLimit: row.perTaskTokenLimit,
      maxInputTokens: row.maxInputTokens,
      maxOutputTokens: row.maxOutputTokens,
      maxCallsPerTask: row.maxCallsPerTask,
      dailyCallLimit: row.dailyCallLimit,
      inputUsdPerMillion: row.inputUsdPerMillion === null ? null : Number(row.inputUsdPerMillion),
      outputUsdPerMillion:
        row.outputUsdPerMillion === null ? null : Number(row.outputUsdPerMillion),
    });
  }

  private async ownerLock(tx: Transaction, userId: string): Promise<void> {
    // 事务级锁在不同连接池/worker 之间串行化预留操作。
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${'llm-budget:' + userId}, 0))`,
    );
  }

  /** 读取用户预算设置（无记录返回默认值）。 */
  async getSettings(userId: string): Promise<LlmBudgetSettings> {
    const [row] = await this.db
      .select()
      .from(llmBudgetSettings)
      .where(eq(llmBudgetSettings.owner, userId));
    return this.settingsFromRow(row);
  }

  /** 整体替换式保存预算设置（advisory 锁 + owner 冲突 upsert）。 */
  async saveSettings(userId: string, input: unknown): Promise<LlmBudgetSettings> {
    const settings = normalizeBudgetSettings(input);
    await this.db.transaction(async (tx) => {
      await this.ownerLock(tx, userId);
      const values = {
        ...settings,
        owner: userId,
        updatedAt: new Date(),
        inputUsdPerMillion:
          settings.inputUsdPerMillion === null ? null : String(settings.inputUsdPerMillion),
        outputUsdPerMillion:
          settings.outputUsdPerMillion === null ? null : String(settings.outputUsdPerMillion),
      };
      await tx
        .insert(llmBudgetSettings)
        .values(values)
        .onConflictDoUpdate({ target: llmBudgetSettings.owner, set: values });
    });
    return settings;
  }

  /** 汇总当日/当月 token、当日调用数、任务 token 与调用数、在途预留与月度输入/输出。 */
  private async totals(tx: Transaction, userId: string, taskId: string) {
    // 所有统计周期一律使用 UTC，与服务器/会话时区无关。
    const day = sql`date_trunc('day', CURRENT_TIMESTAMP AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`;
    const month = sql`date_trunc('month', CURRENT_TIMESTAMP AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`;
    const [row] = await tx
      .select({
        dayTokens:
          sql<number>`coalesce(sum(${llmBudgetUsage.chargedTokens}) filter (where ${llmBudgetUsage.createdAt} >= ${day}), 0)`.mapWith(
            Number,
          ),
        monthTokens:
          sql<number>`coalesce(sum(${llmBudgetUsage.chargedTokens}) filter (where ${llmBudgetUsage.createdAt} >= ${month}), 0)`.mapWith(
            Number,
          ),
        dayCalls:
          sql<number>`count(*) filter (where ${llmBudgetUsage.createdAt} >= ${day})`.mapWith(
            Number,
          ),
        taskTokens:
          sql<number>`coalesce(sum(${llmBudgetUsage.chargedTokens}) filter (where ${llmBudgetUsage.taskId} = ${taskId}), 0)`.mapWith(
            Number,
          ),
        taskCalls:
          sql<number>`count(*) filter (where ${llmBudgetUsage.taskId} = ${taskId})`.mapWith(Number),
        reservedTokens:
          sql<number>`coalesce(sum(${llmBudgetUsage.chargedTokens}) filter (where ${llmBudgetUsage.status} = 'reserved'), 0)`.mapWith(
            Number,
          ),
        monthInput:
          sql<number>`coalesce(sum(${llmBudgetUsage.inputTokens}) filter (where ${llmBudgetUsage.createdAt} >= ${month}), 0)`.mapWith(
            Number,
          ),
        monthOutput:
          sql<number>`coalesce(sum(${llmBudgetUsage.outputTokens}) filter (where ${llmBudgetUsage.createdAt} >= ${month}), 0)`.mapWith(
            Number,
          ),
      })
      .from(llmBudgetUsage)
      .where(eq(llmBudgetUsage.owner, userId));
    return row;
  }

  /**
   * 调用前预留预算：元数据校验 → 事务内锁定并读取设置 → 输入/输出预算计算 → 五项限额检查 →
   * 写入 reserved 用量行并返回预留（预算关闭时只记录不拦截）。
   * @throws BudgetExceededException 任一限额被超出时（HTTP 429）。
   */
  async reserve(userId: string, input: ReserveBudgetRequest): Promise<BudgetReservation> {
    const text = (value: unknown, fallback: string, maximum: number): string => {
      if (value === undefined) return fallback;
      if (
        typeof value !== 'string' ||
        !value.trim() ||
        value.length > maximum ||
        /[\u0000-\u001f]/u.test(value)
      ) {
        throw new BadRequestException('Invalid LLM request metadata');
      }
      return value.trim();
    };
    const taskId = text(input.taskId, randomUUID(), 160);
    const purpose = text(input.purpose, 'analysis', 160);
    const model = text(input.model, '', 120);
    // 估算输入 token 并校验输出上限为正整数。
    const inputTokens = estimateInputTokens(input.messages);
    if (
      input.maxOutputTokens !== undefined &&
      (!Number.isSafeInteger(input.maxOutputTokens) || input.maxOutputTokens < 1)
    ) {
      throw new BadRequestException('maxOutputTokens must be a positive integer');
    }
    return this.db.transaction(async (tx) => {
      // 锁定属主并读取设置；预算开启时输入超限直接拒绝。
      await this.ownerLock(tx, userId);
      const [row] = await tx
        .select()
        .from(llmBudgetSettings)
        .where(eq(llmBudgetSettings.owner, userId));
      const settings = this.settingsFromRow(row);
      if (settings.enabled && inputTokens > settings.maxInputTokens)
        throw new BudgetExceededException('input_tokens', taskId);
      // 对不回报用量的 provider 保留有限的使用估算；预算关闭时该值不作为上限下发。
      const maxOutputTokens = settings.enabled
        ? Math.min(input.maxOutputTokens ?? settings.maxOutputTokens, settings.maxOutputTokens)
        : (input.maxOutputTokens ?? 4096);
      const reservedTokens = inputTokens + maxOutputTokens;
      const used = await this.totals(tx, userId, taskId);
      // 五项限额检查：日调用数、任务调用数、日 token、月 token、任务 token。
      const checks: Array<[BudgetReason, boolean]> = [
        ['daily_calls', used.dayCalls + 1 > settings.dailyCallLimit],
        ['task_calls', used.taskCalls + 1 > settings.maxCallsPerTask],
        ['daily_tokens', used.dayTokens + reservedTokens > settings.dailyTokenLimit],
        ['monthly_tokens', used.monthTokens + reservedTokens > settings.monthlyTokenLimit],
        ['task_tokens', used.taskTokens + reservedTokens > settings.perTaskTokenLimit],
      ];
      const blocked = checks.find(([, exceeded]) => exceeded);
      if (settings.enabled && blocked) throw new BudgetExceededException(blocked[0], taskId);
      // 写入 reserved 用量行（chargedTokens 先按预留值计，结算时改写）。
      const id = randomUUID();
      await tx.insert(llmBudgetUsage).values({
        id,
        owner: userId,
        taskId,
        purpose,
        model,
        inputTokens,
        outputTokens: maxOutputTokens,
        maxOutputTokens,
        reservedTokens,
        chargedTokens: reservedTokens,
        status: 'reserved',
      });
      return {
        id,
        taskId,
        inputTokens,
        maxOutputTokens,
        reservedTokens,
        omitOutputLimit: !settings.enabled && input.maxOutputTokens === undefined,
      };
    });
  }

  /**
   * 结算一次预留：锁定属主与预留行；已结算的预留幂等返回既有结果。
   * failed=true 记 failed_unknown；provider 回报有效则按回报结算，否则按预留估算（known=false）。
   */
  async settle(
    userId: string,
    id: string,
    usage?: unknown,
    failed = false,
  ): Promise<SettledTokenUsage> {
    return this.db.transaction(async (tx) => {
      await this.ownerLock(tx, userId);
      const [row] = await tx
        .select()
        .from(llmBudgetUsage)
        .where(and(eq(llmBudgetUsage.owner, userId), eq(llmBudgetUsage.id, id)));
      if (!row) throw new NotFoundException('LLM reservation not found');
      // 幂等：非 reserved 状态的预留直接返回既有计数。
      if (row.status !== 'reserved')
        return {
          inputTokens: row.inputTokens,
          outputTokens: row.outputTokens,
          chargedTokens: row.chargedTokens,
          known: row.status === 'completed',
        };
      // 结算并把结果写回（failed_unknown / completed / estimated）。
      const result = settleTokenUsage(row, failed ? undefined : usage);
      await tx
        .update(llmBudgetUsage)
        .set({
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          chargedTokens: result.chargedTokens,
          status: failed ? 'failed_unknown' : result.known ? 'completed' : 'estimated',
          settledAt: new Date(),
        })
        .where(and(eq(llmBudgetUsage.owner, userId), eq(llmBudgetUsage.id, id)));
      return result;
    });
  }

  /** 用量统计：设置 + 当日/当月汇总 + 在途预留 + 估算成本 + 最近 30 条记录。 */
  async getUsage(userId: string): Promise<LlmBudgetUsage> {
    return this.db.transaction(async (tx) => {
      await this.ownerLock(tx, userId);
      const [row] = await tx
        .select()
        .from(llmBudgetSettings)
        .where(eq(llmBudgetSettings.owner, userId));
      const settings = this.settingsFromRow(row);
      const used = await this.totals(tx, userId, '');
      const recent = await tx
        .select()
        .from(llmBudgetUsage)
        .where(eq(llmBudgetUsage.owner, userId))
        .orderBy(desc(llmBudgetUsage.createdAt))
        .limit(30);
      return {
        settings,
        dayTokens: used.dayTokens,
        monthTokens: used.monthTokens,
        dayCalls: used.dayCalls,
        reservedTokens: used.reservedTokens,
        // 估算成本：单价未配置时返回 null。
        estimatedCostUsd:
          settings.inputUsdPerMillion === null || settings.outputUsdPerMillion === null
            ? null
            : (used.monthInput * settings.inputUsdPerMillion +
                used.monthOutput * settings.outputUsdPerMillion) /
              1_000_000,
        recent: recent.map((item) => ({
          id: item.id,
          taskId: item.taskId,
          purpose: item.purpose,
          model: item.model,
          inputTokens: item.inputTokens,
          outputTokens: item.outputTokens,
          chargedTokens: item.chargedTokens,
          status: item.status,
          createdAt: item.createdAt.toISOString(),
        })),
      };
    });
  }
}
