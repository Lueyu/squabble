/**
 * closed.controller.ts — 已平仓控制器。
 *
 * 职责边界：
 *  - 只做 HTTP 路由分发与委托，不直接访问数据库；业务规则都在 ClosedService。
 * 上下游：
 *  - 上游（谁路由到这里）：前端 `/api/portfolio/closed/*` 请求，经 NeedLogin 鉴权守卫后进入本控制器。
 *  - 下游（本文件调用谁）：ClosedService.list / create / update / remove / getRealizedSummary。
 * 关键约定：
 *  - 整个控制器挂 @NeedLogin()，所有路由都要求登录。
 *  - 盈亏/价格/股数字段在 API 层均为字符串数值（由服务层负责转换）。
 */
import { Controller, Get, Post, Patch, Delete, Body, Param, Req } from '@nestjs/common';
import { NeedLogin } from '../../common/platform';
import type { Request } from 'express';
import { ClosedService } from './closed.service';
import type { ClosedPosition, CreateClosedDto, RealizedPlSummary } from '@shared/api.interface';

/**
 * 已平仓 REST 控制器，挂在 `/api/portfolio/closed` 路径下，全部委托给 `ClosedService`。
 */
@NeedLogin()
@Controller('api/portfolio/closed')
export class ClosedController {
  constructor(private readonly closedService: ClosedService) {}

  /**
   * GET /api/portfolio/closed/summary — 返回已实现盈亏汇总（按币种合计 + 逐标的明细）。
   *
   * 鉴权：需要登录。
   *
   * @param req 已通过鉴权的请求，携带 `req.userContext.userId`。
   * @returns RealizedPlSummary 汇总对象。
   */
  @Get('summary')
  async getSummary(@Req() req: Request): Promise<RealizedPlSummary> {
    const { userId } = req.userContext;
    return this.closedService.getRealizedSummary(userId);
  }

  /**
   * GET /api/portfolio/closed — 列出当前用户全部已平仓记录，按平仓日期倒序。
   *
   * 鉴权：需要登录。
   *
   * @param req 已通过鉴权的请求。
   * @returns `{ items: ClosedPosition[] }`。
   */
  @Get()
  async list(@Req() req: Request): Promise<{ items: ClosedPosition[] }> {
    const { userId } = req.userContext;
    const items = await this.closedService.list(userId);
    return { items };
  }

  /**
   * POST /api/portfolio/closed — 手工新建一条已平仓记录。
   *
   * 鉴权：需要登录。
   *
   * @param req  已通过鉴权的请求。
   * @param dto  新建载荷（CreateClosedDto）。
   * @returns 新建后的 ClosedPosition。
   */
  @Post()
  async create(@Req() req: Request, @Body() dto: CreateClosedDto): Promise<ClosedPosition> {
    const { userId } = req.userContext;
    return this.closedService.create(userId, dto);
  }

  /**
   * PATCH /api/portfolio/closed/:id — 部分更新一条属于当前用户的已平仓记录。
   *
   * 鉴权：需要登录（服务层会做 owner 过滤）。
   *
   * @param req  已通过鉴权的请求。
   * @param id   已平仓记录主键。
   * @param dto  部分更新载荷。
   * @returns 更新后的 ClosedPosition。
   */
  @Patch(':id')
  async update(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: Partial<CreateClosedDto>,
  ): Promise<ClosedPosition> {
    const { userId } = req.userContext;
    return this.closedService.update(userId, id, dto);
  }

  /**
   * DELETE /api/portfolio/closed/:id — 删除一条属于当前用户的已平仓记录。
   *
   * 鉴权：需要登录（服务层会做 owner 过滤）。
   *
   * @param req 已通过鉴权的请求。
   * @param id  已平仓记录主键。
   */
  @Delete(':id')
  async remove(@Req() req: Request, @Param('id') id: string): Promise<void> {
    const { userId } = req.userContext;
    return this.closedService.remove(userId, id);
  }
}
