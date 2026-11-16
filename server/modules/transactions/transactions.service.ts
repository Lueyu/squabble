/**
 * transactions.service.ts — 交易记账服务（组合的唯一事实来源）。
 *
 * 职责边界：
 *  - 承载交易（Buy / Sell / Deposit / Withdrawal / Opening）的 CRUD 与派生状态重建；
 *    持仓、已平仓（已实现盈亏）、分币种现金余额全部由交易记录派生并在每次变更后重建。
 *    不做 HTTP 校验（控制器层负责），不调用外部行情写入（只读 QuoteService.detectMarket）。
 * 上下游：
 *  - 上游（谁调用本服务）：TransactionsController、server 内复用对账逻辑的其他模块。
 *  - 下游（本文件调用谁）：Drizzle 数据库（transactions / holdings / closed / cashAccounts 四张表）、
 *    QuoteService.detectMarket（币种与市场推断）。
 * 关键约定：
 *  - 所有写操作都在单个数据库事务内执行。
 *  - 现金按币种记账，余额永不为负（adjustCash 越界即抛 BadRequestException）。
 *  - 现金不足的买入走 createWithAutoDeposit：先自动存入差额，并落一条 notes 标记为
 *    `__AUTO_DEPOSIT_FOR_BUY__:<ticker>` 的配对 Deposit 行；删除该买入时会回冲这笔配对存入。
 *  - 单位约定：DB 数值列（numeric）与 API 层均以字符串数值流转（如 '123.45'），
 *    计算前用 Number() 转换；shares 字段在 Deposit/Withdrawal 类型里承载的是"金额"而非股数。
 *  - 浮点比较统一用 1e-9 容差，避免二进制浮点误差误判。
 */
import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
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

/** 新建 DTO 的部分更新变体。 */
type UpdateTransactionDto = Partial<CreateTransactionDto>;

/**
 * 按时间顺序回放某 ticker 的交易记录、重算持股数量与平均成本时的游标状态。
 */
interface TxCursor {
  /** 正在回放的 ticker。 */
  ticker: string;
  /** 当前净持股数量。 */
  shares: number;
  /** 剩余持股的总成本基础。 */
  costBasis: number;
  /** 首笔开仓（买入）交易日期，无则为 null。 */
  buyDate: string | null;
  /** 透传到派生 holdings/closed 行的公司显示名。 */
  company: string | null;
}

/**
 * 提供交易 CRUD 与派生状态重建（持仓、已平仓、现金），依赖注入的 Drizzle 数据库连接。
 */
@Injectable()
export class TransactionsService {
  private readonly logger = new Logger(TransactionsService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly quoteService: QuoteService,
  ) {}

  /**
   * 列出用户交易记录，最新在前，可按 ticker 过滤。
   *
   * @param userId 来自鉴权请求的 owner id。
   * @param ticker 可选 ticker 过滤条件。
   * @param limit  最大行数（由调用方在控制器层钳制；默认 100）。
   * @returns Transaction 数组。
   */
  async list(
    userId: string,
    ticker?: string,
    limit: number = 100,
    offset = 0,
  ): Promise<Transaction[]> {
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
   * 按 id 获取单条交易记录，仅当记录属于调用者时返回。
   *
   * @param userId 用于 owner 过滤的用户 id。
   * @param id     交易记录主键。
   * @returns Transaction。
   * @throws NotFoundException 当 (id, owner) 无匹配行时。
   */
  async getById(userId: string, id: string): Promise<Transaction> {
    const rows = await this.db
      .select()
      .from(transactions)
      .where(and(eq(transactions.id, id), eq(transactions.owner, userId)));

    if (rows.length === 0)
      // NOTE: 用户可见文案为中文，属既有行为而非乱码。
      throw new NotFoundException('交易记录不存在');

    return this.mapRow(rows[0]);
  }

  /**
   * 创建买入交易；若该币种现金不足，先自动存入差额。自动存入以合成 Deposit 行落库，
   * 通过 notes 标记配对。存款、扣款、买入落库、持仓重建全部在同一个事务内执行。
   *
   * @param userId owner id。
   * @param dto    新建载荷（必须是 Buy 类型）。
   * @returns 新建后的 Transaction。
   * @throws BadRequestException 校验失败时。
   */
  async createWithAutoDeposit(userId: string, dto: CreateTransactionDto): Promise<Transaction> {
    // 入参规范化与校验：数值字段转 number，ticker 统一大写。
    if (dto.txType !== 'Buy') {
      // NOTE: 用户可见文案为中文，属既有行为而非乱码。
      throw new BadRequestException('自动充值仅支持买入交易');
    }

    const sharesNum = Number(dto.shares);
    const priceNum = Number(dto.price);
    const feesNum = dto.fees !== undefined ? Number(dto.fees) : 0;
    const currency = (dto.currency as Currency) || 'USD';
    const ticker = dto.ticker?.trim().toUpperCase();

    if (!dto.txDate)
      // NOTE: 用户可见文案为中文，属既有行为而非乱码。
      throw new BadRequestException('交易日期不能为空');
    if (sharesNum <= 0 || isNaN(sharesNum))
      // NOTE: 用户可见文案为中文，属既有行为而非乱码。
      throw new BadRequestException('数量必须大于 0');
    if (!ticker)
      // NOTE: 用户可见文案为中文，属既有行为而非乱码。
      throw new BadRequestException('代码不能为空');
    if (priceNum <= 0 || isNaN(priceNum))
      // NOTE: 用户可见文案为中文，属既有行为而非乱码。
      throw new BadRequestException('价格必须大于 0');

    // 本次买入的总现金流出（含手续费）。
    const costAmount = sharesNum * priceNum + feesNum;

    const result = await this.db.transaction(async (tx) => {
      // 先读当前现金账户，算出买入所需差额。
      const existing = await tx
        .select()
        .from(cashAccounts)
        .where(and(eq(cashAccounts.owner, userId), eq(cashAccounts.currency, currency)));
      const curBalance = existing.length > 0 ? Number(existing[0].balance) : 0;
      // 买够这笔还需要多少现金。
      const shortfall = costAmount - curBalance;

      if (shortfall > 1e-9) {
        // 现金不足：把差额补进现金账户（账户缺失则建户，否则累加）。
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

        // 落一条配对的合成 Deposit 行，日后删除该买入时可据此回收这笔存入。
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

      // 支付买入的现金流出。
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

      // 从更新后的交易历史重派生该 ticker 的持仓/已平仓。
      await this.rebuildTickersFromTransactions(tx, userId, [ticker]);

      return insertRows[0];
    });

    return this.mapRow(result);
  }

  /**
   * 创建任意合法类型的交易。现金流类型（Deposit/Withdrawal）只调整现金；
   * Buy/Sell/Opening 调整现金后还会重建受影响 ticker 的派生持仓。
   * 全部在单个数据库事务内执行。
   *
   * @param userId owner id。
   * @param dto    新建载荷。
   * @returns 新建后的 Transaction。
   * @throws BadRequestException 校验失败时。
   */
  async create(userId: string, dto: CreateTransactionDto): Promise<Transaction> {
    // 入参规范化：数值字段转 number，币种缺省 USD。
    const sharesNum = Number(dto.shares);
    const priceNum = Number(dto.price);
    const feesNum = dto.fees !== undefined ? Number(dto.fees) : 0;
    const currency = (dto.currency as Currency) || 'USD';
    const rawTxType = dto.txType;

    const validTypes = ['Buy', 'Sell', 'Deposit', 'Withdrawal', 'Opening'] as const;
    if (!validTypes.includes(rawTxType as (typeof validTypes)[number]))
      // NOTE: 用户可见文案为中文，属既有行为而非乱码。
      throw new BadRequestException('交易类型无效');
    const txType = rawTxType;

    const isCashFlow = txType === 'Deposit' || txType === 'Withdrawal';
    const isOpening = txType === 'Opening';

    if (!dto.txDate)
      // NOTE: 用户可见文案为中文，属既有行为而非乱码。
      throw new BadRequestException('交易日期不能为空');

    if (sharesNum <= 0 || isNaN(sharesNum)) {
      // 现金流与股票交易对 shares 字段的语义不同，报错文案也相应区分。
      // NOTE: 用户可见文案为中文，属既有行为而非乱码。
      throw new BadRequestException(isCashFlow ? '金额必须大于 0' : '数量必须大于 0');
    }

    if (!isCashFlow && !isOpening) {
      if (!dto.ticker || !dto.ticker.trim()) {
        // NOTE: 用户可见文案为中文，属既有行为而非乱码。
        throw new BadRequestException('代码不能为空');
      }
      if (priceNum <= 0 || isNaN(priceNum)) {
        // NOTE: 用户可见文案为中文，属既有行为而非乱码。
        throw new BadRequestException('价格必须大于 0');
      }
    }

    // 现金流/建仓的 ticker 可为空或可选；股票交易必须提供（统一大写）。
    const ticker =
      isCashFlow || isOpening
        ? isOpening
          ? (dto.ticker?.trim().toUpperCase() ?? '')
          : ''
        : dto.ticker.trim().toUpperCase();

    if (isCashFlow) {
      // 存入加现金，取款减现金。
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

    // 股票交易（Buy/Sell/Opening）：先算现金变动方向。
    const result = await this.db.transaction(async (tx) => {
      if (txType === 'Sell') {
        // 卖出前锁定持仓行（行级锁），再回放全部历史交易核对可卖数量。
        await tx
          .select({ id: holdings.id })
          .from(holdings)
          .where(and(eq(holdings.owner, userId), eq(holdings.ticker, ticker)))
          .for('update');
        const prior = await tx
          .select()
          .from(transactions)
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
        txType === 'Buy' ? -(sharesNum * priceNum + feesNum) : sharesNum * priceNum - feesNum;

      // 买入花现金；建仓（Opening）不动现金（只设定起始批次）。
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
        // 卖出所得（扣手续费后）加回现金。
        await this.adjustCash(tx, userId, currency, cashDelta);
      }

      if (txType === 'Buy' || txType === 'Sell' || txType === 'Opening') {
        // 重派生受影响 ticker 的持仓/已平仓。
        await this.rebuildTickersFromTransactions(tx, userId, [ticker]);
      }

      return insertRows[0];
    });

    return this.mapRow(result);
  }

  /**
   * 更新交易记录。先算旧值与新值的现金影响差，把净差额应用到现金账户，
   * 再对变更涉及的所有 ticker 重建派生持仓/已平仓。全部在单个事务内执行。
   *
   * @param userId owner id。
   * @param id     交易记录主键。
   * @param dto    部分更新载荷。
   * @returns 更新后的 Transaction。
   * @throws NotFoundException 记录不属于该用户时。
   * @throws BadRequestException 未提供任何可更新字段时。
   */
  async update(userId: string, id: string, dto: UpdateTransactionDto): Promise<Transaction> {
    const existing = await this.db
      .select()
      .from(transactions)
      .where(and(eq(transactions.id, id), eq(transactions.owner, userId)));

    if (existing.length === 0)
      // NOTE: 用户可见文案为中文，属既有行为而非乱码。
      throw new NotFoundException('交易记录不存在');
    const oldRow = existing[0];

    // 只把 payload 中显式给出的字段搬进 patch，数值字段转字符串落库。
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
      // NOTE: 用户可见文案为中文，属既有行为而非乱码。
      throw new BadRequestException('未提供可更新字段');

    // 补齐审计字段。
    patch.updatedAt = new Date();
    patch.updatedBy = userId;

    // 只要金融/身份字段有变，就需要重建派生状态。
    const needsReconcile =
      dto.ticker !== undefined ||
      dto.txType !== undefined ||
      dto.shares !== undefined ||
      dto.price !== undefined ||
      dto.fees !== undefined ||
      dto.txDate !== undefined ||
      dto.currency !== undefined;

    const result = await this.db.transaction(async (tx) => {
      // 计算旧记录与（合并 patch 后）新记录各自的现金影响。
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

      // 币种变更时分别回冲旧币种、应用新币种；否则只补差额。
      if (newCurrency !== oldRow.currency) {
        if (Math.abs(oldCashDelta) > 1e-9)
          await this.adjustCash(tx, userId, oldRow.currency, -oldCashDelta);
        if (Math.abs(newCashDelta) > 1e-9)
          await this.adjustCash(tx, userId, newCurrency, newCashDelta);
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
        // NOTE: 用户可见文案为中文，属既有行为而非乱码。
        throw new NotFoundException('交易记录不存在');

      if (needsReconcile) {
        // ticker 可能被改，旧、新两个 ticker 都要重派生。
        const oldType = oldRow.txType as string;
        const newType = (dto.txType || oldRow.txType) as string;
        const oldTicker = oldRow.ticker;
        const newTicker = (dto.ticker || oldRow.ticker).trim().toUpperCase();
        const tickersOld: string[] = [];
        const tickersNew: string[] = [];
        // 仅股票类交易（Buy/Sell/Opening）会派生持仓/已平仓。
        if (oldTicker && (oldType === 'Buy' || oldType === 'Sell' || oldType === 'Opening')) {
          tickersOld.push(oldTicker);
        }
        if (newTicker && (newType === 'Buy' || newType === 'Sell' || newType === 'Opening')) {
          tickersNew.push(newTicker);
        }
        const tickersToRebuild = Array.from(
          new Set([...tickersOld, ...tickersNew].filter((t) => t && t.length > 0)),
        );
        await this.rebuildTickersFromTransactions(tx, userId, tickersToRebuild);
      }

      return updatedRows[0];
    });

    return this.mapRow(result);
  }

  /**
   * 删除交易记录。回冲其现金影响，若是普通买入则连带删除 createWithAutoDeposit
   * 产生的配对自动存入行，并重建受影响 ticker 的派生持仓/已平仓。全部在单个事务内执行。
   *
   * @param userId owner id。
   * @param id     交易记录主键。
   * @throws NotFoundException 记录不属于该用户时。
   */
  async remove(userId: string, id: string): Promise<void> {
    const existing = await this.db
      .select()
      .from(transactions)
      .where(and(eq(transactions.id, id), eq(transactions.owner, userId)));

    if (existing.length === 0)
      // NOTE: 用户可见文案为中文，属既有行为而非乱码。
      throw new NotFoundException('交易记录不存在');
    const oldRow = existing[0];

    await this.db.transaction(async (tx) => {
      const currency = (oldRow.currency as Currency) || 'USD';
      // 删除交易意味着回冲其现金变动。
      let cashDelta = -this.getCashDeltaFromRow(oldRow);
      const idsToDelete: string[] = [id];

      // 普通买入（本身不是自动存入买入）还要连带删除配对的合成 Deposit 行。
      if (
        oldRow.txType === 'Buy' &&
        (!oldRow.notes || !oldRow.notes.startsWith('__AUTO_DEPOSIT_FOR_BUY__:'))
      ) {
        const costAmount = Number(oldRow.shares) * Number(oldRow.price) + Number(oldRow.fees || 0);
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

        // 通过删除配对存入行回收垫付的现金，从最近的开始、够额即止。
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

      await tx.delete(transactions).where(inArray(transactions.id, idsToDelete));

      if (
        oldRow.ticker &&
        (oldRow.txType === 'Buy' || oldRow.txType === 'Sell' || oldRow.txType === 'Opening')
      ) {
        await this.rebuildTickersFromTransactions(tx, userId, [oldRow.ticker]);
      }
    });
  }

  /**
   * 直接把一笔买入应用到持仓行（建户或摊高均价）。
   * NOTE: 遗留辅助方法；现行重建路径走 `rebuildTickersFromTransactions`。
   *
   * @param tx        活动事务。
   * @param userId    owner id。
   * @param ticker    要更新的 ticker。
   * @param sharesNum 买入股数。
   * @param priceNum  每股价格。
   * @param feesNum   手续费。
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
        // 含手续费的买入均价（手续费摊到每股）。
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
   * 从持仓行扣减卖出数量（上限为当前持股）。
   * NOTE: 遗留辅助方法；现行重建路径走 `rebuildTickersFromTransactions`。
   *
   * @param tx        活动事务。
   * @param userId    owner id。
   * @param ticker    要更新的 ticker。
   * @param sharesNum 卖出股数。
   * @param _priceNum 未使用（保持签名对称）。
   * @param _feesNum  未使用（保持签名对称）。
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
    // 永不卖出超过当前持股的数量。
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
   * 从持仓行回冲一笔此前的买入（用于删除/更新）。
   * NOTE: 遗留辅助方法；现行重建路径走 `rebuildTickersFromTransactions`。
   *
   * @param tx        活动事务。
   * @param userId    owner id。
   * @param ticker    要更新的 ticker。
   * @param sharesNum 回冲的买入股数。
   * @param priceNum  每股价格。
   * @param feesNum   手续费。
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
   * 从持仓行回冲一笔此前的卖出（把股数与成本加回）。
   * NOTE: 遗留辅助方法；现行重建路径走 `rebuildTickersFromTransactions`。
   *
   * @param tx        活动事务。
   * @param userId    owner id。
   * @param ticker    要更新的 ticker。
   * @param sharesNum 回冲的卖出股数。
   * @param priceNum  每股价格。
   * @param feesNum   手续费。
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
   * 全量对账：按时间顺序回放用户全部交易，从零重算持仓（平均成本）、
   * 已平仓（已实现盈亏）与分币种现金余额。供 `/reconcile` 路由做自愈操作使用。
   * 在单个事务内执行。
   *
   * @param userId owner id。
   * @returns 最终的持仓数、已平仓数与处理的交易数。
   */
  async reconcileAll(userId: string): Promise<ReconcileResult> {
    const allTx = await this.db
      .select()
      .from(transactions)
      .where(eq(transactions.owner, userId))
      .orderBy(asc(transactions.txDate), asc(transactions.id));

    const allHoldings = await this.db.select().from(holdings).where(eq(holdings.owner, userId));

    // 没有任何交易时无需重建，直接按现状返回。
    if (allTx.length === 0) {
      return {
        holdingsCount: allHoldings.length,
        closedCount: 0,
        processedTxCount: 0,
      };
    }

    // 从交易历史重算每个币种的预期现金余额。
    const cashByCurrency = this.computeCashFromTransactions(allTx);

    const result = await this.db.transaction(async (tx) => {
      // 按 ticker 分组交易记录，现金流类型不参与分组。
      const txByTicker = new Map<string, typeof allTx>();
      for (const t of allTx) {
        if (!t.ticker || t.txType === 'Deposit' || t.txType === 'Withdrawal') continue;
        const arr = txByTicker.get(t.ticker) ?? [];
        arr.push(t);
        txByTicker.set(t.ticker, arr);
      }

      const holdingByTicker = new Map<string, (typeof allHoldings)[number]>();
      for (const h of allHoldings) {
        holdingByTicker.set(h.ticker, h);
      }

      // 只统计曾开过仓的 ticker；其余不产持仓行。
      const rebuiltTickers: string[] = [];
      for (const [ticker, txs] of txByTicker) {
        const hasBuyOrOpening = txs.some(
          (t: (typeof txs)[number]) => t.txType === 'Buy' || t.txType === 'Opening',
        );
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

        // 逐笔回放：买入累加成本与股数，卖出按均价法落已平仓行。
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

            // 该笔卖出的已实现盈亏按平均成本法核算。
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
              // 仓位清零：重置游标。
              cursor.shares = 0;
              cursor.costBasis = 0;
              cursor.buyDate = null;
            }
          }
        }

        // 回放结束：按剩余仓位更新/删除/新建持仓行。
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
            // 仓位已清空：删除持仓行。
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

      // 受影响 ticker 的已平仓记录从零重建。
      if (rebuiltTickers.length > 0) {
        await tx
          .delete(closed)
          .where(and(eq(closed.owner, userId), inArray(closed.ticker, rebuiltTickers)));
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

      // 用重算值覆盖每个币种的现金余额。
      for (const [currency, balance] of cashByCurrency) {
        const existing = await tx
          .select()
          .from(cashAccounts)
          .where(and(eq(cashAccounts.owner, userId), eq(cashAccounts.currency, currency)));
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
   * 计算单条交易行的带符号现金影响。正 = 现金流入，负 = 现金流出。
   *
   * @param row 交易行。
   * @returns 该行币种下的带符号现金变动。
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
   * 汇总全部交易的现金影响，按币种分组求和。
   *
   * @param allTx 交易行数组。
   * @returns 币种 -> 净现金余额 的 Map。
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
   * 对某币种现金账户应用一笔余额变动。账户缺失且变动为正时会建户；
   * 任何会把余额打到负值的变动都会被拒绝（抛异常）。
   *
   * @param tx       活动事务。
   * @param userId   owner id。
   * @param currency 币种。
   * @param delta    带符号增量（负数即支出/取款）。
   * @throws BadRequestException 变动后余额为负时。
   */
  private async adjustCash(
    tx: PostgresJsDatabase,
    userId: string,
    currency: string,
    delta: number,
  ): Promise<void> {
    // 零变动直接跳过（1e-9 容差内视为零）。
    if (Math.abs(delta) < 1e-9) return;

    const existing = await tx
      .select()
      .from(cashAccounts)
      .where(and(eq(cashAccounts.owner, userId), eq(cashAccounts.currency, currency)));

    if (existing.length === 0) {
      // 账户尚不存在：负变动无余额可扣，直接拒绝。
      if (delta < 0) {
        // NOTE: 用户可见文案为中文，属既有行为而非乱码。
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
      // 现金非负风险闸门：拒绝透支账户的交易。
      // NOTE: 用户可见文案为中文，属既有行为而非乱码。
      throw new BadRequestException(
        `现金不足：${currency} 余额 ${curBalance.toFixed(2)}，需要 ${Math.abs(delta).toFixed(2)}`,
      );
    }

    // 用 SQL 表达式做原子自增，避免读改写竞态。
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
   * 针对指定 ticker 集合，从其交易历史增量重建派生持仓与已平仓
   * （在 create/update/delete 之后调用，代替全量对账）。
   *
   * @param tx      活动事务。
   * @param userId  owner id。
   * @param tickers 要重建的 ticker 列表。
   */
  private async rebuildTickersFromTransactions(
    tx: PostgresJsDatabase,
    userId: string,
    tickers: string[],
  ): Promise<void> {
    // 过滤空 ticker，全部为空则无事可做。
    const validTickers = tickers.filter((t) => t && t.length > 0);
    if (validTickers.length === 0) return;

    const relevantTx = await tx
      .select()
      .from(transactions)
      .where(and(eq(transactions.owner, userId), inArray(transactions.ticker, validTickers)))
      .orderBy(asc(transactions.txDate), asc(transactions.id));

    const existingHoldings = await tx
      .select()
      .from(holdings)
      .where(and(eq(holdings.owner, userId), inArray(holdings.ticker, validTickers)));

    const holdingByTicker = new Map<string, (typeof existingHoldings)[number]>();
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

      // 从未开过仓的 ticker 不产持仓行；若旧持仓还在则删掉。
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

      // 逐笔回放：买入累加成本与股数，卖出按均价法生成已平仓行。
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

          // 该笔卖出的已实现盈亏按平均成本法核算。
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
            // 仓位清零：重置游标。
            cursor.shares = 0;
            cursor.costBasis = 0;
            cursor.buyDate = null;
          }
        }
      }

      // 回放结束：剩余仓位写入更新表，清仓则列入待删除。
      if (cursor.shares > 0) {
        const avgBuyPrice = cursor.costBasis / cursor.shares;
        updateHoldingMap.set(ticker, {
          shares: String(cursor.shares),
          buyPrice: String(avgBuyPrice),
          buyDate: cursor.buyDate,
        });
      } else {
        // 仓位已清空：把持仓列入待删除。
        deleteHoldingTickers.push(ticker);
      }
    }

    // 落库阶段：既有持仓行更新，缺失则新建（带市场信息推断）。
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
        .where(and(eq(holdings.owner, userId), inArray(holdings.ticker, deleteHoldingTickers)));
    }

    // 这些 ticker 的已平仓记录从零重建。
    await tx
      .delete(closed)
      .where(and(eq(closed.owner, userId), inArray(closed.ticker, validTickers)));

    if (closedRows.length > 0) {
      await tx.insert(closed).values(closedRows);
    }
  }

  /**
   * 把交易原始行映射为 API 契约的 Transaction 形状，币种缺省 USD、手续费缺省 '0'。
   *
   * @param row transactions 表原始行。
   * @returns 供前端使用的 Transaction 对象。
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
