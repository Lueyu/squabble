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

@Module({
  imports: [HttpModule, QuoteModule, LocalAgentsModule],
  controllers: [ImportController],
  providers: [ImportService, OcrService, ScreenshotJobsService],
  exports: [ImportService],
})
export class ImportModule {}
