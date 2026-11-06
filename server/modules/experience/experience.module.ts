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
import { PortfolioMetricsService } from './portfolio-metrics.service';
import { QuoteModule } from '../quote/quote.module';
import { DailyChannelResearchService } from './daily-channel-research.service';
import { ChannelModule } from '../channel/channel.module';
import { PaperTradingModule } from '../paper-trading/paper-trading.module';

@Module({imports:[MultiAgentModule,CouncilModule,ResearchDocumentsModule,LocalAgentsModule,QuoteModule,ChannelModule,PaperTradingModule],controllers:[ExperienceController],providers:[TodayService,CurrentResearchService,ExperienceScheduler,ResearchFollowupService,PortfolioResearchRouteService,ImportAnalysisHandoffService,PortfolioMetricsService,DailyChannelResearchService],exports:[TodayService,CurrentResearchService,ImportAnalysisHandoffService]})
export class ExperienceModule {}
