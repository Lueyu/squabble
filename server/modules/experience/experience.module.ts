import { Module } from '@nestjs/common';
import { MultiAgentModule } from '../multi-agent/multi-agent.module';
import { CouncilModule } from '../council/council.module';
import { ResearchDocumentsModule } from '../research-documents/research-documents.module';
import { CurrentResearchService } from './current-research.service';
import { TodayService } from './today.service';
import { ExperienceController } from './experience.controller';
import { ExperienceScheduler } from './experience.scheduler';
import { ResearchFollowupService } from './research-followup.service';
import { LocalAgentsModule } from '../local-agents/local-agents.module';
import { PortfolioResearchRouteService } from './portfolio-research-route.service';
import { ImportAnalysisHandoffService } from './import-analysis-handoff.service';

@Module({imports:[MultiAgentModule,CouncilModule,ResearchDocumentsModule,LocalAgentsModule],controllers:[ExperienceController],providers:[TodayService,CurrentResearchService,ExperienceScheduler,ResearchFollowupService,PortfolioResearchRouteService,ImportAnalysisHandoffService],exports:[TodayService,CurrentResearchService,ImportAnalysisHandoffService]})
export class ExperienceModule {}
