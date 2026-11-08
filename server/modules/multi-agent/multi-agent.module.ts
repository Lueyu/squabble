import { Module } from '@nestjs/common';
import { FxModule } from '../fx/fx.module';
import { ResearchCoreModule } from '../research-core/research-core.module';
import { BatchService } from './batch.service';
import { MultiAgentController } from './multi-agent.controller';
import { MultiAgentService } from './multi-agent.service';
import { PipelineService } from './pipeline.service';
import { PortfolioAnalysisController } from './portfolio-analysis.controller';
import { PortfolioAnalysisService } from './portfolio-analysis.service';

/**
 * Retained run/pipeline APIs and portfolio report lifecycle. Shared model and
 * evidence adapters belong to ResearchCoreModule; current callers import that
 * module directly rather than depending on these retained controllers.
 */
@Module({
  imports: [ResearchCoreModule, FxModule],
  controllers: [MultiAgentController, PortfolioAnalysisController],
  providers: [
    MultiAgentService,
    PipelineService,
    BatchService,
    PortfolioAnalysisService,
  ],
  exports: [MultiAgentService, PortfolioAnalysisService],
})
export class MultiAgentModule {}
