import { and, eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from '../common/platform';
import { financialDataConnections } from './data-library.schema';
/** Research provider opt-out is owner-scoped; public execution quotes remain independent. */
export async function financialProviderEnabled(db: Pick<PostgresJsDatabase, 'select'>, owner: string, provider: string): Promise<boolean> {
  const [row] = await db.select({ enabled: financialDataConnections.enabled }).from(financialDataConnections)
    .where(and(eq(financialDataConnections.owner, owner), eq(financialDataConnections.provider, provider)));
  return row?.enabled !== false;
}
