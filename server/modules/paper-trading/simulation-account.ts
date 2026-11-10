import { ConflictException, NotFoundException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from '../../common/platform';
import { paperAccounts } from '../../database/schema';

export async function requireActivePaperAccount(db: PostgresJsDatabase, owner: string, accountId?: string) {
  const accounts = await db.select().from(paperAccounts).where(and(eq(paperAccounts.owner, owner),
    eq(paperAccounts.isActive, true), accountId ? eq(paperAccounts.id, accountId) : undefined));
  if (accounts.length > 1) throw new ConflictException('ACCOUNT_SELECTION_REQUIRED');
  const [account] = accounts;
  if (!account) throw new NotFoundException('Active paper account not found');
  return account;
}
