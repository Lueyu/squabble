/**
 * Analysis controller（个股研究笔记控制器）。
 *
 * 职责边界：暴露按（日期, ticker）维度的股票研究笔记（评级 rating、动作
 * action、论点 thesis、目标价 target price、催化剂 catalysts、风险 risks）
 * 的 REST 端点，路由前缀 `/api/portfolio/analysis`；只做参数透传与登录态
 * 取 userId，业务规则全部下沉到 AnalysisService。
 *
 * 上下游：import @nestjs/common、NeedLogin（common/platform，类级全量
 * 鉴权）、AnalysisService（本模块 service）、@shared/api.interface 类型；
 * 由 analysis.module.ts 注册，被 app.module.ts 装配。
 *
 * 关键约定：GET /dates 列出有笔记的 distinct 日期；POST 与 POST /batch
 * 均为 upsert 语义（同 owner+date+ticker 已存在则更新）；DELETE /:id 按
 * 行主键删除。
 */
import { Controller, Get, Post, Delete, Body, Param, Query, Req } from '@nestjs/common';
import { NeedLogin } from '../../common/platform';
import type { Request } from 'express';
import { AnalysisService } from './analysis.service';
import type { Analysis, CreateAnalysisDto, ListResponse } from '@shared/api.interface';

/**
 * 股票研究笔记的 REST 控制器，全部委托给 `AnalysisService`。
 */
@NeedLogin()
@Controller('api/portfolio/analysis')
export class AnalysisController {
  constructor(private readonly analysisService: AnalysisService) {}

  /**
   * 列出研究笔记，按日期倒序 / ticker 正序，可按日期和/或 ticker 过滤。
   *
   * @param req    已鉴权请求，携带 `req.userContext.userId`。
   * @param date   可选的研究日期过滤。
   * @param ticker 可选的 ticker 过滤。
   */
  @Get()
  async list(
    @Req() req: Request,
    @Query('date') date?: string,
    @Query('ticker') ticker?: string,
  ): Promise<ListResponse<Analysis>> {
    const { userId } = req.userContext;
    return this.analysisService.list(userId, date, ticker);
  }

  /**
   * 列出存在研究笔记的 distinct 日期。
   *
   * @param req 已鉴权请求。
   */
  @Get('dates')
  async dates(@Req() req: Request): Promise<ListResponse<{ date: string }>> {
    const { userId } = req.userContext;
    return this.analysisService.listDates(userId);
  }

  /**
   * 新建或更新（upsert）某（日期, ticker）的研究笔记。
   *
   * @param req 已鉴权请求。
   * @param dto 研究笔记载荷。
   */
  @Post()
  async upsert(@Req() req: Request, @Body() dto: CreateAnalysisDto): Promise<Analysis> {
    const { userId } = req.userContext;
    return this.analysisService.upsert(userId, dto);
  }

  /**
   * 一次性 upsert 多条研究笔记。
   *
   * @param req   已鉴权请求。
   * @param items 研究笔记载荷数组。
   */
  @Post('batch')
  async batchUpsert(
    @Req() req: Request,
    @Body() items: CreateAnalysisDto[],
  ): Promise<ListResponse<Analysis>> {
    const { userId } = req.userContext;
    return this.analysisService.batchUpsert(userId, items);
  }

  /**
   * 删除一条属于当前用户的研究笔记。
   *
   * @param req 已鉴权请求。
   * @param id  analysis 行主键。
   */
  @Delete(':id')
  async remove(@Req() req: Request, @Param('id') id: string): Promise<{ success: boolean }> {
    const { userId } = req.userContext;
    return this.analysisService.remove(userId, id);
  }
}
