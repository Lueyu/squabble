/**
 * @file server/modules/import/import.controller.ts
 * @description Import API: commit mapped rows, OCR extraction, history.
 *
 * CSV parsing and column mapping happen client-side (papaparse); the server
 * only receives normalized rows and applies validation + persistence.
 */
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Request } from 'express';
import { NeedLogin } from '../../common/platform/need-login.decorator';
import { ImportService, type ConfirmImportDto } from './import.service';
import { OcrService } from './ocr.service';
import type { ImportCommitDto, OcrExtractDto } from '@shared/api.interface';
import type { ScreenshotExtractRequest } from '@shared/screenshot-import.interface';
import { ScreenshotJobsService } from './screenshot-jobs.service';
import { ScreenshotError } from './screenshot-result';
import { ImportBatchesService } from './import-batches.service';
import type {
  ImportBatchCommit,
  ImportBatchCreate,
  ImportBatchRow,
  ImportBatchUpload,
  ImportExecutor,
} from '@shared/screenshot-import.interface';
import type { Response } from 'express';
import { TransactionImportsService } from './transaction-imports.service';
import type { TransactionImportCommit, TransactionImportInput } from '../../../shared/transaction-import.interface';
@Controller('api/import')
export class ImportController {
  constructor(
    private readonly imports: ImportService,
    private readonly ocr: OcrService,
    private readonly screenshots: ScreenshotJobsService,
    private readonly batches: ImportBatchesService,
    private readonly transactionBatches: TransactionImportsService,
  ) {}
  @NeedLogin()
  @Post('transaction-batches')
  createTransactionBatch(@Req() req: Request, @Body() dto: TransactionImportInput) { return this.transactionBatches.create(req.userContext.userId, dto); }
  @NeedLogin()
  @Get('transaction-batches/:id/preview')
  previewTransactionBatch(@Req() req: Request, @Param('id') id: string) { return this.transactionBatches.preview(req.userContext.userId, id); }
  @NeedLogin()
  @Post('transaction-batches/:id/commit')
  commitTransactionBatch(@Req() req: Request, @Param('id') id: string, @Body() dto: TransactionImportCommit) { return this.transactionBatches.commit(req.userContext.userId, id, dto); }
  /** Create holdings from mapped/extracted rows (source-tagged). */
  @NeedLogin()
  @Post('commit')
  async commit(
    @Req()
    req: Request,
    @Body()
    dto: ConfirmImportDto,
  ) {
    return this.imports.commit(req.userContext.userId, dto);
  }
  @NeedLogin()
  @Get('batches')
  listBatches(
    @Req()
    req: Request,
  ) {
    return this.batches.list(req.userContext.userId);
  }
  @NeedLogin()
  @Post('batches')
  createBatch(
    @Req()
    req: Request,
    @Body()
    dto: ImportBatchCreate,
  ) {
    return this.batches.create(req.userContext.userId, dto);
  }
  @NeedLogin()
  @Get('batches/:id')
  batch(
    @Req()
    req: Request,
    @Param('id')
    id: string,
  ) {
    return this.batches.get(req.userContext.userId, id);
  }
  @NeedLogin()
  @Post('batches/:id/images')
  uploadBatch(
    @Req()
    req: Request,
    @Param('id')
    id: string,
    @Body()
    dto: ImportBatchUpload,
  ) {
    return this.batches.upload(req.userContext.userId, id, dto);
  }
  @NeedLogin()
  @Get('batches/:id/images/:imageId')
  async batchImage(
    @Req()
    req: Request,
    @Param('id')
    id: string,
    @Param('imageId')
    imageId: string,
    @Res()
    res: Response,
  ) {
    const image = await this.batches.image(req.userContext.userId, id, imageId);
    res.setHeader('Cache-Control', 'private, no-store');
    res.type(image.mimeType).send(Buffer.from(image.data, 'base64'));
  }
  @NeedLogin()
  @Post('batches/:id/start')
  startBatch(
    @Req()
    req: Request,
    @Param('id')
    id: string,
    @Body()
    dto?: {
      credentials?: Extract<
        ImportExecutor,
        {
          executor: 'vision';
        }
      >;
    },
  ) {
    return this.batches.start(req.userContext.userId, id, dto?.credentials);
  }
  @NeedLogin()
  @Post('batches/:id/recover')
  async recoverBatch(
    @Req()
    req: Request,
    @Param('id')
    id: string,
  ) {
    await this.batches.get(req.userContext.userId, id);
    await this.batches.recover(req.userContext.userId, id);
    return this.batches.get(req.userContext.userId, id);
  }
  @NeedLogin()
  @Post('batches/:id/rows/:rowId')
  editBatch(
    @Req()
    req: Request,
    @Param('id')
    id: string,
    @Param('rowId')
    rowId: string,
    @Body()
    dto: {
      patch: Partial<ImportBatchRow>;
      expectedRevision: number;
    },
  ) {
    return this.batches.edit(
      req.userContext.userId,
      id,
      rowId,
      dto.patch,
      dto.expectedRevision,
    );
  }
  @NeedLogin()
  @Get('batches/:id/preview')
  previewBatch(
    @Req()
    req: Request,
    @Param('id')
    id: string,
  ) {
    return this.batches.preview(req.userContext.userId, id);
  }
  @NeedLogin()
  @Post('batches/:id/commit')
  commitBatch(
    @Req()
    req: Request,
    @Param('id')
    id: string,
    @Body()
    dto: ImportBatchCommit,
  ) {
    return this.batches.commit(req.userContext.userId, id, dto);
  }
  @NeedLogin()
  @Post('batches/:id/images/:imageId/retry')
  retryBatchImage(
    @Req()
    req: Request,
    @Param('id')
    id: string,
    @Param('imageId')
    imageId: string,
  ) {
    return this.batches.retry(req.userContext.userId, id, imageId);
  }
  @NeedLogin()
  @Post('batches/:id/images/:imageId/reselect')
  reselectBatchImage(
    @Req() req: Request,
    @Param('id') id: string,
    @Param('imageId') imageId: string,
    @Body() dto: { image: ImportBatchUpload['image'] },
  ) {
    return this.batches.reselect(
      req.userContext.userId,
      id,
      imageId,
      dto.image,
    );
  }
  @NeedLogin()
  @Delete('batches/:id')
  cancelBatch(
    @Req()
    req: Request,
    @Param('id')
    id: string,
  ) {
    return this.batches.cancel(req.userContext.userId, id);
  }
  /** Extract holdings rows from a broker screenshot via the user's LLM key. */
  @NeedLogin()
  @Post('ocr/extract')
  async ocrExtract(
    @Req()
    req: Request,
    @Body()
    dto: OcrExtractDto,
  ) {
    try {
      return await this.ocr.extract(dto);
    } catch (error) {
      if (error instanceof ScreenshotError)
        throw new BadRequestException(error.code);
      throw error;
    }
  }
  @NeedLogin()
  @Post('screenshot-jobs')
  startScreenshot(
    @Req()
    req: Request,
    @Body()
    dto: ScreenshotExtractRequest,
  ) {
    return this.screenshots.start(req.userContext.userId, dto);
  }
  @NeedLogin()
  @Get('screenshot-jobs/:id')
  screenshot(
    @Req()
    req: Request,
    @Param('id')
    id: string,
  ) {
    return this.screenshots.get(req.userContext.userId, id);
  }
  @NeedLogin()
  @Delete('screenshot-jobs/:id')
  cancelScreenshot(
    @Req()
    req: Request,
    @Param('id')
    id: string,
  ) {
    return this.screenshots.cancel(req.userContext.userId, id);
  }
  /** Recent import history for the caller. */
  @NeedLogin()
  @Get('history')
  async history(
    @Req()
    req: Request,
    @Query('limit')
    limit?: string,
  ) {
    return this.imports.history(
      req.userContext.userId,
      limit ? Number(limit) : undefined,
    );
  }
}
