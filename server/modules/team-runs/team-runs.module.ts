import { Module } from '@nestjs/common';
import { TeamsModule } from '../teams/teams.module';
import { PaperTradingModule } from '../paper-trading/paper-trading.module';
import { TeamRunService } from './team-run.service';
import { TeamRunScheduler } from './team-run.scheduler';
import { TeamRunDelivery } from './team-run.delivery';
import { TeamRunController } from './team-run.controller';
@Module({ imports: [TeamsModule, PaperTradingModule], controllers: [TeamRunController], providers: [TeamRunService, TeamRunScheduler, TeamRunDelivery], exports: [TeamRunService] })
export class TeamRunsModule {}
