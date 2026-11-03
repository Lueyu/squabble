import { Module } from '@nestjs/common';
import { QuoteModule } from '../quote/quote.module';
import { MultiAgentModule } from '../multi-agent/multi-agent.module';
import { ResearchToolsService } from './research-tools.service';

@Module({ imports: [QuoteModule, MultiAgentModule], providers: [ResearchToolsService], exports: [ResearchToolsService] })
export class ResearchToolsModule {}
