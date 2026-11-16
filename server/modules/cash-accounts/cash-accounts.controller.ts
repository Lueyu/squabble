/**
 * cash-accounts.controller.ts — 现金账户控制器。
 *
 * 职责边界：
 *  - 只做 HTTP 入参校验与委托，不直接访问数据库；业务规则都在 CashAccountsService。
 * 上下游：
 *  - 上游（谁路由到这里）：前端 `/api/cash/*` 请求，经 NeedLogin 鉴权守卫后进入本控制器。
 *  - 下游（本文件调用谁）：CashAccountsService.list / adjust。
 * 关键约定：
 *  - 整个控制器挂 @NeedLogin()，所有路由都要求登录。
 *  - 入参 amount 为 number；余额在服务层以字符串数值（numeric）存储与返回。
 *  - 用户可见报错文案是中文，属既有行为而非乱码，不可改写。
 */
import { Controller, Get, Post, Body, Req, BadRequestException } from '@nestjs/common';
import { NeedLogin } from '../../common/platform';
import type { Request } from 'express';

import { CashAccountsService } from './cash-accounts.service';
import type { CashAccount, ListResponse } from '@shared/api.interface';

/**
 * 现金账户 REST 控制器，挂在 `/api/cash` 路径下，全部委托给 `CashAccountsService`。
 */
@Controller('api/cash')
@NeedLogin()
export class CashAccountsController {
  constructor(private readonly cashAccountsService: CashAccountsService) {}

  /**
   * GET /api/cash — 列出当前用户在全部受支持币种下的现金账户（每币种一条）。
   *
   * 鉴权：需要登录。
   *
   * @param req 已通过鉴权的请求，携带 `req.userContext.userId`。
   * @returns ListResponse 包装的 CashAccount 数组。
   */
  @Get()
  async findAll(@Req() req: Request): Promise<ListResponse<CashAccount>> {
    // 取出当前登录用户 id，用于按 owner 过滤账户。
    const { userId } = req.userContext;
    const items = await this.cashAccountsService.list(userId);
    return { items };
  }

  /**
   * POST /api/cash/deposit — 向指定币种账户存入一笔金额。
   *
   * 鉴权：需要登录。
   *
   * @param body `{ currency, amount, notes? }`，amount 为正数（number）。
   * @param req  已通过鉴权的请求。
   * @returns 存入后的最新账户快照。
   * @throws BadRequestException 当 currency/amount 非法时。
   */
  @Post('deposit')
  async deposit(
    @Body() body: { currency: string; amount: number; notes?: string },
    @Req() req: Request,
  ): Promise<CashAccount> {
    const { userId } = req.userContext;
    // NOTE: 用户可见文案为中文，属既有行为而非乱码。
    if (!body.currency) throw new BadRequestException('currency 不能为空');
    if (!body.amount || body.amount <= 0) throw new BadRequestException('amount 必须大于 0');
    return this.cashAccountsService.adjust(userId, body.currency, body.amount, body.notes);
  }

  /**
   * POST /api/cash/withdraw — 从指定币种账户取出一笔金额（余额不足时拒绝）。
   *
   * 鉴权：需要登录。
   *
   * @param body `{ currency, amount, notes? }`，amount 为正数（number）。
   * @param req  已通过鉴权的请求。
   * @returns 取出后的最新账户快照。
   * @throws BadRequestException 当 currency/amount 非法或余额不足时。
   */
  @Post('withdraw')
  async withdraw(
    @Body() body: { currency: string; amount: number; notes?: string },
    @Req() req: Request,
  ): Promise<CashAccount> {
    const { userId } = req.userContext;
    // NOTE: 用户可见文案为中文，属既有行为而非乱码。
    if (!body.currency) throw new BadRequestException('currency 不能为空');
    if (!body.amount || body.amount <= 0) throw new BadRequestException('amount 必须大于 0');
    // 取款复用同一 adjust 通道：以负数增量表达方向。
    return this.cashAccountsService.adjust(userId, body.currency, -body.amount, body.notes);
  }
}
