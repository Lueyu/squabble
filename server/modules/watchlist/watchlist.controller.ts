/**
 * Watchlist controller.
 *
 * Exposes CRUD endpoints for the user's watchlist (stocks being monitored but not
 * yet held) under `/api/portfolio/watchlist`. Requires login (`@NeedLogin()`) and
 * derives the owning `userId` from `req.userContext` so all access is scoped to
 * the current user. Business logic lives in `WatchlistService`.
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
 * REST controller for managing watchlist items. Delegates to `WatchlistService`.
 */
@Controller('api/portfolio/watchlist')
@NeedLogin()
export class WatchlistController {
  constructor(private readonly watchlistService: WatchlistService) {}

  /**
   * Lists all watchlist items for the current user, most recently updated first.
   *
   * @param req Authenticated request carrying `req.userContext.userId`.
   */
  @Get()
  async findAll(@Req() req: Request): Promise<ListResponse<WatchItem>> {
    const { userId } = req.userContext;
    return this.watchlistService.findAll(userId);
  }

  /**
   * Fetches a single watchlist item by id, only if owned by the caller.
   *
   * @param id  Watch item primary key.
   * @param req Authenticated request.
   */
  @Get(':id')
  async findOne(@Param('id') id: string, @Req() req: Request): Promise<WatchItem> {
    const { userId } = req.userContext;
    return this.watchlistService.findOne(id, userId);
  }

  /**
   * Adds a new watchlist item for the current user. Market/currency metadata is
   * derived from the ticker server-side.
   *
   * @param dto Create payload.
   * @param req Authenticated request.
   */
  @Post()
  async create(@Body() dto: CreateWatchItemDto, @Req() req: Request): Promise<WatchItem> {
    const { userId } = req.userContext;
    return this.watchlistService.create(dto, userId);
  }

  /**
   * Batch-updates latest prices for multiple watchlist items. Declared before
   * `:id` so the static `prices` route wins the match.
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
    return this.watchlistService.updatePrices(body.items, userId);
  }

  /**
   * Partially updates an owned watchlist item.
   *
   * @param id  Watch item primary key.
   * @param dto Partial update payload.
   * @param req Authenticated request.
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
   * Removes a watchlist item owned by the caller.
   *
   * @param id  Watch item primary key.
   * @param req Authenticated request.
   */
  @Delete(':id')
  async remove(@Param('id') id: string, @Req() req: Request): Promise<{ success: true }> {
    const { userId } = req.userContext;
    return this.watchlistService.remove(id, userId);
  }
}
