import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '../../common/platform';
import { cashAccounts, closed, holdings, transactions } from '@server/database/schema';
import { cashBalanceConfirmations, positionBaselines } from '../../database/asset-ledger.schema';
import { lockMemoryOwner } from '../research-memory/research-memory.fence';
import { QuoteService } from '../quote/quote.service';
import { resolvePositionTicker } from '../import/position-checkpoint';
import { securityIdentity } from '../import/screenshot-merge';
import type { CreateTransactionDto, ReconcileResult, Transaction } from '@shared/api.interface';

type Row = typeof transactions.$inferSelect;
type Source = Partial<Pick<typeof transactions.$inferInsert, 'sourceIdentity' | 'sourceFingerprint' | 'sourceBatchId' | 'sourceData' | 'linkedTransactionId'>>;
const isPosition = (type: string) => ['Buy', 'Sell', 'Opening'].includes(type);

/** All mutations share the owner fence with imports and replay from an explicit checkpoint. */
@Injectable()
export class TransactionsService {
  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase, private readonly quoteService: QuoteService) {}

  async list(owner: string, ticker?: string, limit = 100, offset = 0): Promise<Transaction[]> {
    return (await this.db.select().from(transactions).where(and(eq(transactions.owner, owner), ...(ticker ? [eq(transactions.ticker, ticker)] : [])))
      .orderBy(desc(transactions.txDate), desc(transactions.ledgerOrder), desc(transactions.id)).limit(limit).offset(offset)).map(row => this.mapRow(row));
  }
  async getById(owner: string, id: string): Promise<Transaction> {
    const [row] = await this.db.select().from(transactions).where(and(eq(transactions.owner, owner), eq(transactions.id, id)));
    if (!row) throw new NotFoundException('交易记录不存在 / Transaction not found');
    return this.mapRow(row);
  }
  private normalize(dto: CreateTransactionDto) {
    if (!dto || !['Buy', 'Sell', 'Deposit', 'Withdrawal', 'Opening', 'Fee'].includes(dto.txType)) throw new BadRequestException('INVALID_TRANSACTION_TYPE');
    const shares = Number(dto.shares), price = Number(dto.price), fees = Number(dto.fees ?? 0);
    const currency = dto.currency ?? 'USD';
    const position = isPosition(dto.txType);
    const ticker = position && typeof dto.ticker === 'string' ? dto.ticker.trim().toUpperCase() : '';
    if (typeof dto.txDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dto.txDate) || !Number.isFinite(Date.parse(dto.txDate)) || new Date(dto.txDate).toISOString().slice(0, 10) !== dto.txDate) throw new BadRequestException('INVALID_TRANSACTION_DATE');
    if (!['USD', 'HKD', 'CNY'].includes(currency)) throw new BadRequestException('INVALID_CURRENCY');
    if (!Number.isFinite(shares) || shares <= 0 || shares > Number.MAX_SAFE_INTEGER || !Number.isFinite(fees) || fees < 0 || fees > Number.MAX_SAFE_INTEGER ||
      (position && (!ticker || ticker.length > 20 || !Number.isFinite(price) || price < 0 || (dto.txType !== 'Opening' && price === 0)))) throw new BadRequestException('INVALID_TRANSACTION_AMOUNT');
    if (dto.notes !== undefined && (typeof dto.notes !== 'string' || dto.notes.length > 10000)) throw new BadRequestException('INVALID_NOTES');
    return { txDate: dto.txDate, ticker: ticker || '', txType: dto.txType, shares: String(shares), price: String(position ? price : 1), fees: String(fees), currency, notes: dto.notes ?? null };
  }
  private cashDelta(row: Pick<Row, 'txType' | 'shares' | 'price' | 'fees'>): number {
    const amount = Number(row.shares), fees = Number(row.fees ?? 0);
    if (row.txType === 'Buy') return -(amount * Number(row.price) + fees);
    if (row.txType === 'Sell') return amount * Number(row.price) - fees;
    if (row.txType === 'Deposit') return amount - fees;
    if (row.txType === 'Withdrawal') return -(amount + fees);
    if (row.txType === 'Fee') return -(amount + fees);
    return 0;
  }
  private async adjustCash(tx: PostgresJsDatabase, owner: string, currency: string, delta: number) {
    if (Math.abs(delta) < 1e-9) return;
    const [account] = await tx.select().from(cashAccounts).where(and(eq(cashAccounts.owner, owner), eq(cashAccounts.currency, currency))).for('update');
    if (account?.reconciliationStatus === 'review') throw new ConflictException('CASH_REQUIRES_RECONCILIATION');
    const balance = Number(account?.balance ?? 0) + delta;
    if (!Number.isFinite(balance) || balance < -1e-9) throw new BadRequestException(`现金不足：${currency} 余额 ${Number(account?.balance ?? 0).toFixed(2)}，需要 ${Math.abs(delta).toFixed(2)} / Insufficient cash`);
    if (account) await tx.update(cashAccounts).set({ balance: String(Math.max(0, balance)), updatedAt: new Date(), updatedBy: owner }).where(eq(cashAccounts.id, account.id));
    // A recorded delta is known; the opening balance still needs explicit reconciliation.
    else await tx.insert(cashAccounts).values({ owner, currency, balance: String(balance), reconciliationStatus: 'unconfirmed', createdBy: owner, updatedBy: owner });
  }
  async create(owner: string, dto: CreateTransactionDto): Promise<Transaction> {
    this.normalize(dto);
    return this.db.transaction(async tx => { await lockMemoryOwner(tx, owner); return this.createInTransaction(tx, owner, dto); });
  }
  /** Import commit calls this inside its fenced transaction; no nested commits or synthetic deposits. */
  async createInTransaction(tx: PostgresJsDatabase, owner: string, dto: CreateTransactionDto, source: Source = {}): Promise<Transaction> {
    const values = this.normalize(dto);
    if (isPosition(values.txType)) values.ticker = await resolvePositionTicker(tx, owner, values.ticker);
    await this.assertCashDate(tx, owner, values);
    await this.ensureLegacyBaseline(tx, owner, values.ticker);
    const [row] = await tx.insert(transactions).values({ ...values, ...source, owner, createdBy: owner, updatedBy: owner }).returning();
    if (isPosition(values.txType)) await this.rebuild(tx, owner, [values.ticker]);
    await this.adjustCash(tx, owner, values.currency, this.cashDelta(row));
    return this.mapRow(row);
  }
  /** This legacy endpoint represents the user's explicit request for a paired cash top-up. */
  async createWithAutoDeposit(owner: string, dto: CreateTransactionDto): Promise<Transaction> {
    const values = this.normalize(dto);
    if (dto.txType !== 'Buy') throw new BadRequestException('AUTO_DEPOSIT_REQUIRES_BUY');
    return this.db.transaction(async tx => {
      await lockMemoryOwner(tx, owner);
      const [account] = await tx.select().from(cashAccounts).where(and(eq(cashAccounts.owner, owner), eq(cashAccounts.currency, values.currency))).for('update');
      const shortfall = -this.cashDelta(values) - Number(account?.balance ?? 0);
      let depositId: string | undefined;
      if (shortfall > 1e-9) depositId = (await this.createInTransaction(tx, owner, { txType: 'Deposit', txDate: dto.txDate, ticker: '', shares: shortfall, price: 1, currency: values.currency, notes: 'User-confirmed cash top-up / 已确认补充现金' })).id;
      const result = await this.createInTransaction(tx, owner, dto);
      if (depositId) await tx.update(transactions).set({ linkedTransactionId: result.id }).where(eq(transactions.id, depositId));
      return result;
    });
  }
  private async ensureLegacyBaseline(tx: PostgresJsDatabase, owner: string, ticker: string) {
    if (!ticker) return;
    const [baseline] = await tx.select().from(positionBaselines).where(and(eq(positionBaselines.owner, owner), eq(positionBaselines.ticker, ticker)));
    if (baseline) return;
    const [holding] = await tx.select().from(holdings).where(and(eq(holdings.owner, owner), eq(holdings.ticker, ticker))).for('update');
    const prior = await tx.select().from(transactions).where(and(eq(transactions.owner, owner), eq(transactions.ticker, ticker)));
    // Upgrade migrations seed existing positions; this also protects direct/manual holding entry.
    if (holding && prior.length === 0) await tx.insert(positionBaselines).values({ owner, ticker, market: holding.market ?? 'US', currency: holding.currency ?? 'USD', shares: holding.shares, avgCost: holding.buyPrice, company: holding.company, source: 'existing-position', sourceId: holding.id, coveredTransactionIds: [] });
  }
  private async editable(tx: PostgresJsDatabase, owner: string, row: Row) {
    const baselines = await tx.select().from(positionBaselines).where(eq(positionBaselines.owner, owner));
    if (baselines.some(baseline => baseline.coveredTransactionIds.includes(row.id))) throw new ConflictException('CHECKPOINT_HISTORY_REQUIRES_RECONCILIATION');
    if (this.cashDelta(row) === 0) return;
    const confirmations = await tx.select().from(cashBalanceConfirmations).where(eq(cashBalanceConfirmations.owner, owner)).orderBy(desc(cashBalanceConfirmations.createdAt));
    const checkpoints = confirmations.flatMap(confirmation => Array.isArray(confirmation.changes) ? confirmation.changes as Array<{ currency: string; coveredTransactionIds?: string[] }> : []);
    const latest = checkpoints.find(checkpoint => checkpoint.currency === row.currency);
    if (latest?.coveredTransactionIds) {
      if (latest.coveredTransactionIds.includes(row.id)) throw new ConflictException('CASH_CHECKPOINT_HISTORY_REQUIRES_RECONCILIATION');
      return;
    }
    // Upgraded balances can predate confirmation receipts. Preserve their older cash history too.
    const [account] = await tx.select().from(cashAccounts).where(and(eq(cashAccounts.owner, owner), eq(cashAccounts.currency, row.currency!)));
    if (account?.confirmedAt && row.createdAt <= account.confirmedAt) throw new ConflictException('CASH_CHECKPOINT_HISTORY_REQUIRES_RECONCILIATION');
  }
  private async assertCashDate(tx: PostgresJsDatabase, owner: string, row: Pick<Row, 'txDate' | 'txType' | 'currency'>) {
    if (row.txType === 'Opening') return;
    const [account] = await tx.select().from(cashAccounts).where(and(eq(cashAccounts.owner, owner), eq(cashAccounts.currency, row.currency!)));
    if (account?.confirmedAt && row.txDate < new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(account.confirmedAt)) throw new ConflictException('BEFORE_CASH_BASELINE');
  }
  async update(owner: string, id: string, dto: Partial<CreateTransactionDto>): Promise<Transaction> {
    if (!dto || !Object.keys(dto).length) throw new BadRequestException('EMPTY_UPDATE');
    return this.db.transaction(async tx => {
      await lockMemoryOwner(tx, owner);
      const [old] = await tx.select().from(transactions).where(and(eq(transactions.owner, owner), eq(transactions.id, id))).for('update');
      if (!old) throw new NotFoundException('TRANSACTION_NOT_FOUND');
      await this.editable(tx, owner, old);
      const values = this.normalize({ txDate: old.txDate, ticker: old.ticker, txType: old.txType as Transaction['txType'], shares: Number(old.shares), price: Number(old.price), fees: Number(old.fees ?? 0), currency: old.currency ?? 'USD', notes: old.notes ?? undefined, ...dto });
      if (isPosition(values.txType)) values.ticker = await resolvePositionTicker(tx, owner, values.ticker);
      await this.assertCashDate(tx, owner, values);
      const [row] = await tx.update(transactions).set({ ...values, updatedAt: new Date(), updatedBy: owner }).where(eq(transactions.id, id)).returning();
      await this.rebuild(tx, owner, [...new Set([old.ticker, row.ticker].filter(Boolean))]);
      if (row.currency === old.currency) await this.adjustCash(tx, owner, row.currency!, this.cashDelta(row) - this.cashDelta(old));
      else { await this.adjustCash(tx, owner, old.currency!, -this.cashDelta(old)); await this.adjustCash(tx, owner, row.currency!, this.cashDelta(row)); }
      return this.mapRow(row);
    });
  }
  async remove(owner: string, id: string): Promise<void> {
    await this.db.transaction(async tx => {
      await lockMemoryOwner(tx, owner);
      const [old] = await tx.select().from(transactions).where(and(eq(transactions.owner, owner), eq(transactions.id, id))).for('update');
      if (!old) throw new NotFoundException('TRANSACTION_NOT_FOUND');
      await this.editable(tx, owner, old);
      const paired = await tx.select().from(transactions).where(and(eq(transactions.owner, owner), eq(transactions.linkedTransactionId, id)));
      for (const row of paired) await this.editable(tx, owner, row);
      await tx.delete(transactions).where(and(eq(transactions.owner, owner), inArray(transactions.id, [id, ...paired.map(row => row.id)])));
      await this.rebuild(tx, owner, old.ticker ? [old.ticker] : []);
      const deltas = new Map<string, number>();
      for (const row of [old, ...paired]) deltas.set(row.currency!, (deltas.get(row.currency!) ?? 0) - this.cashDelta(row));
      for (const [currency, delta] of deltas) await this.adjustCash(tx, owner, currency, delta);
    });
  }
  async reconcileAll(owner: string): Promise<ReconcileResult> {
    return this.db.transaction(async tx => {
      await lockMemoryOwner(tx, owner);
      const rows = await tx.select().from(transactions).where(eq(transactions.owner, owner));
      const baselines = await tx.select().from(positionBaselines).where(eq(positionBaselines.owner, owner));
      await this.rebuild(tx, owner, [...new Set([...rows.filter(row => isPosition(row.txType)).map(row => row.ticker), ...baselines.map(row => row.ticker)])]);
      // Cash is already applied atomically. Replaying cash from zero would destroy an imported/confirmed balance.
      return { holdingsCount: (await tx.select().from(holdings).where(eq(holdings.owner, owner))).length, closedCount: (await tx.select().from(closed).where(eq(closed.owner, owner))).length, processedTxCount: rows.length };
    });
  }
  private async rebuild(tx: PostgresJsDatabase, owner: string, tickers: string[]) {
    for (const ticker of tickers) {
      const [baseline] = await tx.select().from(positionBaselines).where(and(eq(positionBaselines.owner, owner), eq(positionBaselines.ticker, ticker)));
      const rows = await tx.select().from(transactions).where(and(eq(transactions.owner, owner), eq(transactions.ticker, ticker))).orderBy(asc(transactions.txDate), asc(transactions.ledgerOrder), asc(transactions.id));
      const [holding] = await tx.select().from(holdings).where(and(eq(holdings.owner, owner), eq(holdings.ticker, ticker))).for('update');
      let shares = Number(baseline?.shares ?? 0), cost: number | null = baseline && baseline.avgCost === null ? null : shares * Number(baseline?.avgCost ?? 0), buyDate: string | null = null;
      const closedRows: Array<typeof closed.$inferInsert> = [];
      for (const row of rows) {
        if (baseline?.coveredTransactionIds.includes(row.id)) continue;
        if (!isPosition(row.txType)) continue;
        if (baseline?.observedAt && row.txDate < new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(baseline.observedAt)) throw new ConflictException('BEFORE_POSITION_BASELINE');
        if (row.currency !== (baseline?.currency ?? securityIdentity(ticker)?.currency)) throw new ConflictException('POSITION_CURRENCY_MISMATCH');
        const quantity = Number(row.shares), price = Number(row.price), fees = Number(row.fees ?? 0);
        if (row.txType === 'Buy' || row.txType === 'Opening') {
          shares += quantity; if (cost !== null) cost += quantity * price + fees; buyDate ??= row.txDate;
        } else {
          if (quantity > shares + 1e-9) throw new BadRequestException(`持仓不足 / Insufficient shares: ${ticker} ${shares}`);
          const average = shares > 0 && cost !== null ? cost / shares : null;
          const soldCost = average === null ? null : quantity * average;
          const profit = soldCost === null ? null : quantity * price - fees - soldCost;
          closedRows.push({ owner, ticker, company: holding?.company ?? baseline?.company, openDate: buyDate, closeDate: row.txDate, shares: String(quantity), buyPrice: average === null ? null : String(average), sellPrice: String(price), realizedPl: profit === null ? null : String(profit), returnPct: profit === null || !soldCost ? null : String(profit / soldCost * 100), notes: row.notes, createdBy: owner, updatedBy: owner });
          shares -= quantity; if (cost !== null) cost -= soldCost!;
          if (shares < 1e-9) { shares = 0; cost = 0; buyDate = null; }
        }
      }
      if (shares > 1e-9) {
        const values = { shares: String(shares), buyPrice: cost === null ? null : String(cost / shares), buyDate, updatedAt: new Date(), updatedBy: owner };
        if (holding) await tx.update(holdings).set(values).where(eq(holdings.id, holding.id));
        else await tx.insert(holdings).values({ owner, ticker, ...(baseline ? { market: baseline.market, currency: baseline.currency, company: baseline.company } : this.quoteService.detectMarket(ticker)), ...values, createdBy: owner });
      } else if (holding) await tx.delete(holdings).where(eq(holdings.id, holding.id));
      const priorClosed = await tx.select({ id: closed.id }).from(closed).where(and(eq(closed.owner, owner), eq(closed.ticker, ticker)));
      for (const item of priorClosed) if (!baseline?.coveredClosedIds?.includes(item.id)) await tx.delete(closed).where(eq(closed.id, item.id));
      if (closedRows.length) await tx.insert(closed).values(closedRows);
    }
  }
  private mapRow(row: Row): Transaction {
    return { id: row.id, txDate: row.txDate, ticker: row.ticker, txType: row.txType as Transaction['txType'], shares: row.shares, price: row.price, fees: row.fees ?? '0', currency: (row.currency ?? 'USD') as Transaction['currency'], notes: row.notes };
  }
}
