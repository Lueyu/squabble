import { Module } from '@nestjs/common';
import { QuoteModule } from '../quote/quote.module';
import { DataLibraryController } from './data-library.controller';
import { DataLibraryService } from './data-library.service';
import { DataFinancialService } from './data-financial.service';
import { DataBrowserService } from './data-browser.service';
import { FinnhubEvidenceService } from '../research-core/finnhub-evidence.service';
import { SecEvidenceService } from '../research-core/sec-evidence.service';
import { ResearchArtifactsModule } from '../research-artifacts/research-artifacts.module';
import { DocumentJobsService, DOCUMENT_EXTRACTORS } from './document-jobs.service';
import { DocumentWorkers, configuredDocumentExtractors } from './documents/document-workers';
import { FinancialDatasetService } from './providers/financial-dataset.service';
import { ToolConnectionsModule } from '../tool-connections/tool-connections.module';
@Module({ imports: [QuoteModule, ResearchArtifactsModule, ToolConnectionsModule], controllers: [DataLibraryController],
  providers: [DataLibraryService, DataFinancialService, DataBrowserService, FinnhubEvidenceService, SecEvidenceService,
    DocumentJobsService, DocumentWorkers, FinancialDatasetService, { provide: DOCUMENT_EXTRACTORS, useFactory: configuredDocumentExtractors }],
  exports: [DataLibraryService, DataFinancialService, DataBrowserService, DocumentJobsService] })
export class DataLibraryModule {}
