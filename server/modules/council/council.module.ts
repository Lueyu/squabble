import { Module } from '@nestjs/common';
import { MultiAgentModule } from '../multi-agent/multi-agent.module';
import { CouncilController } from './council.controller';
import { CouncilService } from './council.service';
import { LocalAgentsModule } from '../local-agents/local-agents.module';

@Module({
  imports: [MultiAgentModule, LocalAgentsModule],
  controllers: [CouncilController],
  providers: [CouncilService],
  exports: [CouncilService],
})
export class CouncilModule {}
