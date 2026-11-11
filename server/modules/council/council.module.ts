import { Module } from '@nestjs/common';
import { MultiAgentModule } from '../multi-agent/multi-agent.module';
import { ResearchCoreModule } from '../research-core/research-core.module';
import { CouncilController } from './council.controller';
import { CouncilService } from './council.service';
import { ResearchMemoryModule } from '../research-memory/research-memory.module';
import { ResearchToolsModule } from '../research-tools/research-tools.module';
import { LocalAgentsModule } from '../local-agents/local-agents.module';
import { ResearchDocumentsModule } from '../research-documents/research-documents.module';
import { SimpleCouncilService } from './simple-council.service';
import { DataLibraryModule } from '../data-library/data-library.module';
import { ResearchRuntimeModule } from '../research-runtime/research-runtime.module';
import { ToolConnectionsModule } from '../tool-connections/tool-connections.module';
import { CouncilToolRuntimeService } from './council-tool-runtime.service';
import { ToolActionsModule } from '../tool-actions/tool-actions.module';
import {
  ResearchConversationsController,
  ResearchExecutionController,
} from './simple-council.controller';

@Module({
  imports: [
    ResearchCoreModule,
    // Saved stock evidence still belongs to retained runs, not the shared core.
    MultiAgentModule,
    LocalAgentsModule,
    ResearchMemoryModule,
    ResearchToolsModule,
    ResearchDocumentsModule,
    DataLibraryModule,
    ResearchRuntimeModule,
    ToolConnectionsModule,
    ToolActionsModule,
  ],
  controllers: [
    CouncilController,
    ResearchConversationsController,
    ResearchExecutionController,
  ],
  providers: [CouncilService, SimpleCouncilService, CouncilToolRuntimeService],
  exports: [CouncilService, SimpleCouncilService],
})
export class CouncilModule {}
