import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '../../common/platform';
import { llmBudgetSettings, llmBudgetUsage } from '../../database/llm-budget.schema';
import type { LlmBudgetSettings, LlmBudgetUsage } from '@shared/council.interface';
import {
  BudgetExceededException, DEFAULT_LLM_BUDGET, estimateInputTokens,
  normalizeBudgetSettings, settleTokenUsage,
  type BudgetMessage, type BudgetReason, type SettledTokenUsage, type TokenReservation,
} from './llm-budget.rules';

type Transaction = Parameters<Parameters<PostgresJsDatabase['transaction']>[0]>[0];
type SettingsRow = typeof llmBudgetSettings.$inferSelect;
export interface BudgetReservation extends TokenReservation { id: string; taskId: string; omitOutputLimit?: boolean;
  replayed?: boolean;
  /** The user's rate at reservation time, never a provider invoice or a read-time repricing. */
  estimateRates?: { inputUsdPerMillion: number; outputUsdPerMillion: number } }
export interface ReserveBudgetRequest {
  dispatchKey?: string;
  requestHash?: string;
  taskId?: string;
  purpose?: string;
  model: string;
  messages: readonly BudgetMessage[];
  maxOutputTokens?: number;
}

@Injectable()
export class LlmBudgetService {
  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase) {}

  private settingsFromRow(row?: SettingsRow): LlmBudgetSettings {
    if (!row) return { ...DEFAULT_LLM_BUDGET };
    return normalizeBudgetSettings({
      enabled: row.enabled,
      dailyTokenLimit: row.dailyTokenLimit, monthlyTokenLimit: row.monthlyTokenLimit,
      perTaskTokenLimit: row.perTaskTokenLimit, maxInputTokens: row.maxInputTokens,
      maxOutputTokens: row.maxOutputTokens, maxCallsPerTask: row.maxCallsPerTask,
      dailyCallLimit: row.dailyCallLimit,
      inputUsdPerMillion: row.inputUsdPerMillion === null ? null : Number(row.inputUsdPerMillion),
      outputUsdPerMillion: row.outputUsdPerMillion === null ? null : Number(row.outputUsdPerMillion),
    });
  }

  private async ownerLock(tx: Transaction, userId: string): Promise<void> {
    // The transaction-scoped lock serializes reservations across pools/workers.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${'llm-budget:' + userId}, 0))`);
  }

  async getSettings(userId: string): Promise<LlmBudgetSettings> {
    const [row] = await this.db.select().from(llmBudgetSettings).where(eq(llmBudgetSettings.owner, userId));
    return this.settingsFromRow(row);
  }

  async saveSettings(userId: string, input: unknown): Promise<LlmBudgetSettings> {
    const settings = normalizeBudgetSettings(input);
    await this.db.transaction(async (tx) => {
      await this.ownerLock(tx, userId);
      const values = {
        ...settings, owner: userId, updatedAt: new Date(),
        inputUsdPerMillion: settings.inputUsdPerMillion === null ? null : String(settings.inputUsdPerMillion),
        outputUsdPerMillion: settings.outputUsdPerMillion === null ? null : String(settings.outputUsdPerMillion),
      };
      await tx.insert(llmBudgetSettings).values(values)
        .onConflictDoUpdate({ target: llmBudgetSettings.owner, set: values });
    });
    return settings;
  }

  private async totals(tx: Transaction, userId: string, taskId: string) {
    // All periods use UTC, independent of the server/session timezone.
    const day = sql`date_trunc('day', CURRENT_TIMESTAMP AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`;
    const month = sql`date_trunc('month', CURRENT_TIMESTAMP AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`;
    const [row] = await tx.select({
      dayTokens: sql<number>`coalesce(sum(${llmBudgetUsage.chargedTokens}) filter (where ${llmBudgetUsage.createdAt} >= ${day}), 0)`.mapWith(Number),
      monthTokens: sql<number>`coalesce(sum(${llmBudgetUsage.chargedTokens}) filter (where ${llmBudgetUsage.createdAt} >= ${month}), 0)`.mapWith(Number),
      dayCalls: sql<number>`count(*) filter (where ${llmBudgetUsage.createdAt} >= ${day})`.mapWith(Number),
      taskTokens: sql<number>`coalesce(sum(${llmBudgetUsage.chargedTokens}) filter (where ${llmBudgetUsage.taskId} = ${taskId}), 0)`.mapWith(Number),
      taskCalls: sql<number>`count(*) filter (where ${llmBudgetUsage.taskId} = ${taskId})`.mapWith(Number),
      reservedTokens: sql<number>`coalesce(sum(${llmBudgetUsage.chargedTokens}) filter (where ${llmBudgetUsage.status} = 'reserved'), 0)`.mapWith(Number),
      monthInput: sql<number>`coalesce(sum(${llmBudgetUsage.inputTokens}) filter (where ${llmBudgetUsage.createdAt} >= ${month}), 0)`.mapWith(Number),
      monthOutput: sql<number>`coalesce(sum(${llmBudgetUsage.outputTokens}) filter (where ${llmBudgetUsage.createdAt} >= ${month}), 0)`.mapWith(Number),
    }).from(llmBudgetUsage).where(eq(llmBudgetUsage.owner, userId));
    return row;
  }

  async reserve(userId: string, input: ReserveBudgetRequest, beforeDispatch?: () => Promise<void>, transaction?: Transaction): Promise<BudgetReservation> {
    const text = (value: unknown, fallback: string, maximum: number): string => {
      if (value === undefined) return fallback;
      if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\u0000-\u001f]/u.test(value)) {
        throw new BadRequestException('Invalid LLM request metadata');
      }
      return value.trim();
    };
    const taskId = text(input.taskId, randomUUID(), 160);
    const purpose = text(input.purpose, 'analysis', 160);
    const model = text(input.model, '', 120);
    const inputTokens = estimateInputTokens(input.messages);
    if (input.maxOutputTokens !== undefined && (!Number.isSafeInteger(input.maxOutputTokens) || input.maxOutputTokens < 1)) {
      throw new BadRequestException('maxOutputTokens must be a positive integer');
    }
    if (Boolean(input.dispatchKey) !== Boolean(input.requestHash)) throw new BadRequestException('LLM_DISPATCH_IDENTITY_REQUIRED');
    const reserveInTransaction = async (tx: Transaction): Promise<BudgetReservation> => {
      await this.ownerLock(tx, userId);
      if (input.dispatchKey) {
        const [prior] = await tx.select().from(llmBudgetUsage).where(and(eq(llmBudgetUsage.owner, userId), eq(llmBudgetUsage.dispatchKey, input.dispatchKey)));
        if (prior) {
          if (prior.requestHash !== input.requestHash || prior.model !== model || prior.taskId !== taskId) throw new ConflictException('LLM_DISPATCH_CONFLICT');
          return { id: prior.id, taskId, inputTokens: prior.inputTokens, maxOutputTokens: prior.maxOutputTokens,
            reservedTokens: prior.reservedTokens, replayed: true };
        }
      }
      const [row] = await tx.select().from(llmBudgetSettings).where(eq(llmBudgetSettings.owner, userId));
      const settings = this.settingsFromRow(row);
      if (settings.enabled && inputTokens > settings.maxInputTokens) throw new BudgetExceededException('input_tokens', taskId);
      // A durable request hash describes the actual wire cap. A changed budget
      // cannot silently clamp the reservation while leaving a larger SDK cap.
      if (input.dispatchKey && settings.enabled && input.maxOutputTokens !== undefined
        && input.maxOutputTokens > settings.maxOutputTokens) throw new BadRequestException('RUNTIME_OUTPUT_LIMIT_CHANGED');
      // Keep a finite usage estimate for providers that omit accounting. It is not sent as a cap when limits are off.
      const maxOutputTokens = settings.enabled
        ? Math.min(input.maxOutputTokens ?? settings.maxOutputTokens, settings.maxOutputTokens)
        : input.maxOutputTokens ?? 4096;
      const reservedTokens = inputTokens + maxOutputTokens;
      const used = await this.totals(tx, userId, taskId);
      const checks: Array<[BudgetReason, boolean]> = [
        ['daily_calls', used.dayCalls + 1 > settings.dailyCallLimit],
        ['task_calls', used.taskCalls + 1 > settings.maxCallsPerTask],
        ['daily_tokens', used.dayTokens + reservedTokens > settings.dailyTokenLimit],
        ['monthly_tokens', used.monthTokens + reservedTokens > settings.monthlyTokenLimit],
        ['task_tokens', used.taskTokens + reservedTokens > settings.perTaskTokenLimit],
      ];
      const blocked = checks.find(([, exceeded]) => exceeded);
      if (settings.enabled && blocked) throw new BudgetExceededException(blocked[0], taskId);
      const id = randomUUID();
      await tx.insert(llmBudgetUsage).values({
        dispatchKey: input.dispatchKey ?? null, requestHash: input.requestHash ?? null,
        id, owner: userId, taskId, purpose, model, inputTokens, outputTokens: maxOutputTokens,
        maxOutputTokens, reservedTokens, chargedTokens: reservedTokens, status: 'reserved',
      });
      return { id, taskId, inputTokens, maxOutputTokens, reservedTokens,
        omitOutputLimit: !settings.enabled && input.maxOutputTokens === undefined,
        ...(settings.enabled && settings.inputUsdPerMillion !== null && settings.outputUsdPerMillion !== null
          ? { estimateRates: { inputUsdPerMillion: settings.inputUsdPerMillion, outputUsdPerMillion: settings.outputUsdPerMillion } }
          : {}) };
    };
    const reservation = transaction ? await reserveInTransaction(transaction) : await this.db.transaction(reserveInTransaction);
    if (reservation.replayed) return reservation;
    if (transaction) { await beforeDispatch?.(); return reservation; }
    // This callback has no transport capability. Rollback is confined to its failure,
    // before the reservation is returned to the caller that can start a network call.
    try { await beforeDispatch?.(); }
    catch (error) {
      await this.db.transaction(async tx => {
        await this.ownerLock(tx, userId);
        await tx.delete(llmBudgetUsage).where(and(eq(llmBudgetUsage.owner, userId),
          eq(llmBudgetUsage.id, reservation.id), eq(llmBudgetUsage.status, 'reserved')));
      });
      throw error;
    }
    return reservation;
  }

  /** Provider facts correct an unknown charge without erasing its prior accounting history. */
  async reconcileDispatchUsage(userId: string, id: string, eventId: string, usage: unknown): Promise<void> {
    if (!eventId || eventId.length > 200) throw new BadRequestException('LLM_USAGE_EVENT_REQUIRED');
    await this.db.transaction(async tx => {
      await this.ownerLock(tx, userId);
      const [row] = await tx.select().from(llmBudgetUsage).where(and(eq(llmBudgetUsage.owner, userId), eq(llmBudgetUsage.id, id)));
      if (!row?.dispatchKey) throw new NotFoundException('LLM_DISPATCH_NOT_FOUND');
      const prior = await tx.execute(sql`select event_id from agent_model_usage_corrections where owner=${userId} and budget_id=${id} and event_id=${eventId}`);
      if (prior.length) return;
      const result = settleTokenUsage(row, usage);
      if (!result.known) throw new BadRequestException('LLM_PROVIDER_USAGE_FACT_REQUIRED');
      await tx.execute(sql`insert into agent_model_usage_corrections(owner,budget_id,event_id,prior_status,prior_tokens,corrected_tokens,facts)
        values(${userId},${id},${eventId},${row.status},${row.chargedTokens},${result.chargedTokens},${JSON.stringify(usage)}::jsonb)`);
      await tx.update(llmBudgetUsage).set({ inputTokens: result.inputTokens, outputTokens: result.outputTokens,
        chargedTokens: result.chargedTokens, status: 'completed', settledAt: new Date() })
        .where(and(eq(llmBudgetUsage.owner, userId), eq(llmBudgetUsage.id, id)));
    });
  }

  async settle(userId: string, id: string, usage?: unknown, failed = false): Promise<SettledTokenUsage> {
    return this.db.transaction(async (tx) => {
      await this.ownerLock(tx, userId);
      const [row] = await tx.select().from(llmBudgetUsage)
        .where(and(eq(llmBudgetUsage.owner, userId), eq(llmBudgetUsage.id, id)));
      if (!row) throw new NotFoundException('LLM reservation not found');
      if (row.status !== 'reserved') return {
        inputTokens: row.inputTokens, outputTokens: row.outputTokens, chargedTokens: row.chargedTokens,
        known: row.status === 'completed',
      };
      const result = settleTokenUsage(row, failed ? undefined : usage);
      await tx.update(llmBudgetUsage).set({
        inputTokens: result.inputTokens, outputTokens: result.outputTokens, chargedTokens: result.chargedTokens,
        status: failed ? 'failed_unknown' : result.known ? 'completed' : 'estimated', settledAt: new Date(),
      }).where(and(eq(llmBudgetUsage.owner, userId), eq(llmBudgetUsage.id, id)));
      return result;
    });
  }

  async getUsage(userId: string): Promise<LlmBudgetUsage> {
    return this.db.transaction(async (tx) => {
      await this.ownerLock(tx, userId);
      const [row] = await tx.select().from(llmBudgetSettings).where(eq(llmBudgetSettings.owner, userId));
      const settings = this.settingsFromRow(row);
      const used = await this.totals(tx, userId, '');
      const recent = await tx.select().from(llmBudgetUsage).where(eq(llmBudgetUsage.owner, userId))
        .orderBy(desc(llmBudgetUsage.createdAt)).limit(30);
      return {
        settings, dayTokens: used.dayTokens, monthTokens: used.monthTokens, dayCalls: used.dayCalls,
        reservedTokens: used.reservedTokens,
        estimatedCostUsd: settings.inputUsdPerMillion === null || settings.outputUsdPerMillion === null ? null
          : (used.monthInput * settings.inputUsdPerMillion + used.monthOutput * settings.outputUsdPerMillion) / 1_000_000,
        recent: recent.map((item) => ({
          id: item.id, taskId: item.taskId, purpose: item.purpose, model: item.model,
          inputTokens: item.inputTokens, outputTokens: item.outputTokens, chargedTokens: item.chargedTokens,
          status: item.status, createdAt: item.createdAt.toISOString(),
        })),
      };
    });
  }
}
