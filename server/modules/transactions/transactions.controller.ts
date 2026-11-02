/**
 * Transactions controller.
 *
 * Exposes endpoints for the user's stock transactions (Buy/Sell/Deposit/Withdrawal/
 * Opening) under `/api/portfolio/transactions`. Requires login on every route
 * (`@NeedLogin()` at the class level). Transactions are the source of truth;
 * holdings, closed positions, and cash balances are derived server-side in
 * `TransactionsService`.
 */
import { Controller, Get, Post, Patch, Delete, Body, Param, Query, Req } from '@nestjs/common';
import { NeedLogin } from '../../common/platform';
import type { Request } from 'express';
import { TransactionsService } from './transactions.service';
import type { Transaction, CreateTransactionDto, ReconcileResult } from '@shared/api.interface';

/**
 * REST controller for transactions. Delegates all bookkeeping to
 * `TransactionsService`.
 */
@NeedLogin()
@Controller('api/portfolio/transactions')
export class TransactionsController {
  constructor(private readonly transactionsService: TransactionsService) {}

  /**
   * Lists transactions for the current user, newest first, optionally by ticker.
   *
   * @param req    Authenticated request carrying `req.userContext.userId`.
   * @param ticker  Optional ticker filter.
   * @param limit   Optional row limit (clamped to 500; default 100).
   */
  @Get()
  async list(
    @Req() req: Request,
    @Query('ticker') ticker?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ): Promise<{ items: Transaction[] }> {
    const { userId } = req.userContext;
    const limitNum = limit ? Math.min(parseInt(limit, 10), 500) : 100;
    const offsetNum = Math.max(0, Number.parseInt(offset ?? '0', 10) || 0);
    const items = await this.transactionsService.list(userId, ticker, limitNum, offsetNum);
    return { items };
  }

  /**
   * Fetches a single transaction by id, only if owned by the caller.
   *
   * @param req Authenticated request.
   * @param id  Transaction primary key.
   */
  @Get(':id')
  async getById(@Req() req: Request, @Param('id') id: string): Promise<Transaction> {
    const { userId } = req.userContext;
    return this.transactionsService.getById(userId, id);
  }

  /**
   * Creates a transaction of any valid type.
   *
   * @param req Authenticated request.
   * @param dto Create payload.
   */
  @Post()
  async create(@Req() req: Request, @Body() dto: CreateTransactionDto): Promise<Transaction> {
    const { userId } = req.userContext;
    return this.transactionsService.create(userId, dto);
  }

  /**
   * Partially updates a transaction, adjusting derived cash/holdings accordingly.
   *
   * @param req Authenticated request.
   * @param id  Transaction primary key.
   * @param dto Partial update payload.
   */
  @Patch(':id')
  async update(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: Partial<CreateTransactionDto>,
  ): Promise<Transaction> {
    const { userId } = req.userContext;
    return this.transactionsService.update(userId, id, dto);
  }

  /**
   * Deletes a transaction and reverses its derived effects (cash/holdings).
   *
   * @param req Authenticated request.
   * @param id  Transaction primary key.
   */
  @Delete(':id')
  async remove(@Req() req: Request, @Param('id') id: string): Promise<void> {
    const { userId } = req.userContext;
    return this.transactionsService.remove(userId, id);
  }

  /**
   * Full reconciliation: rebuild holdings, closed positions, and cash balances
   * from the user's entire transaction history.
   *
   * @param req Authenticated request.
   */
  @Post('reconcile')
  async reconcile(@Req() req: Request): Promise<ReconcileResult> {
    const { userId } = req.userContext;
    return this.transactionsService.reconcileAll(userId);
  }

  /**
   * Creates a Buy transaction, auto-depositing any cash shortfall first.
   *
   * @param req Authenticated request.
   * @param dto Create payload (must be a Buy).
   */
  @Post('auto-deposit-buy')
  async createWithAutoDeposit(
    @Req() req: Request,
    @Body() dto: CreateTransactionDto,
  ): Promise<Transaction> {
    const { userId } = req.userContext;
    return this.transactionsService.createWithAutoDeposit(userId, dto);
  }
}
