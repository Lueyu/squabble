import { Module } from '@nestjs/common';
import { MultiAgentModule } from '../multi-agent/multi-agent.module';
import { ResearchCoreModule } from '../research-core/research-core.module';
import { CouncilModule } from '../council/council.module';
import { ResearchDocumentsModule } from '../research-documents/research-documents.module';
import { CurrentResearchService } from './current-research.service';
import { TodayService } from './today.service';
import { ExperienceController } from './experience.controller';
import { ExperienceScheduler } from './experience.scheduler';
import { ResearchFollowupService } from './research-followup.service';
import { LocalAgentsModule } from '../local-agents/local-agents.module';
import { ResearchRoutingModule } from '../research-routing/research-routing.module';
import { ImportAnalysisHandoffService } from './import-analysis-handoff.service';
import { PortfolioMetricsService } from './portfolio-metrics.service';
import { QuoteModule } from '../quote/quote.module';
import { DailyChannelResearchService } from './daily-channel-research.service';
import { ChannelModule } from '../channel/channel.module';
import { PaperTradingModule } from '../paper-trading/paper-trading.module';
import { DailyWorkspaceService } from './daily-workspace.service';
import { DailyWorkspaceController } from './daily-workspace.controller';
import { DailyWorkspaceResearchController } from './daily-workspace-research.controller';
import { DailyWorkspaceResearchService } from './daily-workspace-research.service';

@Module({
  imports: [
    ResearchCoreModule,
    ResearchRoutingModule,
    // Historical portfolio runs and queued work keep their existing lifecycle.
    MultiAgentModule,
    CouncilModule,
    ResearchDocumentsModule,
    LocalAgentsModule,
    QuoteModule,
    ChannelModule,
    PaperTradingModule,
  ],
  controllers: [ExperienceController, DailyWorkspaceController, DailyWorkspaceResearchController],
  providers: [
    DailyWorkspaceService,
    DailyWorkspaceResearchService,
    TodayService,
    CurrentResearchService,
    ExperienceScheduler,
    ResearchFollowupService,
    ImportAnalysisHandoffService,
    PortfolioMetricsService,
    DailyChannelResearchService,
  ],
  exports: [TodayService, CurrentResearchService, ImportAnalysisHandoffService],
})
export class ExperienceModule {}
