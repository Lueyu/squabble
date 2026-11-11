import { Module } from '@nestjs/common';
import { ToolConnectionsModule } from '../tool-connections/tool-connections.module';
import { ToolCapabilityGrantsService } from './tool-capability-grants.service';
import { ToolCapabilityReadinessService } from './tool-capability-readiness.service';
import { ToolCapabilitiesController } from './tool-capabilities.controller';
import { ToolCapabilitiesService } from './tool-capabilities.service';
@Module({ imports: [ToolConnectionsModule], controllers: [ToolCapabilitiesController],
  providers: [ToolCapabilitiesService, ToolCapabilityGrantsService, ToolCapabilityReadinessService],
  exports: [ToolCapabilityGrantsService] })
export class ToolCapabilitiesModule {}
