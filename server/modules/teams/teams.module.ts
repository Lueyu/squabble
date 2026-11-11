import { Module } from '@nestjs/common';
import { CouncilModule } from '../council/council.module';
import { LocalAgentsModule } from '../local-agents/local-agents.module';
import { TeamStore } from './team-store';
import { TeamsService } from './teams.service';
import { TeamVersionService } from './team-version.service';
import { TeamRuntimeAdapter } from './team-runtime-adapter';
import { TeamCommissionService } from './team-commission.service';
import { TeamCommissionWorker } from './team-commission.worker';
import { TeamDecisionService } from './team-decision.service';
import { TeamSourceAccessService } from './team-source-access.service';
import { TeamsController } from './teams.controller';
@Module({ imports: [CouncilModule, LocalAgentsModule], controllers: [TeamsController], providers: [TeamStore, TeamsService, TeamVersionService, TeamRuntimeAdapter,
        TeamCommissionService, TeamCommissionWorker, TeamDecisionService, TeamSourceAccessService], exports: [TeamsService] })
export class TeamsModule {
}
