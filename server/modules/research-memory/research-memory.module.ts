import { ResearchArchiveService } from './research-memory.archive';
import { Module } from '@nestjs/common';
import { QuoteModule } from '../quote/quote.module';
import { ResearchMemoryController } from './research-memory.controller';
import { ResearchMemoryService } from './research-memory.service';

@Module({ imports: [QuoteModule], controllers: [ResearchMemoryController],
  providers: [ResearchMemoryService, ResearchArchiveService], exports: [ResearchMemoryService] })
export class ResearchMemoryModule {}
