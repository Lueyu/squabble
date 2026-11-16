/**
 * Holdings controller.
 *
 * Exposes CRUD endpoints for the user's stock holdings under
 * `/api/portfolio/holdings`. Every route requires an authenticated session
 * (`@NeedLogin()`) and derives the owning `userId` from `req.userContext`, so all
 * data access is automatically scoped to the logged-in user. Business logic and SQL
 * live in `HoldingsService`.
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
 * REST controller for managing holdings. Delegates all work to `HoldingsService`.
 */
@Controller('api/portfolio/holdings')
@NeedLogin()
export class HoldingsController {
  constructor(private readonly holdingsService: HoldingsService) {}

  /**
   * Lists all holdings owned by the current user, most recently updated first.
   *
   * @param req Authenticated request carrying `req.userContext.userId`.
   */
  @Get()
  async findAll(@Req() req: Request): Promise<ListResponse<Holding>> {
    const { userId } = req.userContext;
    return this.holdingsService.findAll(userId);
  }

  /**
   * Fetches a single holding by id. Only returns it if it belongs to the caller.
   *
   * @param id  Holding primary key.
   * @param req Authenticated request.
   */
  @Get(':id')
  async findOne(@Param('id') id: string, @Req() req: Request): Promise<Holding> {
    const { userId } = req.userContext;
    return this.holdingsService.findOne(id, userId);
  }

  /**
   * Creates a new holding for the current user. Market/currency metadata is
   * derived automatically from the ticker server-side.
   *
   * @param dto Create payload.
   * @param req Authenticated request.
   */
  @Post()
  async create(@Body() dto: CreateHoldingDto, @Req() req: Request): Promise<Holding> {
    const { userId } = req.userContext;
    return this.holdingsService.create(dto, userId);
  }

  /**
   * Batch-updates the latest market price for multiple holdings at once.
   * Note: the route `prices` is declared before `:id` so it is matched first.
   *
   * @param body `{ items }` list of ticker/price updates.
   * @param req  Authenticated request.
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
   * Partially updates an existing holding owned by the caller.
   *
   * @param id  Holding primary key.
   * @param dto Partial update payload.
   * @param req Authenticated request.
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
   * Deletes a holding owned by the caller.
   *
   * @param id  Holding primary key.
   * @param req Authenticated request.
   */
  @Delete(':id')
  async remove(@Param('id') id: string, @Req() req: Request): Promise<{ success: true }> {
    const { userId } = req.userContext;
    return this.holdingsService.remove(id, userId);
  }
}
