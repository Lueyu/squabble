/**
 * research-tools-budget.service.ts — 深度研究工具的调用槽位预算服务（预留 + 结算）。
 *
 * 职责边界：
 *  - 只管 research_tool_usage 表：同一任务、同一用户的预留次数校验，
 *    槽位预留（reserve）与最终状态回写（settle）。
 *  - 不管研究工具本身的执行，也不管 LLM token 用量计量。
 * 上下游：
 *  - 上游（谁调用这里）：ResearchWebService 在执行一次研究工具调用前通过 reserve 预留槽位。
 *  - 下游（本文件调用谁）：注入的 Drizzle 数据库句柄（PostgresJsDatabase），读写 research_tool_usage 表。
 * 关键约定：
 *  - 请求槽位与 LLM token 配额相互独立计量；结果不确定的失败永不退还槽位（既有行为）。
 *  - 限额硬编码：同一任务（owner+taskId）最多 2 次预留，同一用户每天（UTC 日界）最多 20 次。
 *  - 事务内以 pg_advisory_xact_lock(hashtextextended('research-tools:' + userId)) 串行化并发预留。
 */
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '../../common/platform';
import { researchToolUsage } from '../../database/research-tools.schema';

/**
 * 深度研究工具槽位预算服务。
 * 请求槽位与 LLM token 配额相互独立；结果不确定的失败永不退还槽位。
 */
@Injectable()
export class ResearchToolsBudgetService {
  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase) {}

  async reserve(userId: string, taskId: string): Promise<string> {
    // 校验任务 ID：非空、长度不超过 160、不含控制字符，不满足则统一抛 RESEARCH_TASK_REQUIRED
    if (!taskId?.trim() || taskId.length > 160 || /[\u0000-\u001f]/u.test(taskId)) {
      throw new Error('RESEARCH_TASK_REQUIRED');
    }

    // 用单个事务把"加锁 → 查配额 → 校验 → 插入"原子化，保证并发下限额不被绕过
    return this.db.transaction(async (tx) => {
      // 事务级顾问锁：同一用户的并发 reserve 串行执行，避免同时读到相同的配额计数
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${'research-tools:' + userId}, 0))`,
      );

      // 计算"今天"（UTC）零点时刻，作为按天计数的分界
      const day = sql`date_trunc('day', CURRENT_TIMESTAMP AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`;

      // 一次聚合查出两个配额计数：今天该用户的预留数、该任务 ID 的历史预留数
      const [usage] = await tx
        .select({
          dayCalls:
            sql<number>`count(*) filter (where ${researchToolUsage.createdAt} >= ${day})`.mapWith(
              Number,
            ),
          taskCalls:
            sql<number>`count(*) filter (where ${researchToolUsage.taskId} = ${taskId})`.mapWith(
              Number,
            ),
        })
        .from(researchToolUsage)
        .where(eq(researchToolUsage.owner, userId));

      // 配额校验：任务级达到 2 次、或当日达到 20 次即拒绝预留
      if (usage.taskCalls >= 2) throw new Error('RESEARCH_TASK_LIMIT');
      if (usage.dayCalls >= 20) throw new Error('RESEARCH_DAILY_LIMIT');

      // 通过校验后插入预留行（初始状态由表默认值决定），返回预留 ID
      const [reservation] = await tx
        .insert(researchToolUsage)
        .values({ owner: userId, taskId })
        .returning({ id: researchToolUsage.id });
      return reservation.id;
    });
  }

  async settle(
    userId: string,
    reservationId: string,
    status: 'succeeded' | 'failed' | 'cancelled',
  ): Promise<void> {
    // 仅当预留仍处于 reserved 状态时回写最终状态与结算时间，重复 settle 不生效
    await this.db
      .update(researchToolUsage)
      .set({ status, settledAt: new Date() })
      .where(
        and(
          eq(researchToolUsage.owner, userId),
          eq(researchToolUsage.id, reservationId),
          eq(researchToolUsage.status, 'reserved'),
        ),
      );
  }
}
