/**
 * Cash accounts controller.
 *
 * Exposes endpoints for the user's multi-currency cash balances under `/api/cash`.
 * Requires login (`@NeedLogin()`). Supports listing balances and manual
 * deposit/withdrawal operations per currency; withdrawals are rejected if they
 * would drive the balance below zero.
 */
import {
  Controller,
  Get,
  Post,
  Body,
  Req,
  BadRequestException,
} from '@nestjs/common';
import { NeedLogin } from '../../common/platform';
import type { Request } from 'express';

import { CashAccountsService, type ConfirmCashInput } from './cash-accounts.service';
import type { CashAccount, ListResponse } from '@shared/api.interface';

/**
 * REST controller for cash accounts. Delegates to `CashAccountsService`.
 */
@Controller('api/cash')
@NeedLogin()
export class CashAccountsController {
  constructor(private readonly cashAccountsService: CashAccountsService) {}
  @Post('confirm')
  confirm(@Req() req: Request, @Body() body: ConfirmCashInput) { return this.cashAccountsService.confirm(req.userContext.userId, body); }

  /**
   * Lists all cash accounts for the current user (one per supported currency).
   *
   * @param req Authenticated request carrying `req.userContext.userId`.
   */
  @Get()
  async findAll(@Req() req: Request): Promise<ListResponse<CashAccount>> {
    const { userId } = req.userContext;
    const items = await this.cashAccountsService.list(userId);
    return { items };
  }

  /**
   * Deposits an amount into a currency cash account.
   *
   * @param body `{ currency, amount, notes? }`.
   * @param req  Authenticated request.
   * @throws BadRequestException if currency/amount are invalid.
   */
  @Post('deposit')
  async deposit(
    @Body() body: { currency: string; amount: number; notes?: string },
    @Req() req: Request,
  ): Promise<CashAccount> {
    const { userId } = req.userContext;
    // NOTE: Chinese user-facing messages (existing behavior; not mojibake).
    if (!body.currency) throw new BadRequestException('currency 不能为空');
    if (!body.amount || body.amount <= 0) throw new BadRequestException('amount 必须大于 0');
    return this.cashAccountsService.adjust(userId, body.currency, body.amount, body.notes);
  }

  /**
   * Withdraws an amount from a currency cash account (rejected if insufficient).
   *
   * @param body `{ currency, amount, notes? }`.
   * @param req  Authenticated request.
   * @throws BadRequestException if currency/amount are invalid or balance is insufficient.
   */
  @Post('withdraw')
  async withdraw(
    @Body() body: { currency: string; amount: number; notes?: string },
    @Req() req: Request,
  ): Promise<CashAccount> {
    const { userId } = req.userContext;
    // NOTE: Chinese user-facing messages (existing behavior; not mojibake).
    if (!body.currency) throw new BadRequestException('currency 不能为空');
    if (!body.amount || body.amount <= 0) throw new BadRequestException('amount 必须大于 0');
    return this.cashAccountsService.adjust(userId, body.currency, -body.amount, body.notes);
  }
}
