import { Inject, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '../../common/platform';
import { researchToolUsage } from '../../database/research-tools.schema';

/** Request slots are separate from LLM tokens; uncertain failures are never refunded. */
@Injectable()
export class ResearchToolsBudgetService {
  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase) {}

  async reserve(userId: string, taskId: string): Promise<string> {
    if (!taskId?.trim() || taskId.length > 160 || /[\u0000-\u001f]/u.test(taskId)) {
      throw new Error('RESEARCH_TASK_REQUIRED');
    }
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${'research-tools:' + userId}, 0))`);
      const day = sql`date_trunc('day', CURRENT_TIMESTAMP AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`;
      const [usage] = await tx.select({
        dayCalls: sql<number>`count(*) filter (where ${researchToolUsage.createdAt} >= ${day})`.mapWith(Number),
        taskCalls: sql<number>`count(*) filter (where ${researchToolUsage.taskId} = ${taskId})`.mapWith(Number),
      }).from(researchToolUsage).where(eq(researchToolUsage.owner, userId));
      if (usage.taskCalls >= 2) throw new Error('RESEARCH_TASK_LIMIT');
      if (usage.dayCalls >= 20) throw new Error('RESEARCH_DAILY_LIMIT');
      const [reservation] = await tx.insert(researchToolUsage).values({ owner: userId, taskId })
        .returning({ id: researchToolUsage.id });
      return reservation.id;
    });
  }

  async settle(userId: string, reservationId: string, status: 'succeeded' | 'failed' | 'cancelled'): Promise<void> {
    await this.db.update(researchToolUsage).set({ status, settledAt: new Date() })
      .where(and(eq(researchToolUsage.owner, userId), eq(researchToolUsage.id, reservationId),
        eq(researchToolUsage.status, 'reserved')));
  }
}
