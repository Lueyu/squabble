import { NotFoundException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from '../../common/platform';
import { paperAccounts } from '../../database/schema';

export async function requireActivePaperAccount(db: PostgresJsDatabase, owner: string) {
  const [account] = await db.select().from(paperAccounts).where(and(eq(paperAccounts.owner, owner), eq(paperAccounts.isActive, true)));
  if (!account) throw new NotFoundException('Active paper account not found');
  return account;
}
