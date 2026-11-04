import { and, eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from '../../common/platform';
import { councilReports, councilSessions } from '../../database/council.schema';
import { acceptedWorkflowProvenance } from './research-memory.provenance';

/** Unknown old outcomes need positive persisted evidence. A later completed cycle proves nothing. */
export async function archivalEligibility(db: Pick<PostgresJsDatabase, 'select' | 'update'>, owner: string,
  report: typeof councilReports.$inferSelect, session: typeof councilSessions.$inferSelect): Promise<boolean> {
  if (report.owner !== owner || session.owner !== owner || report.sessionId !== session.id
    || report.engine === 'basic' || report.publicationOutcome === 'failed') return false;
  if (report.publicationOutcome === 'succeeded') return true;
  const eligible = session.status === 'completed' && session.revision === report.revision && !session.error
    || Boolean(await acceptedWorkflowProvenance(db, owner, session.id, report));
  if (eligible) await db.update(councilReports).set({ publicationOutcome: 'succeeded' })
    .where(and(eq(councilReports.owner, owner), eq(councilReports.id, report.id)));
  return eligible;
}
