import { Module } from '@nestjs/common';
import { QuoteModule } from '../quote/quote.module';
import { DataLibraryController } from './data-library.controller';
import { DataLibraryService } from './data-library.service';
import { DataFinancialService } from './data-financial.service';
import { FinnhubEvidenceService } from '../research-core/finnhub-evidence.service';
import { SecEvidenceService } from '../research-core/sec-evidence.service';
@Module({ imports: [QuoteModule], controllers: [DataLibraryController],
  providers: [DataLibraryService, DataFinancialService, FinnhubEvidenceService, SecEvidenceService],
  exports: [DataLibraryService, DataFinancialService] })
export class DataLibraryModule {}
