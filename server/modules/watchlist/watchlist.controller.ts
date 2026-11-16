/**
 * watchlist.controller.ts — 自选列表（Watchlist）REST 控制器，挂载于 /api/portfolio/watchlist。
 *
 * 职责边界：
 *  - 只暴露自选（关注但尚未持有的股票）的 CRUD 端点：列表/单条/新增/批量价格/部分更新/删除。
 *  - 业务逻辑全部在 WatchlistService 中，控制器不直接访问数据库。
 * 上下游：
 *  - 上游：客户端自选页调用；所有访问自动限定为当前登录用户的数据。
 *  - 下游：调用 WatchlistService（findAll/findOne/create/updatePrices/update/remove）。
 * 关键约定：
 *  - 每条路由都要求登录（@NeedLogin()），归属 userId 取自 req.userContext。
 *  - 'prices' 路由声明在 ':id' 之前，确保静态路径 'prices' 先于参数路径匹配。
 *  - 新增自选时市场/币种元数据由服务端根据 ticker 自动推导。
 */
import { Controller, Get, Post, Patch, Delete, Param, Body, Req } from '@nestjs/common';
import { NeedLogin } from '../../common/platform';
import type { Request } from 'express';

import { WatchlistService } from './watchlist.service';
import type {
  WatchItem,
  CreateWatchItemDto,
  UpdateWatchItemDto,
  ListResponse,
  BatchPriceUpdateDto,
} from '@shared/api.interface';

/**
 * 管理自选列表的 REST 控制器，业务逻辑委托给 WatchlistService。
 */
@Controller('api/portfolio/watchlist')
@NeedLogin()
export class WatchlistController {
  constructor(private readonly watchlistService: WatchlistService) {}

  /**
   * 列出当前用户的全部自选项，按最近更新时间倒序。
   *
   * 方法+路径：GET /api/portfolio/watchlist（需登录）。
   *
   * @param req 已认证请求，携带 `req.userContext.userId`
   */
  @Get()
  async findAll(@Req() req: Request): Promise<ListResponse<WatchItem>> {
    const { userId } = req.userContext;
    return this.watchlistService.findAll(userId);
  }

  /**
   * 按 id 获取单条自选项；仅当它属于调用者时才返回。
   *
   * 方法+路径：GET /api/portfolio/watchlist/:id（需登录）。
   *
   * @param id  自选项主键
   * @param req 已认证请求
   */
  @Get(':id')
  async findOne(@Param('id') id: string, @Req() req: Request): Promise<WatchItem> {
    const { userId } = req.userContext;
    return this.watchlistService.findOne(id, userId);
  }

  /**
   * 为当前用户新增一条自选项。市场/币种元数据由服务端根据 ticker 推导。
   *
   * 方法+路径：POST /api/portfolio/watchlist（需登录）。
   *
   * @param dto 创建载荷
   * @param req 已认证请求
   */
  @Post()
  async create(@Body() dto: CreateWatchItemDto, @Req() req: Request): Promise<WatchItem> {
    const { userId } = req.userContext;
    return this.watchlistService.create(dto, userId);
  }

  /**
   * 批量更新多条自选项的最新价格。声明在 ':id' 之前，
   * 确保静态路由 'prices' 优先匹配。
   *
   * 方法+路径：PATCH /api/portfolio/watchlist/prices（需登录）。
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
    return this.watchlistService.updatePrices(body.items, userId);
  }

  /**
   * 部分更新一条归属于当前用户的自选项。
   *
   * 方法+路径：PATCH /api/portfolio/watchlist/:id（需登录）。
   *
   * @param id  自选项主键
   * @param dto 部分更新载荷
   * @param req 已认证请求
   */
  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateWatchItemDto,
    @Req() req: Request,
  ): Promise<WatchItem> {
    const { userId } = req.userContext;
    return this.watchlistService.update(id, dto, userId);
  }

  /**
   * 删除一条归属于调用者的自选项。
   *
   * 方法+路径：DELETE /api/portfolio/watchlist/:id（需登录）。
   *
   * @param id  自选项主键
   * @param req 已认证请求
   */
  @Delete(':id')
  async remove(@Param('id') id: string, @Req() req: Request): Promise<{ success: true }> {
    const { userId } = req.userContext;
    return this.watchlistService.remove(id, userId);
  }
}
