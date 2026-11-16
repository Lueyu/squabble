/**
 * Alpha-picks controller.
 *
 * Exposes CRUD endpoints for the user's curated "alpha picks" (tracked stock
 * recommendations with return %, rating, and weight) under
 * `/api/portfolio/alpha-picks`. Requires login on every route.
 */
import { Controller, Get, Post, Patch, Delete, Param, Body, Req } from '@nestjs/common';
import { NeedLogin } from '../../common/platform';
import type { Request } from 'express';

import { AlphaPicksService, type UpdateAlphaPickDto } from './alpha-picks.service';
import type { AlphaPick, CreateAlphaPickDto, ListResponse } from '@shared/api.interface';

/**
 * REST controller for alpha picks. Delegates to `AlphaPicksService`.
 */
@Controller('api/portfolio/alpha-picks')
@NeedLogin()
export class AlphaPicksController {
  constructor(private readonly alphaPicksService: AlphaPicksService) {}

  /**
   * Lists all alpha picks for the user, newest first.
   *
   * @param req Authenticated request carrying `req.userContext.userId`.
   */
  @Get()
  async findAll(@Req() req: Request): Promise<ListResponse<AlphaPick>> {
    const { userId } = req.userContext;
    return this.alphaPicksService.findAll(userId);
  }

  /**
   * Creates a new alpha pick.
   *
   * @param dto Pick payload.
   * @param req Authenticated request.
   */
  @Post()
  async create(@Body() dto: CreateAlphaPickDto, @Req() req: Request): Promise<AlphaPick> {
    const { userId } = req.userContext;
    return this.alphaPicksService.create(dto, userId);
  }

  /**
   * Updates an owned alpha pick.
   *
   * @param id  Pick primary key.
   * @param dto Partial update payload.
   * @param req Authenticated request.
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
   * Deletes an owned alpha pick.
   *
   * @param id  Pick primary key.
   * @param req Authenticated request.
   */
  @Delete(':id')
  async remove(@Param('id') id: string, @Req() req: Request): Promise<{ success: true }> {
    const { userId } = req.userContext;
    return this.alphaPicksService.remove(id, userId);
  }
}
