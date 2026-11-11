import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '../../common/platform';
import { agentRuntimeRuns, agentToolInvocations } from '../../database/agent-tooling.schema';
import { lockMemoryOwner } from '../research-memory/research-memory.fence';

type Tx = Parameters<Parameters<PostgresJsDatabase['transaction']>[0]>[0];
interface Reservation { id: string; amount: string; unit: string; price_version: string; actual_amount: string | null; state: string; revision: number }
export interface ReserveToolQuantity { quantity: number; unit: 'calls' | 'credits' | 'seconds' | 'pages'; priceVersion: string }

/** Quantities are operations, never unknown provider fees disguised as a zero price. */
@Injectable()
export class ToolBudgetService {
  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase) {}

  async reserve(owner: string, runId: string, invocationId: string, input: ReserveToolQuantity, transaction?: Tx): Promise<Reservation> {
    if (!Number.isFinite(input.quantity) || input.quantity <= 0 || !input.priceVersion) throw new Error('TOOL_BUDGET_INVALID');
    const execute = async (tx: Tx): Promise<Reservation> => {
      await lockMemoryOwner(tx, owner);
      const [run] = await tx.select().from(agentRuntimeRuns).where(and(eq(agentRuntimeRuns.owner, owner), eq(agentRuntimeRuns.id, runId))).for('update');
      const [invocation] = await tx.select().from(agentToolInvocations).where(and(eq(agentToolInvocations.owner, owner),
        eq(agentToolInvocations.runId, runId), eq(agentToolInvocations.id, invocationId)));
      if (!run || !invocation) throw new NotFoundException('TOOL_BUDGET_NOT_FOUND');
      if (run.cancelRequested || ['cancelled','settled_unknown','accepted'].includes(run.state)) throw new ConflictException('TOOL_BUDGET_RUN_CLOSED');
      const existing = await tx.execute(sql`select * from agent_tool_budget_reservations where owner=${owner} and invocation_id=${invocationId} for update`);
      const prior = existing[0] as unknown as Reservation | undefined;
      if (prior) {
        if (Number(prior.amount) !== input.quantity || prior.unit !== input.unit || prior.price_version !== input.priceVersion) throw new ConflictException('TOOL_RESERVATION_CONFLICT');
        return prior;
      }
      const limits = run.policy.toolBudgets;
      const configured = limits && typeof limits === 'object' && !Array.isArray(limits)
        ? (limits as Record<string, unknown>)[input.unit] : undefined;
      const limit = configured ?? (input.unit === 'calls' ? run.policy.maxTools ?? 24 : null);
      if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) throw new Error('TOOL_BUDGET_UNIT_NOT_AUTHORIZED');
      const totals = await tx.execute(sql`select coalesce(sum(case when state='settled' then actual_amount else amount end),0)::text as used
        from agent_tool_budget_reservations where owner=${owner} and run_id=${runId} and unit=${input.unit}`);
      if (Number(totals[0]?.used ?? 0) + input.quantity > limit) throw new Error('TOOL_BUDGET_EXHAUSTED');
      const id = randomUUID();
      const rows = await tx.execute(sql`insert into agent_tool_budget_reservations(id,owner,run_id,invocation_id,amount,unit,price_version)
        values(${id},${owner},${runId},${invocationId},${input.quantity},${input.unit},${input.priceVersion}) returning *`);
      await tx.execute(sql`insert into agent_tool_budget_events(owner,reservation_id,revision,state,quantity) values(${owner},${id},0,'reserved',${input.quantity})`);
      return rows[0] as unknown as Reservation;
    };
    return transaction ? execute(transaction) : this.db.transaction(execute);
  }
  async markUnknown(owner: string, invocationId: string): Promise<void> { await this.update(owner, invocationId, null); }
  async settle(owner: string, invocationId: string, actualQuantity: number): Promise<void> {
    if (!Number.isFinite(actualQuantity) || actualQuantity < 0) throw new Error('TOOL_USAGE_FACT_REQUIRED');
    await this.update(owner, invocationId, actualQuantity);
  }
  private async update(owner: string, invocationId: string, actual: number | null): Promise<void> {
    await this.db.transaction(async tx => {
      await lockMemoryOwner(tx, owner);
      const rows = await tx.execute(sql`select * from agent_tool_budget_reservations where owner=${owner} and invocation_id=${invocationId} for update`);
      const row = rows[0] as unknown as Reservation | undefined;
      if (!row) throw new NotFoundException('TOOL_BUDGET_NOT_FOUND');
      if (row.state === 'settled') {
        if (actual !== null && Number(row.actual_amount) !== actual) throw new ConflictException('TOOL_USAGE_FACT_CONFLICT');
        return;
      }
      const state = actual === null ? 'unknown' : 'settled';
      if (row.state === state) return;
      await tx.execute(sql`update agent_tool_budget_reservations set state=${state},actual_amount=${actual},revision=revision+1,updated_at=now()
        where owner=${owner} and invocation_id=${invocationId}`);
      await tx.execute(sql`insert into agent_tool_budget_events(owner,reservation_id,revision,state,quantity)
        values(${owner},${row.id},${row.revision + 1},${state},${actual})`);
    });
  }
}
