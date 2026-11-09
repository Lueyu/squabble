import { Module } from '@nestjs/common';
import { LocalAgentsModule } from '../local-agents/local-agents.module';
import { ResearchCoreModule } from '../research-core/research-core.module';
import { PortfolioResearchRouteService } from './portfolio-research-route.service';

/** One executor-selection provider shared by research and simulated investing. */
@Module({
  imports: [ResearchCoreModule, LocalAgentsModule],
  providers: [PortfolioResearchRouteService],
  exports: [PortfolioResearchRouteService],
})
export class ResearchRoutingModule {}
