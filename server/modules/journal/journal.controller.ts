/**
 * Trading journal controller（交易日志控制器）。
 *
 * 职责边界：暴露用户的逐日交易日志笔记（市场综述 marketSummary、组合综述
 * portfolioSummary、操作 actions、计划 plan、经验 lessons）的 REST 端点，
 * 路由前缀 `/api/portfolio/journal`；只做参数透传，业务规则下沉到
 * JournalService。
 *
 * 上下游：import @nestjs/common、NeedLogin（common/platform，类级全量
 * 鉴权）、JournalService（本模块）、@shared/api.interface 类型；由
 * journal.module.ts 注册，被 app.module.ts 装配。
 *
 * 关键约定：GET /latest 返回最近一条或 null；POST 为 upsert 语义（同一
 * journalDate 已存在则更新）；GET 可按 date 过滤（YYYY-MM-DD）。
 */
import { Controller, Get, Post, Delete, Body, Param, Query, Req } from '@nestjs/common';
import { NeedLogin } from '../../common/platform';
import type { Request } from 'express';
import { JournalService } from './journal.service';
import type { JournalEntry, CreateJournalDto, ListResponse } from '@shared/api.interface';

/**
 * 交易日志的 REST 控制器，全部委托给 `JournalService`。
 */
@NeedLogin()
@Controller('api/portfolio/journal')
export class JournalController {
  constructor(private readonly journalService: JournalService) {}

  /**
   * 列出用户的交易日志，最新在前，可按日期过滤。
   *
   * @param req  已鉴权请求，携带 `req.userContext.userId`。
   * @param date 可选的日志日期（YYYY-MM-DD）过滤。
   */
  @Get()
  async list(
    @Req() req: Request,
    @Query('date') date?: string,
  ): Promise<ListResponse<JournalEntry>> {
    const { userId } = req.userContext;
    return this.journalService.list(userId, date);
  }

  /**
   * 返回最近一条日志，无记录时返回 null。
   *
   * @param req 已鉴权请求。
   */
  @Get('latest')
  async latest(@Req() req: Request): Promise<JournalEntry | null> {
    const { userId } = req.userContext;
    return this.journalService.latest(userId);
  }

  /**
   * 新建或更新（upsert）指定日期的日志。
   *
   * @param req 已鉴权请求。
   * @param dto 日志载荷（以 `journalDate` 为键）。
   */
  @Post()
  async upsert(@Req() req: Request, @Body() dto: CreateJournalDto): Promise<JournalEntry> {
    const { userId } = req.userContext;
    return this.journalService.upsert(userId, dto);
  }

  /**
   * 删除一条属于当前用户的日志。
   *
   * @param req 已鉴权请求。
   * @param id  日志主键。
   */
  @Delete(':id')
  async remove(@Req() req: Request, @Param('id') id: string): Promise<{ success: boolean }> {
    const { userId } = req.userContext;
    return this.journalService.remove(userId, id);
  }
}
