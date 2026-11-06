import { and, desc, eq, isNotNull, sql } from 'drizzle-orm';
import { investmentPolicies } from '../../database/investment-policy.schema';
import { strategyMandates } from '../../database/strategy-mandates.schema';
import type { MemoryFenceTransaction } from '../research-memory/research-memory.fence';

export function paperRiskDay(date: Date, timezone = 'UTC'): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}
export async function paperRiskTimezone(tx: MemoryFenceTransaction, owner: string, accountId: string): Promise<string> {
  const [mandate] = await tx.select({ config: strategyMandates.config }).from(strategyMandates).where(and(
    eq(strategyMandates.owner, owner), eq(strategyMandates.accountId, accountId), isNotNull(strategyMandates.publishedAt)))
    .orderBy(sql`case when ${strategyMandates.status} = 'published' then 0 else 1 end`, desc(strategyMandates.publishedAt), desc(strategyMandates.createdAt)).limit(1);
  if (mandate?.config.timezone) return mandate.config.timezone;
  const [policy] = await tx.select().from(investmentPolicies).where(and(eq(investmentPolicies.owner, owner), eq(investmentPolicies.accountId, accountId)));
  return policy?.effectiveConfig.timezone ?? 'UTC';
}
