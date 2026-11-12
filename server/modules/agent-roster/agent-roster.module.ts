import { Module } from '@nestjs/common';
import { LocalAgentsModule } from '../local-agents/local-agents.module';
import { LocalAgentsService } from '../local-agents/local-agents.service';
import { AgentRosterController } from './agent-roster.controller';
import { AGENT_ROSTER_LOCAL_STATUS, AgentRosterService } from './agent-roster.service';

@Module({ imports: [LocalAgentsModule], controllers: [AgentRosterController], providers: [
  { provide: AGENT_ROSTER_LOCAL_STATUS, useExisting: LocalAgentsService }, AgentRosterService,
], exports: [AgentRosterService] })
export class AgentRosterModule { }
