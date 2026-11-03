import { Module } from '@nestjs/common';
import { QuoteModule } from '../quote/quote.module';
import { MultiAgentModule } from '../multi-agent/multi-agent.module';
import { ResearchToolsService } from './research-tools.service';
import { ResearchMemoryModule } from '../research-memory/research-memory.module';

@Module({ imports: [QuoteModule, MultiAgentModule, ResearchMemoryModule], providers: [ResearchToolsService], exports: [ResearchToolsService] })
export class ResearchToolsModule {}
