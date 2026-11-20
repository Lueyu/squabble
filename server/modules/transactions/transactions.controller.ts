/**
 * transactions.controller.ts — 交易记录控制器。
 *
 * 职责边界：
 *  - 只做 HTTP 路由分发、分页参数解析与委托，不直接访问数据库；记账规则都在 TransactionsService。
 * 上下游：
 *  - 上游（谁路由到这里）：前端 `/api/portfolio/transactions/*` 请求，经 NeedLogin 鉴权守卫后进入本控制器。
 *  - 下游（本文件调用谁）：TransactionsService.list / getById / create / update / remove /
 *    reconcileAll / createWithAutoDeposit。
 * 关键约定：
 *  - 整个控制器挂 @NeedLogin()，所有路由都要求登录。
 *  - 交易记录是事实来源；持仓、已平仓、现金余额均由服务端派生维护。
 */
import { Controller, Get, Post, Patch, Delete, Body, Param, Query, Req } from '@nestjs/common';
import { NeedLogin } from '../../common/platform';
import type { Request } from 'express';
import { TransactionsService } from './transactions.service';
import type { Transaction, CreateTransactionDto, ReconcileResult } from '@shared/api.interface';

/**
 * 交易记录 REST 控制器，挂在 `/api/portfolio/transactions` 路径下，全部记账逻辑委托给
 * `TransactionsService`。
 */
@NeedLogin()
@Controller('api/portfolio/transactions')
export class TransactionsController {
  constructor(private readonly transactionsService: TransactionsService) {}

  /**
   * GET /api/portfolio/transactions — 列出当前用户的交易记录（最新在前），可按 ticker 过滤。
   *
   * 鉴权：需要登录。
   *
   * @param req    已通过鉴权的请求，携带 `req.userContext.userId`。
   * @param ticker 可选 ticker 过滤条件。
   * @param limit  可选行数上限（钳制到 500，默认 100）。
   * @param offset 可选分页偏移。
   * @returns `{ items: Transaction[] }`。
   */
  @Get()
  async list(
    @Req() req: Request,
    @Query('ticker') ticker?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ): Promise<{ items: Transaction[] }> {
    const { userId } = req.userContext;
    // 解析分页参数：limit 上限 500，offset 非负，非法值回退默认。
    const limitNum = limit ? Math.min(parseInt(limit, 10), 500) : 100;
    const offsetNum = Math.max(0, Number.parseInt(offset ?? '0', 10) || 0);
    const items = await this.transactionsService.list(userId, ticker, limitNum, offsetNum);
    return { items };
  }

  /**
   * GET /api/portfolio/transactions/:id — 按 id 获取单条交易记录（仅限属于调用者的记录）。
   *
   * 鉴权：需要登录（服务层做 owner 过滤）。
   *
   * @param req 已通过鉴权的请求。
   * @param id  交易记录主键。
   * @returns Transaction。
   */
  @Get(':id')
  async getById(@Req() req: Request, @Param('id') id: string): Promise<Transaction> {
    const { userId } = req.userContext;
    return this.transactionsService.getById(userId, id);
  }

  /**
   * POST /api/portfolio/transactions — 新建任意合法类型的交易（买入/卖出/存入/取款/建仓）。
   *
   * 鉴权：需要登录。
   *
   * @param req  已通过鉴权的请求。
   * @param dto  新建载荷（CreateTransactionDto）。
   * @returns 新建后的 Transaction。
   */
  @Post()
  async create(@Req() req: Request, @Body() dto: CreateTransactionDto): Promise<Transaction> {
    const { userId } = req.userContext;
    return this.transactionsService.create(userId, dto);
  }

  /**
   * PATCH /api/portfolio/transactions/:id — 部分更新交易记录，并同步调整派生的现金/持仓。
   *
   * 鉴权：需要登录（服务层做 owner 过滤）。
   *
   * @param req  已通过鉴权的请求。
   * @param id   交易记录主键。
   * @param dto  部分更新载荷。
   * @returns 更新后的 Transaction。
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
   * DELETE /api/portfolio/transactions/:id — 删除交易记录并回冲其派生影响（现金/持仓）。
   *
   * 鉴权：需要登录（服务层做 owner 过滤）。
   *
   * @param req 已通过鉴权的请求。
   * @param id  交易记录主键。
   */
  @Delete(':id')
  async remove(@Req() req: Request, @Param('id') id: string): Promise<void> {
    const { userId } = req.userContext;
    return this.transactionsService.remove(userId, id);
  }

  /**
   * POST /api/portfolio/transactions/reconcile — 全量对账：从用户全部交易历史重建
   * 持仓、已平仓记录与现金余额。
   *
   * 鉴权：需要登录。
   *
   * @param req 已通过鉴权的请求。
   * @returns ReconcileResult 对账结果。
   */
  @Post('reconcile')
  async reconcile(@Req() req: Request): Promise<ReconcileResult> {
    const { userId } = req.userContext;
    return this.transactionsService.reconcileAll(userId);
  }

  /**
   * POST /api/portfolio/transactions/auto-deposit-buy — 创建买入交易，现金不足时先自动存入差额。
   *
   * 鉴权：需要登录。
   *
   * @param req  已通过鉴权的请求。
   * @param dto  新建载荷（必须是买入类型）。
   * @returns 新建后的 Transaction。
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
