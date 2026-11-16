/**
 * Trading journal controller.
 *
 * Exposes endpoints for the user's per-day trading journal notes (market summary,
 * portfolio summary, actions, plan, lessons) under
 * `/api/portfolio/journal`. Requires login on every route.
 */
import { Controller, Get, Post, Delete, Body, Param, Query, Req } from '@nestjs/common';
import { NeedLogin } from '../../common/platform';
import type { Request } from 'express';
import { JournalService } from './journal.service';
import type { JournalEntry, CreateJournalDto, ListResponse } from '@shared/api.interface';

/**
 * REST controller for the trading journal. Delegates to `JournalService`.
 */
@NeedLogin()
@Controller('api/portfolio/journal')
export class JournalController {
  constructor(private readonly journalService: JournalService) {}

  /**
   * Lists journal entries for the user, newest first, optionally filtered by date.
   *
   * @param req  Authenticated request carrying `req.userContext.userId`.
   * @param date  Optional journal date (YYYY-MM-DD) filter.
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
   * Returns the most recent journal entry, or null if none exists.
   *
   * @param req Authenticated request.
   */
  @Get('latest')
  async latest(@Req() req: Request): Promise<JournalEntry | null> {
    const { userId } = req.userContext;
    return this.journalService.latest(userId);
  }

  /**
   * Creates or updates (upserts) the journal entry for a given date.
   *
   * @param req Authenticated request.
   * @param dto Journal payload (keyed by `journalDate`).
   */
  @Post()
  async upsert(@Req() req: Request, @Body() dto: CreateJournalDto): Promise<JournalEntry> {
    const { userId } = req.userContext;
    return this.journalService.upsert(userId, dto);
  }

  /**
   * Deletes an owned journal entry.
   *
   * @param req Authenticated request.
   * @param id  Journal entry primary key.
   */
  @Delete(':id')
  async remove(@Req() req: Request, @Param('id') id: string): Promise<{ success: boolean }> {
    const { userId } = req.userContext;
    return this.journalService.remove(userId, id);
  }
}
