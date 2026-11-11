import { Module } from '@nestjs/common';
import { AiSdkModelAdapter } from '../research-core/ai-sdk-model.adapter';
import { ModelStepService } from '../research-core/model-step.service';
import { ResearchRuntimeService } from './research-runtime.service';
import { RuntimeDispatchService } from './runtime-dispatch.service';
import { RuntimeInvocationsService } from './runtime-invocations.service';
import { RuntimeJournalService } from './runtime-journal.service';
import { RuntimeReadController } from './runtime-read.controller';
import { RuntimeRecoveryService } from './runtime-recovery.service';
import { ModelCapabilityController } from './model-capability.controller';
import { ModelCapabilityService } from './model-capability.service';
import { DeepAgentsDriver } from './drivers/deep-agents.driver';
import { DeepAgentCheckpointsService } from './drivers/deep-agent-checkpoints.service';
import { ControlledRuntimeDriver } from './drivers/controlled-runtime.driver';

@Module({
  controllers: [RuntimeReadController, ModelCapabilityController],
  providers: [AiSdkModelAdapter, ModelStepService, RuntimeJournalService, RuntimeDispatchService,
    RuntimeInvocationsService, ResearchRuntimeService, RuntimeRecoveryService, ModelCapabilityService, DeepAgentsDriver, DeepAgentCheckpointsService,
    ControlledRuntimeDriver],
  exports: [ModelStepService, RuntimeJournalService, RuntimeDispatchService, RuntimeInvocationsService,
    ResearchRuntimeService, RuntimeRecoveryService, ModelCapabilityService, DeepAgentsDriver, DeepAgentCheckpointsService, ControlledRuntimeDriver],
})
export class ResearchRuntimeModule {}
