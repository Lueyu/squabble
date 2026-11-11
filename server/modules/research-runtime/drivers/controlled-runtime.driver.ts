import { Inject, Injectable } from '@nestjs/common';
import { ModelStepService } from '../../research-core/model-step.service';
import type { ModelStepPort } from '../../research-core/model-step.interface';
import { ResearchRuntimeService } from '../research-runtime.service';
import type { RuntimeExecuteInput, RuntimeExecuteResult, RuntimeLoopPorts } from '../research-runtime.service';
import { RuntimeJournalService } from '../runtime-journal.service';
import { RuntimeInvocationsService } from '../runtime-invocations.service';
import type { RuntimeDriver } from './runtime-driver.interface';

/** The default loop is exposed through the same explicit per-run driver contract. */
@Injectable()
export class ControlledRuntimeDriver implements RuntimeDriver {
  readonly id = 'controlled' as const;
  constructor(private readonly journal: RuntimeJournalService,
    @Inject(ModelStepService) private readonly model: ModelStepPort,
    private readonly invocations: RuntimeInvocationsService) {}
  async execute(input: RuntimeExecuteInput, ports: RuntimeLoopPorts): Promise<RuntimeExecuteResult> {
    if ((await this.journal.read(input.owner, input.runId)).driver !== 'controlled') throw new Error('RUNTIME_DRIVER_MISMATCH');
    return new ResearchRuntimeService(this.journal, this.model, this.invocations, ports).execute(input);
  }
}
