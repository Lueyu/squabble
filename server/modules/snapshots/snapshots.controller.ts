/**
 * Snapshots controller.
 *
 * Exposes endpoints for the user's daily portfolio snapshots (account value, market
 * value, cost, cash, P&L, net deposits) under
 * `/api/portfolio/snapshots`. Requires login on every route.
 */
import { Controller, Get, Post, Delete, Body, Param, Query, Req } from '@nestjs/common';
import { NeedLogin } from '../../common/platform';
import type { Request } from 'express';
import { SnapshotsService } from './snapshots.service';
import type { Snapshot, CreateSnapshotDto, ListResponse } from '@shared/api.interface';

/**
 * REST controller for daily portfolio snapshots. Delegates to `SnapshotsService`.
 */
@NeedLogin()
@Controller('api/portfolio/snapshots')
export class SnapshotsController {
  constructor(private readonly snapshotsService: SnapshotsService) {}

  /**
   * Lists snapshots for the user, newest first (default/ capped at 90, max 365).
   *
   * @param req    Authenticated request carrying `req.userContext.userId`.
   * @param limit   Optional max number of rows.
   */
  @Get()
  async list(@Req() req: Request, @Query('limit') limit?: string): Promise<ListResponse<Snapshot>> {
    const { userId } = req.userContext;
    const limitNum = limit ? parseInt(limit, 10) : 90;
    return this.snapshotsService.list(userId, limitNum);
  }

  /**
   * Returns the most recent snapshot, or null if none exists.
   *
   * @param req Authenticated request.
   */
  @Get('latest')
  async latest(@Req() req: Request): Promise<Snapshot | null> {
    const { userId } = req.userContext;
    return this.snapshotsService.latest(userId);
  }

  /**
   * Creates or updates (upserts) the snapshot for a given date, also recomputing
   * net/cumulative deposits and daily P&L.
   *
   * @param req Authenticated request.
   * @param dto Snapshot payload keyed by `snapshotDate`.
   */
  @Post()
  async upsert(@Req() req: Request, @Body() dto: CreateSnapshotDto): Promise<Snapshot> {
    const { userId } = req.userContext;
    return this.snapshotsService.upsert(userId, dto);
  }

  /**
   * Upserts multiple snapshots at once (processed chronologically so cumulative
   * values chain correctly), returning them newest first.
   *
   * @param req   Authenticated request.
   * @param items Snapshot payloads.
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
   * Deletes an owned snapshot.
   *
   * @param req Authenticated request.
   * @param id  Snapshot primary key.
   */
  @Delete(':id')
  async remove(@Req() req: Request, @Param('id') id: string): Promise<{ success: boolean }> {
    const { userId } = req.userContext;
    return this.snapshotsService.remove(userId, id);
  }
}
