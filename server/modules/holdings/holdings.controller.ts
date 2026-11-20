/**
 * holdings.controller.ts — 持仓（Holdings）REST 控制器，挂载于 /api/portfolio/holdings。
 *
 * 职责边界：
 *  - 只暴露持仓 CRUD 与批量价格更新端点：列表/单条/新建/批量价格/部分更新/删除。
 *  - 业务逻辑与 SQL 全部在 HoldingsService 中，控制器不直接访问数据库。
 * 上下游：
 *  - 上游：客户端持仓管理页调用；所有数据访问自动限定为当前登录用户的数据。
 *  - 下游：调用 HoldingsService（findAll/findOne/create/updatePrices/update/remove）。
 * 关键约定：
 *  - 每条路由都要求登录（@NeedLogin()），归属 userId 取自 req.userContext。
 *  - 'prices' 路由声明在 ':id' 之前，确保静态路径先于参数路径匹配。
 *  - 新建持仓时市场/币种元数据由服务端根据 ticker 自动推导。
 */
import { Controller, Get, Post, Patch, Delete, Param, Body, Req } from '@nestjs/common';
import { NeedLogin } from '../../common/platform';
import type { Request } from 'express';

import { HoldingsService } from './holdings.service';
import type {
  Holding,
  CreateHoldingDto,
  UpdateHoldingDto,
  ListResponse,
  BatchPriceUpdateDto,
} from '@shared/api.interface';

/**
 * 管理持仓的 REST 控制器，全部工作委托给 HoldingsService。
 */
@Controller('api/portfolio/holdings')
@NeedLogin()
export class HoldingsController {
  constructor(private readonly holdingsService: HoldingsService) {}

  /**
   * 列出当前用户的全部持仓，按最近更新时间倒序。
   *
   * 方法+路径：GET /api/portfolio/holdings（需登录）。
   *
   * @param req 已认证请求，携带 `req.userContext.userId`
   */
  @Get()
  async findAll(@Req() req: Request): Promise<ListResponse<Holding>> {
    const { userId } = req.userContext;
    return this.holdingsService.findAll(userId);
  }

  /**
   * 按 id 获取单条持仓；仅当该持仓属于调用者时才返回。
   *
   * 方法+路径：GET /api/portfolio/holdings/:id（需登录）。
   *
   * @param id  持仓主键
   * @param req 已认证请求
   */
  @Get(':id')
  async findOne(@Param('id') id: string, @Req() req: Request): Promise<Holding> {
    const { userId } = req.userContext;
    return this.holdingsService.findOne(id, userId);
  }

  /**
   * 为当前用户新建持仓。市场/币种元数据由服务端根据 ticker 自动推导。
   *
   * 方法+路径：POST /api/portfolio/holdings（需登录）。
   *
   * @param dto 创建载荷
   * @param req 已认证请求
   */
  @Post()
  async create(@Body() dto: CreateHoldingDto, @Req() req: Request): Promise<Holding> {
    const { userId } = req.userContext;
    return this.holdingsService.create(dto, userId);
  }

  /**
   * 一次性批量更新多条持仓的最新市价。
   * 注意：'prices' 路由声明在 ':id' 之前，因此会先被匹配。
   *
   * 方法+路径：PATCH /api/portfolio/holdings/prices（需登录）。
   *
   * @param body `{ items }` 形式的 ticker/价格更新列表
   * @param req  已认证请求
   */
  @Patch('prices')
  async updatePrices(
    @Body() body: { items: BatchPriceUpdateDto[] },
    @Req() req: Request,
  ): Promise<{ success: true }> {
    const { userId } = req.userContext;
    return this.holdingsService.updatePrices(body.items, userId);
  }

  /**
   * 部分更新一条归属于调用者的已有持仓。
   *
   * 方法+路径：PATCH /api/portfolio/holdings/:id（需登录）。
   *
   * @param id  持仓主键
   * @param dto 部分更新载荷
   * @param req 已认证请求
   */
  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateHoldingDto,
    @Req() req: Request,
  ): Promise<Holding> {
    const { userId } = req.userContext;
    return this.holdingsService.update(id, dto, userId);
  }

  /**
   * 删除一条归属于调用者的持仓。
   *
   * 方法+路径：DELETE /api/portfolio/holdings/:id（需登录）。
   *
   * @param id  持仓主键
   * @param req 已认证请求
   */
  @Delete(':id')
  async remove(@Param('id') id: string, @Req() req: Request): Promise<{ success: true }> {
    const { userId } = req.userContext;
    return this.holdingsService.remove(id, userId);
  }
}
