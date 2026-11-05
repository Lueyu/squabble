import { Module } from '@nestjs/common';
import { MultiAgentModule } from '../multi-agent/multi-agent.module';
import { CouncilController } from './council.controller';
import { CouncilService } from './council.service';
import { ResearchMemoryModule } from '../research-memory/research-memory.module';
import { ResearchToolsModule } from '../research-tools/research-tools.module';
import { LocalAgentsModule } from '../local-agents/local-agents.module';
import { ResearchDocumentsModule } from '../research-documents/research-documents.module';
import { SimpleCouncilService } from './simple-council.service';
import { ResearchConversationsController } from './simple-council.controller';

@Module({
  imports: [MultiAgentModule, LocalAgentsModule, ResearchMemoryModule, ResearchToolsModule, ResearchDocumentsModule],
  controllers: [CouncilController, ResearchConversationsController],
  providers: [CouncilService, SimpleCouncilService],
  exports: [CouncilService, SimpleCouncilService],
})
export class CouncilModule {}
