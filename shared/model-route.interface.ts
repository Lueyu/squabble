import type { NativeAgentConfiguration } from './local-agents.interface';

/** A credential-free execution choice that can be saved with a run. */
export type ModelRoute =
  | { mode: 'basic' }
  | { mode: 'api' }
  | { mode: 'local'; agentId: string; agentSettings?: NativeAgentConfiguration };
