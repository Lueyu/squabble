/**
 * Cash accounts service.
 *
 * Business logic and PostgreSQL (Drizzle) data access for the user's multi-currency
 * cash balances. On first use it lazily provisions a zero-balance account for each
 * supported currency (`USD/HKD/CNY`) via upsert. Withdrawals (negative deltas) are
 * rejected if they would make the balance negative.
 */
import { Inject, Injectable, BadRequestException } from '@nestjs/common';
import { eq, and, sql } from 'drizzle-orm';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '../../common/platform';

import { cashAccounts } from '@server/database/schema';
import type { CashAccount, Currency } from '@shared/api.interface';

/** Currencies the app tracks cash in. */
const ALL_CURRENCIES: Currency[] = ['USD', 'HKD', 'CNY'];

/**
 * Provides cash-balance read/adjust operations. Depends on the Drizzle database.
 */
@Injectable()
export class CashAccountsService {
  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase) {}

  /**
   * Lists all cash accounts for a user (provisioning any missing ones first).
   *
   * @param userId Owner id.
   */
  async list(userId: string): Promise<CashAccount[]> {
    await this.ensureAccounts(userId);
    const rows = await this.db
      .select()
      .from(cashAccounts)
      .where(eq(cashAccounts.owner, userId))
      .orderBy(cashAccounts.currency);
    return rows.map((r) => this.mapRow(r));
  }

  /**
   * Returns the balance for a single currency as a string, or '0' if unset.
   *
   * @param userId   Owner id.
   * @param currency Account currency.
   */
  async getBalance(userId: string, currency: string): Promise<string> {
    await this.ensureAccounts(userId);
    const rows = await this.db
      .select()
      .from(cashAccounts)
      .where(and(eq(cashAccounts.owner, userId), eq(cashAccounts.currency, currency)));
    if (rows.length === 0) return '0';
    return rows[0].balance;
  }

  /**
   * Applies a signed balance change to a currency account. Negative deltas are
   * checked against the current balance first (non-negative risk gate).
   *
   * @param userId   Owner id.
   * @param currency  Account currency.
   * @param delta    Signed amount to add (negative to withdraw).
   * @param _reason  Optional note (unused in persistence).
   * @throws BadRequestException if the balance would go negative or account missing.
   */
  async adjust(
    userId: string,
    currency: string,
    delta: number,
    _reason?: string,
  ): Promise<CashAccount> {
    await this.ensureAccounts(userId);

    // For withdrawals, first verify the balance is sufficient.
    if (delta < 0) {
      const current = await this.getBalance(userId, currency);
      if (Number(current) + delta < 0) {
        // NOTE: Chinese user-facing message (existing behavior; not mojibake).
        throw new BadRequestException('现金不足');
      }
    }

    const rows = await this.db
      .update(cashAccounts)
      .set({
        balance: sql`${cashAccounts.balance} + ${delta}::numeric`,
      })
      .where(and(eq(cashAccounts.owner, userId), eq(cashAccounts.currency, currency)))
      .returning();

    if (rows.length === 0) {
      // NOTE: Chinese user-facing message (existing behavior; not mojibake).
      throw new BadRequestException('账户不存在');
    }

    return this.mapRow(rows[0]);
  }

  /**
   * Creates zero-balance cash accounts for any supported currency the user does
   * not yet have, using `onConflictDoNothing` to stay idempotent.
   *
   * @param userId Owner id.
   */
  async ensureAccounts(userId: string): Promise<void> {
    const values = ALL_CURRENCIES.map((currency: Currency) => ({
      currency,
      balance: '0',
      owner: userId,
      createdBy: userId,
      updatedBy: userId,
    }));

    await this.db.insert(cashAccounts).values(values).onConflictDoNothing();
  }

  /**
   * Maps a raw Drizzle row to the API `CashAccount` shape.
   *
   * @param row Raw cashAccounts row.
   */
  private mapRow(row: typeof cashAccounts.$inferSelect): CashAccount {
    return {
      id: row.id,
      currency: row.currency as Currency,
      balance: row.balance,
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
