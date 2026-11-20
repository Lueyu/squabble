/**
 * groups.controller.ts — 持仓分组（Groups）REST 控制器，挂载于 /api/portfolio/groups。
 *
 * 职责边界：
 *  - 只暴露分组分类（用于组织持仓的标签）的 CRUD 端点：列表/新建/部分更新/删除。
 *  - 归属校验与持久化全部委托给 GroupsService，控制器不直接访问数据库。
 * 上下游：
 *  - 上游：客户端持仓分组管理页调用；受 NeedLogin 保护。
 *  - 下游：调用 GroupsService（findAll/create/update/remove）。
 * 关键约定：
 *  - 所有操作的归属 userId 一律取自 req.userContext，数据自动按登录用户隔离。
 */
import { Controller, Get, Post, Patch, Delete, Param, Body, Req } from '@nestjs/common';
import { NeedLogin } from '../../common/platform';
import type { Request } from 'express';

import { GroupsService } from './groups.service';
import type { Group, CreateGroupDto, UpdateGroupDto, ListResponse } from '@shared/api.interface';

/**
 * 管理持仓分组的 REST 控制器，业务逻辑委托给 GroupsService。
 */
@Controller('api/portfolio/groups')
@NeedLogin()
export class GroupsController {
  constructor(private readonly groupsService: GroupsService) {}

  /**
   * 列出当前用户的全部分组，按用户自定义排序返回。
   *
   * 方法+路径：GET /api/portfolio/groups（需登录）。
   *
   * @param req 已认证请求，携带 `req.userContext.userId`
   */
  @Get()
  async findAll(@Req() req: Request): Promise<ListResponse<Group>> {
    const { userId } = req.userContext;
    return this.groupsService.findAll(userId);
  }

  /**
   * 为当前用户新建一个分组。
   *
   * 方法+路径：POST /api/portfolio/groups（需登录）。
   *
   * @param dto 创建载荷
   * @param req 已认证请求
   */
  @Post()
  async create(@Body() dto: CreateGroupDto, @Req() req: Request): Promise<Group> {
    const { userId } = req.userContext;
    return this.groupsService.create(dto, userId);
  }

  /**
   * 部分更新一个归属于当前用户的分组。
   *
   * 方法+路径：PATCH /api/portfolio/groups/:id（需登录）。
   *
   * @param id  分组主键
   * @param dto 部分更新载荷
   * @param req 已认证请求
   */
  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateGroupDto,
    @Req() req: Request,
  ): Promise<Group> {
    const { userId } = req.userContext;
    return this.groupsService.update(id, dto, userId);
  }

  /**
   * 删除一个归属于当前用户的分组。
   *
   * 方法+路径：DELETE /api/portfolio/groups/:id（需登录）。
   *
   * @param id  分组主键
   * @param req 已认证请求
   */
  @Delete(':id')
  async remove(@Param('id') id: string, @Req() req: Request): Promise<{ success: true }> {
    const { userId } = req.userContext;
    return this.groupsService.remove(id, userId);
  }
}
