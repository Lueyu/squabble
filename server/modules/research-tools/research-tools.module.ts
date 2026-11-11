import { Module } from '@nestjs/common';
import { QuoteModule } from '../quote/quote.module';
import { ResearchCoreModule } from '../research-core/research-core.module';
import { ResearchToolsService } from './research-tools.service';
import { ResearchMemoryModule } from '../research-memory/research-memory.module';
import { DataLibraryModule } from '../data-library/data-library.module';
import { ResearchArtifactsModule } from '../research-artifacts/research-artifacts.module';
import { ResearchComputeModule } from '../research-compute/research-compute.module';
import { BrowserResearchModule } from '../data-library/browser/browser-research.module';
import { ToolCapabilitiesModule } from '../tool-capabilities/tool-capabilities.module';

@Module({
  imports: [QuoteModule, ResearchCoreModule, ResearchMemoryModule, DataLibraryModule, ResearchArtifactsModule, ResearchComputeModule, BrowserResearchModule, ToolCapabilitiesModule],
  providers: [ResearchToolsService],
  exports: [ResearchToolsService],
})
export class ResearchToolsModule {}
