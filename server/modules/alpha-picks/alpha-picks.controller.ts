/**
 * Alpha-picks controller（精选推荐控制器）。
 *
 * 职责边界：暴露用户自维护的 alpha picks（带收益率 returnPct、评级
 * rating、权重 weightPct 的跟踪型股票推荐）的 CRUD REST 端点，路由前缀
 * `/api/portfolio/alpha-picks`；只做参数透传与登录态取 userId，不含业务
 * 规则（全部下沉到 AlphaPicksService）。
 *
 * 上下游：import @nestjs/common、NeedLogin（common/platform，控制器级
 * 全量鉴权）、AlphaPicksService 与 UpdateAlphaPickDto（本模块 service）、
 * @shared/api.interface 的 DTO/响应类型；由 alpha-picks.module.ts 注册，
 * 被 app.module.ts 装配。
 *
 * 关键约定：类级 @NeedLogin() 使每个路由都要求登录；owner 归属由
 * req.userContext.userId 提供并传给 service 做行级隔离。
 */
import { Controller, Get, Post, Patch, Delete, Param, Body, Req } from '@nestjs/common';
import { NeedLogin } from '../../common/platform';
import type { Request } from 'express';

import { AlphaPicksService, type UpdateAlphaPickDto } from './alpha-picks.service';
import type { AlphaPick, CreateAlphaPickDto, ListResponse } from '@shared/api.interface';

/**
 * Alpha picks 的 REST 控制器，全部委托给 `AlphaPicksService`。
 */
@Controller('api/portfolio/alpha-picks')
@NeedLogin()
export class AlphaPicksController {
  constructor(private readonly alphaPicksService: AlphaPicksService) {}

  /**
   * 列出当前用户的全部 alpha picks，按选入日期倒序（最新在前）。
   *
   * @param req 已鉴权请求，携带 `req.userContext.userId`。
   */
  @Get()
  async findAll(@Req() req: Request): Promise<ListResponse<AlphaPick>> {
    const { userId } = req.userContext;
    return this.alphaPicksService.findAll(userId);
  }

  /**
   * 新建一条 alpha pick。
   *
   * @param dto 推荐载荷。
   * @param req 已鉴权请求。
   */
  @Post()
  async create(@Body() dto: CreateAlphaPickDto, @Req() req: Request): Promise<AlphaPick> {
    const { userId } = req.userContext;
    return this.alphaPicksService.create(dto, userId);
  }

  /**
   * 更新一条属于当前用户的 alpha pick。
   *
   * @param id  推荐主键。
   * @param dto 部分更新载荷。
   * @param req 已鉴权请求。
   */
  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateAlphaPickDto,
    @Req() req: Request,
  ): Promise<AlphaPick> {
    const { userId } = req.userContext;
    return this.alphaPicksService.update(id, dto, userId);
  }

  /**
   * 删除一条属于当前用户的 alpha pick。
   *
   * @param id  推荐主键。
   * @param req 已鉴权请求。
   */
  @Delete(':id')
  async remove(@Param('id') id: string, @Req() req: Request): Promise<{ success: true }> {
    const { userId } = req.userContext;
    return this.alphaPicksService.remove(id, userId);
  }
}
