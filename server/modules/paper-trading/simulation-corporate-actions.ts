import { and, eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from '../../common/platform';
import { paperAccounts, paperEvents } from '../../database/schema';

type Database = PostgresJsDatabase | Parameters<Parameters<PostgresJsDatabase['transaction']>[0]>[0];
export interface CorporateActionGap { ticker: string; kind: 'split' | 'dividend'; occurredAt: string; detectedAt: string }
export async function readCorporateActionGaps(db: Database, owner: string, accountId: string): Promise<CorporateActionGap[]> {
  const rows = await db.select({ detail: paperEvents.detail }).from(paperEvents).where(and(eq(paperEvents.owner, owner),
    eq(paperEvents.accountId, accountId), eq(paperEvents.eventType, 'corporate_action_gap')));
  return rows.map(row => row.detail as CorporateActionGap);
}
/** Caller holds the owner lock. Persisting the observation prevents a later incomplete feed from clearing it. */
export async function persistCorporateActionGaps(db: Database, owner: string, accountId: string, ticker: string,
  events: Array<{ kind: 'split' | 'dividend'; occurredAt: string }>, now = new Date()): Promise<void> {
  const existing = await readCorporateActionGaps(db, owner, accountId);
  for (const event of events) {
    if (existing.some(gap => gap.ticker === ticker && gap.kind === event.kind && gap.occurredAt === event.occurredAt)) continue;
    const detail: CorporateActionGap = { ticker, ...event, detectedAt: now.toISOString() };
    await db.insert(paperEvents).values({ owner, accountId, eventType: 'corporate_action_gap', detail });
    existing.push(detail);
  }
  await db.update(paperAccounts).set({ botEnabled: false }).where(and(eq(paperAccounts.owner, owner), eq(paperAccounts.id, accountId)));
}
