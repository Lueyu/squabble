import { Module } from '@nestjs/common';
import { QuoteModule } from '../quote/quote.module';
import { ResearchCoreModule } from '../research-core/research-core.module';
import { ResearchToolsService } from './research-tools.service';
import { ResearchMemoryModule } from '../research-memory/research-memory.module';
import { DataLibraryModule } from '../data-library/data-library.module';

@Module({
  imports: [QuoteModule, ResearchCoreModule, ResearchMemoryModule, DataLibraryModule],
  providers: [ResearchToolsService],
  exports: [ResearchToolsService],
})
export class ResearchToolsModule {}
