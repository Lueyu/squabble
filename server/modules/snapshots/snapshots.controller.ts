/**
 * snapshots.controller.ts — 每日组合快照（Snapshots）REST 控制器，挂载于 /api/portfolio/snapshots。
 *
 * 职责边界：
 *  - 只暴露快照端点：列表/最新一条/单日 upsert/批量 upsert/删除。
 *  - 快照字段（账户总值、市值、成本、现金、盈亏、净入金）的落库与重算
 *    全部委托给 SnapshotsService。
 * 上下游：
 *  - 上游：客户端快照页调用；所有路由均要求登录。
 *  - 下游：调用 SnapshotsService（list/latest/upsert/batchUpsert/remove）。
 * 关键约定：
 *  - list 的 limit 省略时默认 90，服务端钳制上限 365（Math.min(limit, 365)）。
 *  - upsert 以 snapshotDate 为唯一键，同一日期重复提交为覆盖更新，
 *    并同步重算净/累计入金与每日盈亏。
 */
import { Controller, Get, Post, Delete, Body, Param, Query, Req } from '@nestjs/common';
import { NeedLogin } from '../../common/platform';
import type { Request } from 'express';
import { SnapshotsService } from './snapshots.service';
import type { Snapshot, CreateSnapshotDto, ListResponse } from '@shared/api.interface';

/**
 * 每日组合快照的 REST 控制器，业务逻辑委托给 SnapshotsService。
 */
@NeedLogin()
@Controller('api/portfolio/snapshots')
export class SnapshotsController {
  constructor(private readonly snapshotsService: SnapshotsService) {}

  /**
   * 按时间倒序列出用户的快照（默认 90 条，服务端钳制上限 365 条）。
   *
   * 方法+路径：GET /api/portfolio/snapshots?limit=（需登录）。
   *
   * @param req   已认证请求，携带 `req.userContext.userId`
   * @param limit 可选的最大行数
   */
  @Get()
  async list(@Req() req: Request, @Query('limit') limit?: string): Promise<ListResponse<Snapshot>> {
    const { userId } = req.userContext;
    const limitNum = limit ? parseInt(limit, 10) : 90;
    return this.snapshotsService.list(userId, limitNum);
  }

  /**
   * 返回最近一条快照；不存在时返回 null。
   *
   * 方法+路径：GET /api/portfolio/snapshots/latest（需登录）。
   *
   * @param req 已认证请求
   */
  @Get('latest')
  async latest(@Req() req: Request): Promise<Snapshot | null> {
    const { userId } = req.userContext;
    return this.snapshotsService.latest(userId);
  }

  /**
   * 按 snapshotDate 创建或覆盖（upsert）指定日期的快照，
   * 同时重算净/累计入金与每日盈亏。
   *
   * 方法+路径：POST /api/portfolio/snapshots（需登录）。
   *
   * @param req 已认证请求
   * @param dto 以 `snapshotDate` 为键的快照载荷
   */
  @Post()
  async upsert(@Req() req: Request, @Body() dto: CreateSnapshotDto): Promise<Snapshot> {
    const { userId } = req.userContext;
    return this.snapshotsService.upsert(userId, dto);
  }

  /**
   * 一次性 upsert 多条快照（按时间顺序处理，保证累计值正确衔接），
   * 返回结果按时间倒序。
   *
   * 方法+路径：POST /api/portfolio/snapshots/batch（需登录）。
   *
   * @param req   已认证请求
   * @param items 快照载荷数组
   */
  @Post('batch')
  async batchUpsert(
    @Req() req: Request,
    @Body() items: CreateSnapshotDto[],
  ): Promise<ListResponse<Snapshot>> {
    const { userId } = req.userContext;
    return this.snapshotsService.batchUpsert(userId, items);
  }

  /**
   * 删除一条归属于当前用户的快照。
   *
   * 方法+路径：DELETE /api/portfolio/snapshots/:id（需登录）。
   *
   * @param req 已认证请求
   * @param id  快照主键
   */
  @Delete(':id')
  async remove(@Req() req: Request, @Param('id') id: string): Promise<{ success: boolean }> {
    const { userId } = req.userContext;
    return this.snapshotsService.remove(userId, id);
  }
}
