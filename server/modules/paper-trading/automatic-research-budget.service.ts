import { Inject, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '../../common/platform';
import { automaticResearchTasks, investmentPolicies } from '../../database/investment-policy.schema';
import { llmBudgetSettings } from '../../database/llm-budget.schema';
import { experiencePreferences } from '../../database/simple-experience.schema';
import { lockMemoryOwner } from '../research-memory/research-memory.fence';
import { paperRiskDay } from './paper-risk-day';

/** Shared by daily reports, discovery, deep research and judgment follow-ups. A claim is never replayable. */
@Injectable()
export class AutomaticResearchBudgetService {
  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase) {}
  async claimAutomaticResearch(owner: string, accountId: string | null, key: string, purpose: string) {
    return this.db.transaction(async tx => {
      await lockMemoryOwner(tx, owner);
      const [prior] = await tx.select().from(automaticResearchTasks).where(and(eq(automaticResearchTasks.owner, owner), eq(automaticResearchTasks.key, key)));
      if (prior) return { claimed: false, taskId: prior.id, reason: 'ALREADY_CLAIMED' };
      const [policy] = accountId ? await tx.select().from(investmentPolicies).where(and(eq(investmentPolicies.owner, owner), eq(investmentPolicies.accountId, accountId))) : [];
      const [budget] = await tx.select().from(llmBudgetSettings).where(eq(llmBudgetSettings.owner, owner));
      const [preferences] = await tx.select().from(experiencePreferences).where(eq(experiencePreferences.owner, owner));
      const dateKey = paperRiskDay(new Date(), policy?.effectiveConfig.timezone ?? preferences?.timezone ?? 'Asia/Shanghai');
      const [{ count }] = await tx.select({ count: sql<number>`count(*)`.mapWith(Number) }).from(automaticResearchTasks)
        .where(and(eq(automaticResearchTasks.owner, owner), eq(automaticResearchTasks.dateKey, dateKey)));
      const limit = Math.min(6, policy?.effectiveConfig.budget.dailyTasks ?? 6, budget?.enabled ? budget.dailyCallLimit : 6);
      if (count >= limit) return { claimed: false, taskId: null, reason: 'AUTOMATIC_DAILY_BUDGET_EXHAUSTED' };
      const [task] = await tx.insert(automaticResearchTasks).values({ owner, accountId, key, purpose, dateKey }).returning();
      return { claimed: true, taskId: task.id, reason: null };
    });
  }
  async reserveCall(owner: string, taskId: string): Promise<void> {
    await this.db.transaction(async tx => {
      await lockMemoryOwner(tx, owner);
      const [task] = await tx.select().from(automaticResearchTasks).where(and(eq(automaticResearchTasks.owner, owner), eq(automaticResearchTasks.id, taskId))).for('update');
      const [budget] = await tx.select().from(llmBudgetSettings).where(eq(llmBudgetSettings.owner, owner));
      if (!task || task.state !== 'claimed' || task.calls >= Math.min(12, budget?.enabled ? budget.maxCallsPerTask : 12)) throw new Error('AUTOMATIC_TASK_CALL_LIMIT');
      await tx.update(automaticResearchTasks).set({ calls: task.calls + 1 }).where(eq(automaticResearchTasks.id, taskId));
    });
  }
  async finish(owner: string, taskId: string, state: 'completed' | 'failed' | 'uncertain') {
    await this.db.update(automaticResearchTasks).set({ state }).where(and(eq(automaticResearchTasks.owner, owner), eq(automaticResearchTasks.id, taskId)));
  }
}
