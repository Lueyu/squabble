import { Inject, Injectable, BadRequestException, ConflictException } from '@nestjs/common';
import { eq, and } from 'drizzle-orm';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '../../common/platform';
import { cashAccounts, transactions } from '@server/database/schema';
import { TransactionsService } from '../transactions/transactions.service';
import type { CashAccount, Currency } from '@shared/api.interface';
import { cashBalanceConfirmations } from '../../database/asset-ledger.schema';
import { lockMemoryOwner } from '../research-memory/research-memory.fence';
import { createHash } from 'node:crypto';
export interface ConfirmCashInput { requestKey: string; balances: Array<{ currency: Currency; balance: number; expectedUpdatedAt: string }> }
const ALL_CURRENCIES: Currency[] = ['USD', 'HKD', 'CNY'];
@Injectable()
export class CashAccountsService {
  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase, private readonly ledger: TransactionsService) {}
  async list(owner: string): Promise<CashAccount[]> {
    await this.ensureAccounts(owner);
    return (await this.db.select().from(cashAccounts).where(eq(cashAccounts.owner, owner)).orderBy(cashAccounts.currency)).map(row => this.mapRow(row));
  }
  async getBalance(owner: string, currency: string): Promise<string> {
    await this.ensureAccounts(owner);
    const [row] = await this.db.select().from(cashAccounts).where(and(eq(cashAccounts.owner, owner), eq(cashAccounts.currency, currency)));
    if (row?.reconciliationStatus === 'review') throw new ConflictException('CASH_REQUIRES_RECONCILIATION');
    return row?.balance ?? '0';
  }
  async adjust(owner: string, currency: string, delta: number, reason?: string): Promise<CashAccount> {
    if (!ALL_CURRENCIES.includes(currency as Currency) || !Number.isFinite(delta) || delta === 0) throw new BadRequestException('INVALID_CASH_ADJUSTMENT');
    await this.ledger.create(owner, { txType: delta > 0 ? 'Deposit' : 'Withdrawal', txDate: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date()), ticker: '', shares: Math.abs(delta), price: 1, currency, notes: reason });
    return (await this.list(owner)).find(row => row.currency === currency)!;
  }
  async ensureAccounts(owner: string): Promise<void> {
    await this.db.transaction(async tx => {
      await lockMemoryOwner(tx, owner);
      await tx.insert(cashAccounts).values(ALL_CURRENCIES.map(currency => ({ owner, currency, balance: '0', createdBy: owner, updatedBy: owner })))
        .onConflictDoNothing({ target: [cashAccounts.owner, cashAccounts.currency] });
    });
  }
  async confirm(owner: string, input: ConfirmCashInput): Promise<{ items: CashAccount[] }> {
    if (!input || typeof input.requestKey !== 'string' || !input.requestKey || input.requestKey.length > 150 || !Array.isArray(input.balances) || !input.balances.length || input.balances.length > 3 ||
      input.balances.some(row => !row || typeof row !== 'object') || new Set(input.balances.map(row => row.currency)).size !== input.balances.length || input.balances.some(row => !ALL_CURRENCIES.includes(row.currency) || !Number.isFinite(row.balance) || row.balance < 0 || row.balance > Number.MAX_SAFE_INTEGER || typeof row.expectedUpdatedAt !== 'string')) throw new BadRequestException('INVALID_CASH_CONFIRMATION');
    const inputHash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    await this.db.transaction(async tx => {
      await lockMemoryOwner(tx, owner);
      const [prior] = await tx.select().from(cashBalanceConfirmations).where(and(eq(cashBalanceConfirmations.owner, owner), eq(cashBalanceConfirmations.requestKey, input.requestKey)));
      if (prior) { if (prior.inputHash !== inputHash) throw new ConflictException('IDEMPOTENCY_CONFLICT'); return; }
      const changes = [];
      for (const row of input.balances) {
        const [account] = await tx.select().from(cashAccounts).where(and(eq(cashAccounts.owner, owner), eq(cashAccounts.currency, row.currency))).for('update');
        if (!account || account.updatedAt.toISOString() !== row.expectedUpdatedAt) throw new ConflictException('CASH_CHANGED');
        const covered = await tx.select({ id: transactions.id }).from(transactions).where(and(eq(transactions.owner, owner), eq(transactions.currency, row.currency)));
        changes.push({ currency: row.currency, before: account.balance, after: String(row.balance), previousStatus: account.reconciliationStatus, source: 'user-confirmed', coveredTransactionIds: covered.map(transaction => transaction.id) });
        await tx.update(cashAccounts).set({ balance: String(row.balance), reconciliationStatus: 'confirmed', confirmedAt: new Date(), updatedAt: new Date(), updatedBy: owner }).where(eq(cashAccounts.id, account.id));
      }
      await tx.insert(cashBalanceConfirmations).values({ owner, requestKey: input.requestKey, inputHash, changes });
    });
    return { items: await this.list(owner) };
  }
  private mapRow(row: typeof cashAccounts.$inferSelect): CashAccount {
    return { id: row.id, currency: row.currency as Currency, balance: row.balance, reconciliationStatus: row.reconciliationStatus as CashAccount['reconciliationStatus'], updatedAt: row.updatedAt.toISOString() };
  }
}
