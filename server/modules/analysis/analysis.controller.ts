/**
 * Analysis controller.
 *
 * Exposes endpoints for per-date / per-ticker stock research notes (rating, action,
 * thesis, target price, catalysts, risks) under `/api/portfolio/analysis`.
 * Requires login on every route.
 */
import { Controller, Get, Post, Delete, Body, Param, Query, Req } from '@nestjs/common';
import { NeedLogin } from '../../common/platform';
import type { Request } from 'express';
import { AnalysisService } from './analysis.service';
import type { Analysis, CreateAnalysisDto, ListResponse } from '@shared/api.interface';

/**
 * REST controller for stock analysis notes. Delegates to `AnalysisService`.
 */
@NeedLogin()
@Controller('api/portfolio/analysis')
export class AnalysisController {
  constructor(private readonly analysisService: AnalysisService) {}

  /**
   * Lists analysis notes, newest date / ticker order, optionally filtered by date
   * and/or ticker.
   *
   * @param req    Authenticated request carrying `req.userContext.userId`.
   * @param date   Optional analysis date filter.
   * @param ticker Optional ticker filter.
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
   * Lists the distinct dates that have analysis notes.
   *
   * @param req Authenticated request.
   */
  @Get('dates')
  async dates(@Req() req: Request): Promise<ListResponse<{ date: string }>> {
    const { userId } = req.userContext;
    return this.analysisService.listDates(userId);
  }

  /**
   * Creates or updates (upserts) the analysis note for a (date, ticker).
   *
   * @param req Authenticated request.
   * @param dto Analysis payload.
   */
  @Post()
  async upsert(@Req() req: Request, @Body() dto: CreateAnalysisDto): Promise<Analysis> {
    const { userId } = req.userContext;
    return this.analysisService.upsert(userId, dto);
  }

  /**
   * Upserts multiple analysis notes at once.
   *
   * @param req   Authenticated request.
   * @param items Analysis payloads.
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
   * Deletes an owned analysis note.
   *
   * @param req Authenticated request.
   * @param id  Analysis row primary key.
   */
  @Delete(':id')
  async remove(@Req() req: Request, @Param('id') id: string): Promise<{ success: boolean }> {
    const { userId } = req.userContext;
    return this.analysisService.remove(userId, id);
  }
}
