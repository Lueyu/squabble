/**
 * Transactions service.
 *
 * The source-of-truth bookkeeping for the portfolio. Transactions (Buy / Sell /
 * Deposit / Withdrawal / Opening) are entered directly by the user; holdings,
 * closed positions (realized P&L), and per-currency cash balances are all DERIVED
 * from them and rebuilt after every mutation. All writes run in a single DB
 * transaction. Cash is tracked per currency and a balance may never go negative
 * (`adjustCash` throws otherwise). For Buy orders without enough cash,
 * `createWithAutoDeposit` auto-deposits the shortfall and records a paired Deposit
 * row tagged `__AUTO_DEPOSIT_FOR_BUY__:<ticker>`.
 */
import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '../../common/platform';
import { eq, and, desc, asc, inArray, sql } from 'drizzle-orm';
import { transactions, holdings, closed, cashAccounts } from '@server/database/schema';
import { QuoteService } from './../quote/quote.service';
import type {
  Transaction,
  CreateTransactionDto,
  ReconcileResult,
  Currency,
} from '@shared/api.interface';

/** Partial-update variant of the create DTO. */
type UpdateTransactionDto = Partial<CreateTransactionDto>;

/**
 * Running state used while replaying a ticker's transactions in chronological
 * order to recompute shares held and average cost basis.
 */
interface TxCursor {
  /** Ticker being replayed. */
  ticker: string;
  /** Net shares currently held. */
  shares: number;
  /** Total cost basis of the remaining shares. */
  costBasis: number;
  /** Date of the first open (buy) transaction, if any. */
  buyDate: string | null;
  /** Company display name carried into derived holdings/closed rows. */
  company: string | null;
}

/**
 * Provides transaction CRUD plus derived-state rebuild (holdings, closed
 * positions, cash). Depends on the Drizzle database connection.
 */
@Injectable()
export class TransactionsService {
  private readonly logger = new Logger(TransactionsService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly quoteService: QuoteService,
  ) {}

  /**
   * Lists the user's transactions, newest first, optionally filtered by ticker.
   *
   * @param userId Owner id from the authenticated request.
   * @param ticker  Optional ticker filter.
   * @param limit   Max rows (capped client-side by the caller; default 100).
   */
  async list(userId: string, ticker?: string, limit: number = 100, offset = 0): Promise<Transaction[]> {
    const conditions = [eq(transactions.owner, userId)];
    if (ticker) conditions.push(eq(transactions.ticker, ticker));

    const rows = await this.db
      .select()
      .from(transactions)
      .where(and(...conditions))
      .orderBy(desc(transactions.txDate), desc(transactions.id))
      .limit(limit)
      .offset(offset);

    return rows.map((row) => this.mapRow(row));
  }

  /**
   * Fetches a single transaction by id, only when owned by the caller.
   *
   * @param userId Owner id used for the ownership filter.
   * @param id     Transaction primary key.
   * @throws NotFoundException if no matching (id, owner) row exists.
   */
  async getById(userId: string, id: string): Promise<Transaction> {
    const rows = await this.db
      .select()
      .from(transactions)
      .where(and(eq(transactions.id, id), eq(transactions.owner, userId)));

    if (rows.length === 0)
      // NOTE: Chinese user-facing message (existing behavior; not mojibake).
      throw new NotFoundException('交易记录不存在');

    return this.mapRow(rows[0]);
  }

  /**
   * Creates a Buy transaction and, if the user's cash in the transaction's
   * currency is insufficient, automatically deposits the shortfall first. The
   * auto-deposit is recorded as a synthetic Deposit row paired by a notes tag.
   * Everything (deposit, cash deduction, buy insert, holdings rebuild) runs in
   * one transaction.
   *
   * @param userId Owner id.
   * @param dto    Create payload (must be a Buy).
   * @throws BadRequestException on validation failures.
   */
  async createWithAutoDeposit(
    userId: string,
    dto: CreateTransactionDto,
  ): Promise<Transaction> {
    if (dto.txType !== 'Buy') {
      // NOTE: Chinese user-facing message (existing behavior; not mojibake).
      throw new BadRequestException('自动充值仅支持买入交易');
    }

    const sharesNum = Number(dto.shares);
    const priceNum = Number(dto.price);
    const feesNum = dto.fees !== undefined ? Number(dto.fees) : 0;
    const currency = (dto.currency as Currency) || 'USD';
    const ticker = dto.ticker?.trim().toUpperCase();

    if (!dto.txDate)
      // NOTE: Chinese user-facing message (existing behavior; not mojibake).
      throw new BadRequestException('交易日期不能为空');
    if (sharesNum <= 0 || isNaN(sharesNum))
      // NOTE: Chinese user-facing message (existing behavior; not mojibake).
      throw new BadRequestException('数量必须大于 0');
    if (!ticker)
      // NOTE: Chinese user-facing message (existing behavior; not mojibake).
      throw new BadRequestException('代码不能为空');
    if (priceNum <= 0 || isNaN(priceNum))
      // NOTE: Chinese user-facing message (existing behavior; not mojibake).
      throw new BadRequestException('价格必须大于 0');

    // Total cash outflow for the buy including fees.
    const costAmount = sharesNum * priceNum + feesNum;

    const result = await this.db.transaction(async (tx) => {
      const existing = await tx
        .select()
        .from(cashAccounts)
        .where(
          and(eq(cashAccounts.owner, userId), eq(cashAccounts.currency, currency)),
        );
      const curBalance = existing.length > 0 ? Number(existing[0].balance) : 0;
      // How much extra cash is needed to afford this buy.
      const shortfall = costAmount - curBalance;

      if (shortfall > 1e-9) {
        // Top up the cash account by the shortfall (create or increment).
        if (existing.length === 0) {
          await tx.insert(cashAccounts).values({
            currency,
            balance: String(shortfall),
            owner: userId,
            createdBy: userId,
            updatedBy: userId,
          });
        } else {
          await tx
            .update(cashAccounts)
            .set({
              balance: sql`${cashAccounts.balance} + ${shortfall}::numeric`,
              updatedAt: new Date(),
              updatedBy: userId,
            })
            .where(eq(cashAccounts.id, existing[0].id));
        }

        // Record the paired synthetic deposit so it can be removed later if the buy is deleted.
        await tx.insert(transactions).values({
          txDate: dto.txDate,
          ticker: '',
          txType: 'Deposit',
          shares: String(shortfall),
          price: String(1),
          fees: String(0),
          notes: `__AUTO_DEPOSIT_FOR_BUY__:${ticker}`,
          currency,
          owner: userId,
          createdBy: userId,
          updatedBy: userId,
        });
      }

      // Spend the cash on the buy.
      await this.adjustCash(tx, userId, currency, -costAmount);

      const insertRows = await tx
        .insert(transactions)
        .values({
          txDate: dto.txDate,
          ticker,
          txType: 'Buy',
          shares: String(sharesNum),
          price: String(priceNum),
          fees: String(feesNum),
          notes: dto.notes,
          currency,
          owner: userId,
          createdBy: userId,
          updatedBy: userId,
        })
        .returning();

      // Re-derive holdings/closed for this ticker from the updated transactions.
      await this.rebuildTickersFromTransactions(tx, userId, [ticker]);

      return insertRows[0];
    });

    return this.mapRow(result);
  }

  /**
   * Creates a transaction of any valid type. Cash-flow types (Deposit/Withdrawal)
   * adjust cash only; Buy/Sell/Opening adjust cash and then rebuild derived holdings
   * for the affected ticker. All in one DB transaction.
   *
   * @param userId Owner id.
   * @param dto    Create payload.
   * @throws BadRequestException on validation failures.
   */
  async create(userId: string, dto: CreateTransactionDto): Promise<Transaction> {
    const sharesNum = Number(dto.shares);
    const priceNum = Number(dto.price);
    const feesNum = dto.fees !== undefined ? Number(dto.fees) : 0;
    const currency = (dto.currency as Currency) || 'USD';
    const rawTxType = dto.txType;

    const validTypes = ['Buy', 'Sell', 'Deposit', 'Withdrawal', 'Opening'] as const;
    if (!validTypes.includes(rawTxType as typeof validTypes[number]))
      // NOTE: Chinese user-facing message (existing behavior; not mojibake).
      throw new BadRequestException('交易类型无效');
    const txType = rawTxType;

    const isCashFlow = txType === 'Deposit' || txType === 'Withdrawal';
    const isOpening = txType === 'Opening';

    if (!dto.txDate)
      // NOTE: Chinese user-facing message (existing behavior; not mojibake).
      throw new BadRequestException('交易日期不能为空');

    if (sharesNum <= 0 || isNaN(sharesNum)) {
      // Amount validation differs for cash flows vs share trades.
      // NOTE: Chinese user-facing messages (existing behavior; not mojibake).
      throw new BadRequestException(isCashFlow ? '金额必须大于 0' : '数量必须大于 0');
    }

    if (!isCashFlow && !isOpening) {
      if (!dto.ticker || !dto.ticker.trim()) {
        // NOTE: Chinese user-facing message (existing behavior; not mojibake).
        throw new BadRequestException('代码不能为空');
      }
      if (priceNum <= 0 || isNaN(priceNum)) {
        // NOTE: Chinese user-facing message (existing behavior; not mojibake).
        throw new BadRequestException('价格必须大于 0');
      }
    }

    // Cash flows/opening use a blank or optional ticker; share trades require one.
    const ticker = (isCashFlow || isOpening) ? (isOpening ? dto.ticker?.trim().toUpperCase() ?? '' : '') : dto.ticker.trim().toUpperCase();

    if (isCashFlow) {
      // Deposit adds cash, Withdrawal removes it.
      const amount = txType === 'Deposit' ? sharesNum : -sharesNum;
      const result = await this.db.transaction(async (tx) => {
        const insertRows = await tx
          .insert(transactions)
          .values({
            txDate: dto.txDate,
            ticker,
            txType,
            shares: String(sharesNum),
            price: String(priceNum || 1),
            fees: String(feesNum),
            notes: dto.notes,
            currency,
            owner: userId,
            createdBy: userId,
            updatedBy: userId,
          })
          .returning();

        await this.adjustCash(tx, userId, currency, amount);
        return insertRows[0];
      });
      return this.mapRow(result);
    }

    // Share trade (Buy/Sell/Opening): compute cash sign first.
    const result = await this.db.transaction(async (tx) => {
      if (txType === 'Sell') {
        await tx.select({ id: holdings.id }).from(holdings)
          .where(and(eq(holdings.owner, userId), eq(holdings.ticker, ticker)))
          .for('update');
        const prior = await tx.select().from(transactions)
          .where(and(eq(transactions.owner, userId), eq(transactions.ticker, ticker)))
          .orderBy(asc(transactions.txDate), asc(transactions.id));
        let available = 0;
        for (const row of prior) {
          if (row.txType === 'Buy' || row.txType === 'Opening') available += Number(row.shares);
          if (row.txType === 'Sell') available -= Number(row.shares);
        }
        if (sharesNum > available + 1e-9) {
          throw new BadRequestException(`持仓不足：可卖 ${available} 股`);
        }
      }
      const cashDelta =
        txType === 'Buy'
          ? -(sharesNum * priceNum + feesNum)
          : sharesNum * priceNum - feesNum;

    // Buy spends cash; an Opening position does not move cash (it sets the starting lot).
    if (txType === 'Buy' || txType === 'Opening') {
         await this.adjustCash(tx, userId, currency, txType === 'Buy' ? cashDelta : 0);
       }

       const insertRows = await tx
         .insert(transactions)
         .values({
           txDate: dto.txDate,
           ticker,
           txType,
           shares: String(sharesNum),
           price: String(priceNum),
           fees: String(feesNum),
           notes: dto.notes,
           currency,
           owner: userId,
           createdBy: userId,
           updatedBy: userId,
         })
         .returning();

      if (txType === 'Sell') {
        // Sell proceeds (minus fees) add cash.
        await this.adjustCash(tx, userId, currency, cashDelta);
      }

      if (txType === 'Buy' || txType === 'Sell' || txType === 'Opening') {
        // Re-derive holdings/closed for the affected ticker.
        await this.rebuildTickersFromTransactions(tx, userId, [ticker]);
      }

      return insertRows[0];
    });

    return this.mapRow(result);
  }

  /**
   * Updates a transaction. It recomputes the old vs. new cash impact, applies the
   * net cash difference to the account, then rebuilds derived holdings/closed for
   * any ticker touched by the change. All in one transaction.
   *
   * @param userId Owner id.
   * @param id     Transaction primary key.
   * @param dto    Partial update payload.
   * @throws NotFoundException if the row is not owned by the user.
   * @throws BadRequestException if no updatable field is supplied.
   */
  async update(userId: string, id: string, dto: UpdateTransactionDto): Promise<Transaction> {
    const existing = await this.db
      .select()
      .from(transactions)
      .where(and(eq(transactions.id, id), eq(transactions.owner, userId)));

    if (existing.length === 0)
      // NOTE: Chinese user-facing message (existing behavior; not mojibake).
      throw new NotFoundException('交易记录不存在');
    const oldRow = existing[0];

    const patch: Record<string, unknown> = {};
    if (dto.txDate !== undefined) patch.txDate = dto.txDate;
    if (dto.ticker !== undefined) patch.ticker = dto.ticker;
    if (dto.txType !== undefined) patch.txType = dto.txType;
    if (dto.shares !== undefined) patch.shares = String(dto.shares);
    if (dto.price !== undefined) patch.price = String(dto.price);
    if (dto.fees !== undefined) patch.fees = String(dto.fees);
    if (dto.notes !== undefined) patch.notes = dto.notes;
    if (dto.currency !== undefined) patch.currency = dto.currency;

    if (Object.keys(patch).length === 0)
      // NOTE: Chinese user-facing message (existing behavior; not mojibake).
      throw new BadRequestException('未提供可更新字段');

    patch.updatedAt = new Date();
    patch.updatedBy = userId;

    // A rebuild is needed if any financial/identity field changed.
    const needsReconcile =
      dto.ticker !== undefined ||
      dto.txType !== undefined ||
      dto.shares !== undefined ||
      dto.price !== undefined ||
      dto.fees !== undefined ||
      dto.txDate !== undefined ||
      dto.currency !== undefined;

    const result = await this.db.transaction(async (tx) => {
      const oldCashDelta = this.getCashDeltaFromRow(oldRow);
      const newShares = dto.shares !== undefined ? Number(dto.shares) : Number(oldRow.shares);
      const newPrice = dto.price !== undefined ? Number(dto.price) : Number(oldRow.price);
      const newFees = dto.fees !== undefined ? Number(dto.fees) : Number(oldRow.fees || 0);
      const newType = (dto.txType || oldRow.txType) as string;
      const newCurrency = (dto.currency || oldRow.currency) as Currency;

      let newCashDelta = 0;
        if (newType === 'Buy') {
          newCashDelta = -(newShares * newPrice + newFees);
        } else if (newType === 'Sell') {
          newCashDelta = newShares * newPrice - newFees;
        } else if (newType === 'Deposit') {
          newCashDelta = newShares;
        } else if (newType === 'Withdrawal') {
          newCashDelta = -newShares;
        } else if (newType === 'Opening') {
          newCashDelta = 0;
        }

      if (newCurrency !== oldRow.currency) {
        if (Math.abs(oldCashDelta) > 1e-9) await this.adjustCash(tx, userId, oldRow.currency, -oldCashDelta);
        if (Math.abs(newCashDelta) > 1e-9) await this.adjustCash(tx, userId, newCurrency, newCashDelta);
      } else {
        const cashDiff = newCashDelta - oldCashDelta;
        if (Math.abs(cashDiff) > 1e-9) await this.adjustCash(tx, userId, newCurrency, cashDiff);
      }

      const updatedRows = await tx
        .update(transactions)
        .set(patch)
        .where(and(eq(transactions.id, id), eq(transactions.owner, userId)))
        .returning();

      if (updatedRows.length === 0)
        // NOTE: Chinese user-facing message (existing behavior; not mojibake).
        throw new NotFoundException('交易记录不存在');

      if (needsReconcile) {
        const oldType = oldRow.txType as string;
        const newType = (dto.txType || oldRow.txType) as string;
        const oldTicker = oldRow.ticker;
        const newTicker = (dto.ticker || oldRow.ticker).trim().toUpperCase();
        const tickersOld: string[] = [];
        const tickersNew: string[] = [];
        // Rebuild both the old and new tickers in case the ticker was changed.
        if (oldTicker && (oldType === 'Buy' || oldType === 'Sell' || oldType === 'Opening')) {
          tickersOld.push(oldTicker);
        }
        if (newTicker && (newType === 'Buy' || newType === 'Sell' || newType === 'Opening')) {
          tickersNew.push(newTicker);
        }
        const tickersToRebuild = Array.from(new Set([...tickersOld, ...tickersNew].filter((t) => t && t.length > 0)));
        await this.rebuildTickersFromTransactions(tx, userId, tickersToRebuild);
      }

      return updatedRows[0];
    });

    return this.mapRow(result);
  }

  /**
   * Deletes a transaction. Reverses its cash impact, removes any paired
   * auto-deposit row if this was the matching Buy, and rebuilds the affected
   * ticker's derived holdings/closed. All in one transaction.
   *
   * @param userId Owner id.
   * @param id     Transaction primary key.
   * @throws NotFoundException if the row is not owned by the user.
   */
  async remove(userId: string, id: string): Promise<void> {
    const existing = await this.db
      .select()
      .from(transactions)
      .where(and(eq(transactions.id, id), eq(transactions.owner, userId)));

    if (existing.length === 0)
      // NOTE: Chinese user-facing message (existing behavior; not mojibake).
      throw new NotFoundException('交易记录不存在');
    const oldRow = existing[0];

    await this.db.transaction(async (tx) => {
      const currency = (oldRow.currency as Currency) || 'USD';
      // Removing a transaction reverses its cash delta.
      let cashDelta = -this.getCashDeltaFromRow(oldRow);
      const idsToDelete: string[] = [id];

      // For a plain Buy (not already an auto-deposit buy), also delete the paired
      // synthetic Deposit rows created by createWithAutoDeposit.
      if (
        oldRow.txType === 'Buy' &&
        (!oldRow.notes || !oldRow.notes.startsWith('__AUTO_DEPOSIT_FOR_BUY__:'))
      ) {
        const costAmount =
          Number(oldRow.shares) * Number(oldRow.price) + Number(oldRow.fees || 0);
        const autoNote = `__AUTO_DEPOSIT_FOR_BUY__:${oldRow.ticker}`;
        const matchingDeposits = await tx
          .select()
          .from(transactions)
          .where(
            and(
              eq(transactions.owner, userId),
              eq(transactions.txType, 'Deposit'),
              eq(transactions.currency, currency),
              eq(transactions.notes, autoNote),
            ),
          )
          .orderBy(desc(transactions.createdAt))
          .limit(10);

        // Reclaim the deposited cash by removing the deposits, largest first.
        let remaining = costAmount;
        for (const dep of matchingDeposits) {
          if (remaining <= 1e-9) break;
          const depAmt = Number(dep.shares);
          if (depAmt <= remaining + 1e-9) {
            idsToDelete.push(dep.id);
            cashDelta -= depAmt;
            remaining -= depAmt;
          }
        }
      }

      if (Math.abs(cashDelta) > 1e-9) {
        await this.adjustCash(tx, userId, currency, cashDelta);
      }

      await tx
        .delete(transactions)
        .where(inArray(transactions.id, idsToDelete));

      if (oldRow.ticker && (oldRow.txType === 'Buy' || oldRow.txType === 'Sell' || oldRow.txType === 'Opening')) {
        await this.rebuildTickersFromTransactions(tx, userId, [oldRow.ticker]);
      }
    });
  }

  /**
   * Applies a Buy directly to a holdings row (creates or averages up).
   * NOTE: legacy helper; the live rebuild path uses `rebuildTickersFromTransactions`.
   *
   * @param tx        Active transaction.
   * @param userId    Owner id.
   * @param ticker    Ticker to update.
   * @param sharesNum Shares bought.
   * @param priceNum  Price per share.
   * @param feesNum   Fees paid.
   */
  private async applyBuyToHoldings(
    tx: PostgresJsDatabase,
    userId: string,
    ticker: string,
    sharesNum: number,
    priceNum: number,
    feesNum: number,
  ): Promise<void> {
    const existing = await tx
      .select()
      .from(holdings)
      .where(and(eq(holdings.owner, userId), eq(holdings.ticker, ticker)));

    if (existing.length === 0) {
      const marketInfo = this.quoteService.detectMarket(ticker);
      await tx.insert(holdings).values({
        ticker,
        company: ticker,
        shares: String(sharesNum),
        // Average buy price including fees spread over shares.
        buyPrice: String((sharesNum * priceNum + feesNum) / sharesNum),
        buyDate: new Date().toISOString().slice(0, 10),
        market: marketInfo.market,
        currency: marketInfo.currency,
        symbolNative: marketInfo.symbolNative,
        displaySymbol: marketInfo.displaySymbol,
        owner: userId,
        createdBy: userId,
        updatedBy: userId,
      });
      return;
    }

    const h = existing[0];
    const curShares = Number(h.shares);
    const curCost = curShares * Number(h.buyPrice);
    const newShares = curShares + sharesNum;
    const newCost = curCost + sharesNum * priceNum + feesNum;
    const newAvg = newCost / newShares;

    await tx
      .update(holdings)
      .set({
        shares: String(newShares),
        buyPrice: String(newAvg),
        updatedAt: new Date(),
        updatedBy: userId,
      })
      .where(eq(holdings.id, h.id));
  }

  /**
   * Reduces a holdings row by a sold amount (clamped to current shares).
   * NOTE: legacy helper; the live rebuild path uses `rebuildTickersFromTransactions`.
   *
   * @param tx        Active transaction.
   * @param userId    Owner id.
   * @param ticker    Ticker to update.
   * @param sharesNum Shares sold.
   * @param _priceNum Unused (kept for signature symmetry).
   * @param _feesNum  Unused (kept for signature symmetry).
   */
  private async applySellToHoldings(
    tx: PostgresJsDatabase,
    userId: string,
    ticker: string,
    sharesNum: number,
    _priceNum: number,
    _feesNum: number,
  ): Promise<void> {
    const existing = await tx
      .select()
      .from(holdings)
      .where(and(eq(holdings.owner, userId), eq(holdings.ticker, ticker)));

    if (existing.length === 0) return;

    const h = existing[0];
    const curShares = Number(h.shares);
    // Never sell more than currently held.
    const sellShares = Math.min(sharesNum, curShares);
    const newShares = curShares - sellShares;

    if (newShares <= 1e-9) {
      return;
    }

    await tx
      .update(holdings)
      .set({
        shares: String(newShares),
        updatedAt: new Date(),
        updatedBy: userId,
      })
      .where(eq(holdings.id, h.id));
  }

  /**
   * Reverses a prior Buy from a holdings row (used on delete/update).
   * NOTE: legacy helper; the live rebuild path uses `rebuildTickersFromTransactions`.
   *
   * @param tx        Active transaction.
   * @param userId    Owner id.
   * @param ticker    Ticker to update.
   * @param sharesNum Shares of the reversed buy.
   * @param priceNum  Price per share.
   * @param feesNum   Fees paid.
   */
  private async revertBuyFromHoldings(
    tx: PostgresJsDatabase,
    userId: string,
    ticker: string,
    sharesNum: number,
    priceNum: number,
    feesNum: number,
  ): Promise<void> {
    const existing = await tx
      .select()
      .from(holdings)
      .where(and(eq(holdings.owner, userId), eq(holdings.ticker, ticker)));

    if (existing.length === 0) return;

    const h = existing[0];
    const curShares = Number(h.shares);
    const curCost = curShares * Number(h.buyPrice);
    const newShares = Math.max(0, curShares - sharesNum);
    const newCost = Math.max(0, curCost - (sharesNum * priceNum + feesNum));

    if (newShares <= 1e-9) {
      return;
    }

    const newAvg = newCost / newShares;
    await tx
      .update(holdings)
      .set({
        shares: String(newShares),
        buyPrice: String(newAvg),
        updatedAt: new Date(),
        updatedBy: userId,
      })
      .where(eq(holdings.id, h.id));
  }

  /**
   * Reverses a prior Sell from a holdings row (re-adds shares and cost).
   * NOTE: legacy helper; the live rebuild path uses `rebuildTickersFromTransactions`.
   *
   * @param tx        Active transaction.
   * @param userId    Owner id.
   * @param ticker    Ticker to update.
   * @param sharesNum Shares of the reversed sell.
   * @param priceNum  Price per share.
   * @param feesNum   Fees paid.
   */
  private async revertSellFromHoldings(
    tx: PostgresJsDatabase,
    userId: string,
    ticker: string,
    sharesNum: number,
    priceNum: number,
    feesNum: number,
  ): Promise<void> {
    const existing = await tx
      .select()
      .from(holdings)
      .where(and(eq(holdings.owner, userId), eq(holdings.ticker, ticker)));

    if (existing.length === 0) return;

    const h = existing[0];
    const curShares = Number(h.shares);
    const curCost = curShares * Number(h.buyPrice);
    const addShares = sharesNum;
    const addCost = sharesNum * priceNum + feesNum;
    const newShares = curShares + addShares;
    const newCost = curCost + addCost;
    const newAvg = newShares > 0 ? newCost / newShares : 0;

    await tx
      .update(holdings)
      .set({
        shares: String(newShares),
        buyPrice: String(newAvg),
        updatedAt: new Date(),
        updatedBy: userId,
      })
      .where(eq(holdings.id, h.id));
  }

  /**
   * Full reconciliation: replays ALL of the user's transactions in chronological
   * order to recompute holdings (average cost), closed positions (realized P&L),
   * and per-currency cash balances from scratch. Used by the `/reconcile` route as
   * a self-healing operation. Runs in one transaction.
   *
   * @param userId Owner id.
   * @returns Counts of resulting holdings, closed positions, and processed txs.
   */
  async reconcileAll(userId: string): Promise<ReconcileResult> {
    const allTx = await this.db
      .select()
      .from(transactions)
      .where(eq(transactions.owner, userId))
      .orderBy(asc(transactions.txDate), asc(transactions.id));

    const allHoldings = await this.db
      .select()
      .from(holdings)
      .where(eq(holdings.owner, userId));

    if (allTx.length === 0) {
      return {
        holdingsCount: allHoldings.length,
        closedCount: 0,
        processedTxCount: 0,
      };
    }

    // Recompute expected cash per currency from the transaction history.
    const cashByCurrency = this.computeCashFromTransactions(allTx);

    const result = await this.db.transaction(async (tx) => {
      const txByTicker = new Map<string, typeof allTx>();
      for (const t of allTx) {
         // Skip cash flows when grouping by ticker.
         if (!t.ticker || t.txType === 'Deposit' || t.txType === 'Withdrawal') continue;
        const arr = txByTicker.get(t.ticker) ?? [];
        arr.push(t);
        txByTicker.set(t.ticker, arr);
      }

      const holdingByTicker = new Map<string, typeof allHoldings[number]>();
      for (const h of allHoldings) {
        holdingByTicker.set(h.ticker, h);
      }

      const rebuiltTickers: string[] = [];
      for (const [ticker, txs] of txByTicker) {
       const hasBuyOrOpening = txs.some(
          (t: (typeof txs)[number]) => t.txType === 'Buy' || t.txType === 'Opening',
        );
        // Only tickers that ever opened a position produce a holding.
        if (hasBuyOrOpening) rebuiltTickers.push(ticker);
      }
      const updatedHoldings: Array<{
        id: string;
        shares: string;
        buyPrice: string;
        buyDate: string | null;
      }> = [];
      const newHoldings: Array<typeof holdings.$inferInsert> = [];
      const closedRows: Array<typeof closed.$inferInsert> = [];

       for (const ticker of rebuiltTickers) {
         const txs = txByTicker.get(ticker) ?? [];
         const existingH = holdingByTicker.get(ticker);

         const cursor: TxCursor = {
           ticker,
           shares: 0,
           costBasis: 0,
           buyDate: null,
           company: existingH?.company ?? ticker,
         };

         for (const t of txs) {
          const sharesNum = Number(t.shares);
          const priceNum = Number(t.price);
          const feesNum = t.fees ? Number(t.fees) : 0;

          if (t.txType === 'Buy' || t.txType === 'Opening') {
            cursor.costBasis += sharesNum * priceNum + feesNum;
            cursor.shares += sharesNum;
            if (!cursor.buyDate) cursor.buyDate = String(t.txDate);
          } else if (t.txType === 'Sell') {
            if (cursor.shares <= 1e-9) continue;

            // Average-cost accounting for the realized P&L of this sell.
            const avgCost = cursor.shares > 0 ? cursor.costBasis / cursor.shares : 0;
            const sellShares = Math.min(sharesNum, cursor.shares);
            const sellCost = avgCost * sellShares;
            const sellProceeds = sellShares * priceNum - feesNum;
            const realizedPl = sellProceeds - sellCost;
            const returnPct = sellCost > 0 ? (realizedPl / sellCost) * 100 : 0;

            closedRows.push({
              ticker,
              company: cursor.company,
              openDate: cursor.buyDate,
              closeDate: String(t.txDate),
              buyPrice: avgCost > 0 ? String(avgCost) : null,
              sellPrice: String(priceNum),
              shares: String(sellShares),
              realizedPl: String(realizedPl),
              returnPct: String(returnPct),
              notes: t.notes,
              owner: userId,
              createdBy: userId,
              updatedBy: userId,
            });

            cursor.shares -= sellShares;
            cursor.costBasis -= sellCost;

            if (cursor.shares <= 1e-9) {
              // Position fully closed: reset the cursor.
              cursor.shares = 0;
              cursor.costBasis = 0;
              cursor.buyDate = null;
            }
          }
        }

        if (existingH) {
          if (cursor.shares > 0) {
            const avgBuyPrice = cursor.costBasis / cursor.shares;
            updatedHoldings.push({
              id: existingH.id,
              shares: String(cursor.shares),
              buyPrice: String(avgBuyPrice),
              buyDate: cursor.buyDate,
            });
          } else {
            // Position closed out: remove the holding row.
            await tx.delete(holdings).where(eq(holdings.id, existingH.id));
          }
        } else if (cursor.shares > 0) {
          const avgBuyPrice = cursor.costBasis / cursor.shares;
          newHoldings.push({
            ticker,
            ...this.quoteService.detectMarket(ticker),
            company: cursor.company ?? ticker,
            shares: String(cursor.shares),
            buyPrice: String(avgBuyPrice),
            buyDate: cursor.buyDate,
            owner: userId,
            createdBy: userId,
            updatedBy: userId,
          });
        }
      }

      for (const h of updatedHoldings) {
        await tx
          .update(holdings)
          .set({
            shares: h.shares,
            buyPrice: h.buyPrice,
            buyDate: h.buyDate,
            updatedAt: new Date(),
            updatedBy: userId,
          })
          .where(eq(holdings.id, h.id));
      }

      if (newHoldings.length > 0) {
        await tx.insert(holdings).values(newHoldings);
      }

      // Rebuild closed positions for the affected tickers from scratch.
      if (rebuiltTickers.length > 0) {
        await tx.delete(closed).where(
          and(eq(closed.owner, userId), inArray(closed.ticker, rebuiltTickers)),
        );
      }

      if (closedRows.length > 0) {
        await tx.insert(closed).values(closedRows);
      }

      const remainingHoldings = await tx
        .select({ id: holdings.id })
        .from(holdings)
        .where(eq(holdings.owner, userId));

      const allClosed = await tx
        .select({ id: closed.id })
        .from(closed)
        .where(eq(closed.owner, userId));

      // Overwrite each currency's cash balance with the recomputed value.
      for (const [currency, balance] of cashByCurrency) {
        const existing = await tx
          .select()
          .from(cashAccounts)
          .where(
            and(eq(cashAccounts.owner, userId), eq(cashAccounts.currency, currency)),
          );
        if (existing.length === 0) {
          await tx.insert(cashAccounts).values({
            currency,
            balance: String(balance),
            owner: userId,
            createdBy: userId,
            updatedBy: userId,
          });
        } else {
          await tx
            .update(cashAccounts)
            .set({
              balance: String(balance),
              updatedAt: new Date(),
              updatedBy: userId,
            })
            .where(eq(cashAccounts.id, existing[0].id));
        }
      }

      return {
        holdingsCount: remainingHoldings.length,
        closedCount: allClosed.length,
        processedTxCount: allTx.length,
      };
    });

    return result;
  }

  /**
   * Computes the signed cash impact of a single transaction row. Positive = cash
   * in, negative = cash out.
   *
   * @param row Transaction row.
   * @returns Signed cash delta in the row's currency.
   */
  private getCashDeltaFromRow(row: typeof transactions.$inferSelect): number {
    const sharesNum = Number(row.shares);
    const priceNum = Number(row.price);
    const feesNum = row.fees ? Number(row.fees) : 0;
    const type = row.txType;
    if (type === 'Buy') return -(sharesNum * priceNum + feesNum);
    if (type === 'Sell') return sharesNum * priceNum - feesNum;
    if (type === 'Deposit') return sharesNum;
    if (type === 'Withdrawal') return -sharesNum;
    if (type === 'Opening') return 0;
    return 0;
  }

  /**
   * Sums cash deltas across all transactions, grouped by currency.
   *
   * @param allTx Transaction rows.
   * @returns Map of currency -> net cash balance.
   */
  private computeCashFromTransactions(
    allTx: Array<typeof transactions.$inferSelect>,
  ): Map<string, number> {
    const cashByCurrency = new Map<string, number>();
    for (const t of allTx) {
      const currency = (t.currency as string) || 'USD';
      const delta = this.getCashDeltaFromRow(t);
      const current = cashByCurrency.get(currency) ?? 0;
      cashByCurrency.set(currency, current + delta);
    }
    return cashByCurrency;
  }

  /**
   * Applies a cash balance change to a user's currency account. Creates the
   * account if missing and the change is positive; rejects (throws) any change
   * that would drive the balance below zero.
   *
   * @param tx       Active transaction.
   * @param userId   Owner id.
   * @param currency Account currency.
   * @param delta    Signed amount to add (negative to withdraw).
   * @throws BadRequestException if the resulting balance would be negative.
   */
  private async adjustCash(
    tx: PostgresJsDatabase,
    userId: string,
    currency: string,
    delta: number,
  ): Promise<void> {
    if (Math.abs(delta) < 1e-9) return;

    const existing = await tx
      .select()
      .from(cashAccounts)
      .where(and(eq(cashAccounts.owner, userId), eq(cashAccounts.currency, currency)));

    if (existing.length === 0) {
      if (delta < 0) {
        // NOTE: Chinese user-facing message (existing behavior; not mojibake).
        throw new BadRequestException(`现金不足：${currency} 账户余额为 0`);
      }
      await tx.insert(cashAccounts).values({
        currency,
        balance: String(delta),
        owner: userId,
        createdBy: userId,
        updatedBy: userId,
      });
      return;
    }

    const curBalance = Number(existing[0].balance);
    const newBalance = curBalance + delta;
    if (newBalance < -1e-9) {
      // Cash non-negative risk gate: reject trades that overdraw the account.
      // NOTE: Chinese user-facing message (existing behavior; not mojibake).
      throw new BadRequestException(
        `现金不足：${currency} 余额 ${curBalance.toFixed(2)}，需要 ${Math.abs(delta).toFixed(2)}`,
      );
    }

    await tx
      .update(cashAccounts)
      .set({
        balance: sql`${cashAccounts.balance} + ${delta}::numeric`,
        updatedAt: new Date(),
        updatedBy: userId,
      })
      .where(eq(cashAccounts.id, existing[0].id));
  }

  /**
   * Incrementally rebuilds derived holdings and closed positions for a specific
   * set of tickers from their transactions (used after create/update/delete,
   * instead of a full reconciliation).
   *
   * @param tx       Active transaction.
   * @param userId   Owner id.
   * @param tickers  Tickers to rebuild.
   */
  private async rebuildTickersFromTransactions(
    tx: PostgresJsDatabase,
    userId: string,
    tickers: string[],
  ): Promise<void> {
    const validTickers = tickers.filter((t) => t && t.length > 0);
    if (validTickers.length === 0) return;

    const relevantTx = await tx
      .select()
      .from(transactions)
      .where(
        and(
          eq(transactions.owner, userId),
          inArray(transactions.ticker, validTickers),
        ),
      )
      .orderBy(asc(transactions.txDate), asc(transactions.id));

    const existingHoldings = await tx
      .select()
      .from(holdings)
      .where(
        and(eq(holdings.owner, userId), inArray(holdings.ticker, validTickers)),
      );

    const holdingByTicker = new Map<string, typeof existingHoldings[number]>();
    for (const h of existingHoldings) {
      holdingByTicker.set(h.ticker, h);
    }

    const txByTicker = new Map<string, typeof relevantTx>();
    for (const t of relevantTx) {
      const arr = txByTicker.get(t.ticker) ?? [];
      arr.push(t);
      txByTicker.set(t.ticker, arr);
    }

    const updateHoldingMap = new Map<
      string,
      { shares: string; buyPrice: string; buyDate: string | null }
    >();
    const deleteHoldingTickers: string[] = [];
    const closedRows: Array<typeof closed.$inferInsert> = [];

    for (const ticker of validTickers) {
      const txs = txByTicker.get(ticker) ?? [];
      const existingH = holdingByTicker.get(ticker);
      const hasBuyOrOpening = txs.some((t) => t.txType === 'Buy' || t.txType === 'Opening');

      if (!hasBuyOrOpening) {
        if (existingH) deleteHoldingTickers.push(ticker);
        continue;
      }

      const cursor: TxCursor = {
        ticker,
        shares: 0,
        costBasis: 0,
        buyDate: null,
        company: existingH?.company ?? ticker,
      };

      for (const t of txs) {
        const sharesNum = Number(t.shares);
        const priceNum = Number(t.price);
        const feesNum = t.fees ? Number(t.fees) : 0;

        if (t.txType === 'Buy' || t.txType === 'Opening') {
          cursor.costBasis += sharesNum * priceNum + feesNum;
          cursor.shares += sharesNum;
          if (!cursor.buyDate) cursor.buyDate = String(t.txDate);
        } else if (t.txType === 'Sell') {
          if (cursor.shares <= 1e-9) continue;

          // Average-cost realized P&L for this sell.
          const avgCost = cursor.shares > 0 ? cursor.costBasis / cursor.shares : 0;
          const sellShares = Math.min(sharesNum, cursor.shares);
          const sellCost = avgCost * sellShares;
          const sellProceeds = sellShares * priceNum - feesNum;
          const realizedPl = sellProceeds - sellCost;
          const returnPct = sellCost > 0 ? (realizedPl / sellCost) * 100 : 0;

          closedRows.push({
            ticker,
            company: cursor.company,
            openDate: cursor.buyDate,
            closeDate: String(t.txDate),
            buyPrice: avgCost > 0 ? String(avgCost) : null,
            sellPrice: String(priceNum),
            shares: String(sellShares),
            realizedPl: String(realizedPl),
            returnPct: String(returnPct),
            notes: t.notes,
            owner: userId,
            createdBy: userId,
            updatedBy: userId,
          });

          cursor.shares -= sellShares;
          cursor.costBasis -= sellCost;

          if (cursor.shares <= 1e-9) {
            cursor.shares = 0;
            cursor.costBasis = 0;
            cursor.buyDate = null;
          }
        }
      }

      if (cursor.shares > 0) {
        const avgBuyPrice = cursor.costBasis / cursor.shares;
        updateHoldingMap.set(ticker, {
          shares: String(cursor.shares),
          buyPrice: String(avgBuyPrice),
          buyDate: cursor.buyDate,
        });
      } else {
        // Position closed out: schedule the holding for deletion.
        deleteHoldingTickers.push(ticker);
      }
    }

    for (const [ticker, data] of updateHoldingMap) {
      const existing = holdingByTicker.get(ticker);
      if (existing) {
        await tx
          .update(holdings)
          .set({
            shares: data.shares,
            buyPrice: data.buyPrice,
            buyDate: data.buyDate,
            updatedAt: new Date(),
            updatedBy: userId,
          })
          .where(eq(holdings.id, existing.id));
      } else {
        await tx.insert(holdings).values({
          ticker,
          ...this.quoteService.detectMarket(ticker),
          shares: data.shares,
          buyPrice: data.buyPrice,
          buyDate: data.buyDate,
          owner: userId,
          createdBy: userId,
          updatedBy: userId,
        });
      }
    }

    if (deleteHoldingTickers.length > 0) {
      await tx
        .delete(holdings)
        .where(
          and(eq(holdings.owner, userId), inArray(holdings.ticker, deleteHoldingTickers)),
        );
    }

    // Rebuild closed positions for these tickers from scratch.
    await tx
      .delete(closed)
      .where(and(eq(closed.owner, userId), inArray(closed.ticker, validTickers)));

    if (closedRows.length > 0) {
      await tx.insert(closed).values(closedRows);
    }
  }

  /**
   * Maps a raw transaction row to the API `Transaction` shape, defaulting currency
   * to USD and fees to 0.
   *
   * @param row Raw transactions table row.
   */
  private mapRow(row: typeof transactions.$inferSelect): Transaction {
    return {
      id: row.id,
      txDate: String(row.txDate),
      ticker: row.ticker,
      txType: row.txType as Transaction['txType'],
      shares: String(row.shares),
      price: String(row.price),
      fees: String(row.fees ?? '0'),
      notes: row.notes ?? null,
      currency: (row.currency as Transaction['currency']) || 'USD',
    };
  }
}
