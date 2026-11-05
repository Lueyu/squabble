import { Module } from '@nestjs/common';
import { MultiAgentModule } from '../multi-agent/multi-agent.module';
import { CouncilModule } from '../council/council.module';
import { ResearchDocumentsModule } from '../research-documents/research-documents.module';
import { CurrentResearchService } from './current-research.service';
import { TodayService } from './today.service';
import { ExperienceController } from './experience.controller';
import { ExperienceScheduler } from './experience.scheduler';
import { ResearchFollowupService } from './research-followup.service';

@Module({imports:[MultiAgentModule,CouncilModule,ResearchDocumentsModule],controllers:[ExperienceController],providers:[TodayService,CurrentResearchService,ExperienceScheduler,ResearchFollowupService],exports:[TodayService,CurrentResearchService]})
export class ExperienceModule {}
