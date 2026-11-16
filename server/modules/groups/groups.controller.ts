/**
 * Groups controller.
 *
 * Exposes CRUD endpoints for the user's portfolio grouping categories (labels used
 * to organize holdings) under `/api/portfolio/groups`. Requires login
 * (`@NeedLogin()`) and derives the owning `userId` from `req.userContext`.
 */
import { Controller, Get, Post, Patch, Delete, Param, Body, Req } from '@nestjs/common';
import { NeedLogin } from '../../common/platform';
import type { Request } from 'express';

import { GroupsService } from './groups.service';
import type { Group, CreateGroupDto, UpdateGroupDto, ListResponse } from '@shared/api.interface';

/**
 * REST controller for managing portfolio groups. Delegates to `GroupsService`.
 */
@Controller('api/portfolio/groups')
@NeedLogin()
export class GroupsController {
  constructor(private readonly groupsService: GroupsService) {}

  /**
   * Lists all groups for the current user, ordered by the user's sort order.
   *
   * @param req Authenticated request carrying `req.userContext.userId`.
   */
  @Get()
  async findAll(@Req() req: Request): Promise<ListResponse<Group>> {
    const { userId } = req.userContext;
    return this.groupsService.findAll(userId);
  }

  /**
   * Creates a new group for the current user.
   *
   * @param dto Create payload.
   * @param req Authenticated request.
   */
  @Post()
  async create(@Body() dto: CreateGroupDto, @Req() req: Request): Promise<Group> {
    const { userId } = req.userContext;
    return this.groupsService.create(dto, userId);
  }

  /**
   * Partially updates an owned group.
   *
   * @param id  Group primary key.
   * @param dto Partial update payload.
   * @param req Authenticated request.
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
   * Deletes an owned group.
   *
   * @param id  Group primary key.
   * @param req Authenticated request.
   */
  @Delete(':id')
  async remove(@Param('id') id: string, @Req() req: Request): Promise<{ success: true }> {
    const { userId } = req.userContext;
    return this.groupsService.remove(id, userId);
  }
}
