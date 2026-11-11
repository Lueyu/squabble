import { Module } from '@nestjs/common';
import { ResearchArtifactsModule } from '../research-artifacts/research-artifacts.module';
import { ComputeJobsService } from './compute-jobs.service';
import { E2bAdapter } from './e2b.adapter';
import { ResearchComputeController } from './research-compute.controller';
import { ResearchComputeService } from './research-compute.service';
import { ResearchComputeToolsService } from './research-compute-tools.service';
import { ComputeCleanupService } from './compute-cleanup.service';
import { LocalContainerAdapter } from './local-container.adapter';
import { ToolCapabilitiesModule } from '../tool-capabilities/tool-capabilities.module';

@Module({ imports: [ResearchArtifactsModule, ToolCapabilitiesModule], controllers: [ResearchComputeController],
  providers: [ComputeJobsService, E2bAdapter, LocalContainerAdapter, ResearchComputeService, ResearchComputeToolsService, ComputeCleanupService],
  exports: [ResearchComputeService, ResearchComputeToolsService, ComputeJobsService, ComputeCleanupService] })
export class ResearchComputeModule {}
