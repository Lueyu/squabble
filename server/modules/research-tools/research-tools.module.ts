import { Module } from '@nestjs/common';
import { QuoteModule } from '../quote/quote.module';
import { ResearchCoreModule } from '../research-core/research-core.module';
import { ResearchToolsService } from './research-tools.service';
import { ResearchMemoryModule } from '../research-memory/research-memory.module';

@Module({
  imports: [QuoteModule, ResearchCoreModule, ResearchMemoryModule],
  providers: [ResearchToolsService],
  exports: [ResearchToolsService],
})
export class ResearchToolsModule {}
