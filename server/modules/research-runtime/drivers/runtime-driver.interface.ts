import type { RuntimeExecuteInput, RuntimeExecuteResult, RuntimeLoopPorts } from '../research-runtime.service';

export interface RuntimeDriver {
  readonly id: 'controlled' | 'deep_agents';
  execute(input: RuntimeExecuteInput, ports: RuntimeLoopPorts): Promise<RuntimeExecuteResult>;
}
