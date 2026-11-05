/**
 * @file server/modules/import/import.controller.ts
 * @description Import API: commit mapped rows, OCR extraction, history.
 *
 * CSV parsing and column mapping happen client-side (papaparse); the server
 * only receives normalized rows and applies validation + persistence.
 */
import { BadRequestException, Body, Controller, Delete, Get, Param, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { NeedLogin } from '../../common/platform/need-login.decorator';
import { ImportService } from './import.service';
import { OcrService } from './ocr.service';
import type { ImportCommitDto, OcrExtractDto } from '@shared/api.interface';
import type { ScreenshotExtractRequest } from '@shared/screenshot-import.interface';
import { ScreenshotJobsService } from './screenshot-jobs.service';
import { ScreenshotError } from './screenshot-result';

@Controller('api/import')
export class ImportController {
  constructor(
    private readonly imports: ImportService,
    private readonly ocr: OcrService,
    private readonly screenshots: ScreenshotJobsService,
  ) {}

  /** Create holdings from mapped/extracted rows (source-tagged). */
  @NeedLogin()
  @Post('commit')
  async commit(@Req() req: Request, @Body() dto: ImportCommitDto) {
    return this.imports.commit(req.userContext.userId, dto);
  }

  /** Extract holdings rows from a broker screenshot via the user's LLM key. */
  @NeedLogin()
  @Post('ocr/extract')
  async ocrExtract(@Req() req: Request, @Body() dto: OcrExtractDto) {
    try { return await this.ocr.extract(dto); }
    catch (error) { if (error instanceof ScreenshotError) throw new BadRequestException(error.code); throw error; }
  }

  @NeedLogin()
  @Post('screenshot-jobs')
  startScreenshot(@Req() req: Request, @Body() dto: ScreenshotExtractRequest) {
    return this.screenshots.start(req.userContext.userId, dto);
  }

  @NeedLogin()
  @Get('screenshot-jobs/:id')
  screenshot(@Req() req: Request, @Param('id') id: string) {
    return this.screenshots.get(req.userContext.userId, id);
  }

  @NeedLogin()
  @Delete('screenshot-jobs/:id')
  cancelScreenshot(@Req() req: Request, @Param('id') id: string) {
    return this.screenshots.cancel(req.userContext.userId, id);
  }

  /** Recent import history for the caller. */
  @NeedLogin()
  @Get('history')
  async history(@Req() req: Request, @Query('limit') limit?: string) {
    return this.imports.history(req.userContext.userId, limit ? Number(limit) : undefined);
  }
}
