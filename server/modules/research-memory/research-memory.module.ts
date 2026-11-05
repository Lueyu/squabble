import { ResearchArchiveService } from './research-memory.archive';
import { Module } from '@nestjs/common';
import { QuoteModule } from '../quote/quote.module';
import { ResearchMemoryController } from './research-memory.controller';
import { ResearchMemoryService } from './research-memory.service';
import { ResearchMonitorService } from './research-memory.monitor.service';

@Module({ imports: [QuoteModule], controllers: [ResearchMemoryController],
  providers: [ResearchMemoryService, ResearchArchiveService, ResearchMonitorService], exports: [ResearchMemoryService, ResearchMonitorService] })
export class ResearchMemoryModule {}
