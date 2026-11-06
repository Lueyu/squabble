/**
 * @file server/modules/import/import.module.ts
 * @description Import wiring: commit engine + OCR proxy.
 */
import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { QuoteModule } from '../quote/quote.module';
import { ImportController } from './import.controller';
import { ImportService } from './import.service';
import { OcrService } from './ocr.service';
import { ScreenshotJobsService } from './screenshot-jobs.service';
import { LocalAgentsModule } from '../local-agents/local-agents.module';
import { ExperienceModule } from '../experience/experience.module';
import { ImportBatchesService } from './import-batches.service';
import { ImportBatchFiles } from './import-batch-files';

@Module({
  imports: [HttpModule, QuoteModule, LocalAgentsModule, ExperienceModule],
  controllers: [ImportController],
  providers: [ImportService, OcrService, ScreenshotJobsService, ImportBatchesService, ImportBatchFiles],
  exports: [ImportService],
})
export class ImportModule {}
