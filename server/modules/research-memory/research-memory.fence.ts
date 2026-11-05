import { eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from '../../common/platform';
import { researchMemoryPreferences } from '../../database/research-memory.schema';

export type MemoryFenceTransaction = Pick<PostgresJsDatabase, 'select' | 'insert' | 'update'>;
/** First operation of mutating transactions. Never acquire this after a source, account or job row lock. */
export async function lockMemoryOwner(tx: MemoryFenceTransaction, owner: string): Promise<void> {
  await tx.insert(researchMemoryPreferences).values({ owner }).onConflictDoNothing();
  await tx.select({ owner: researchMemoryPreferences.owner }).from(researchMemoryPreferences)
    .where(eq(researchMemoryPreferences.owner, owner)).for('update');
}
