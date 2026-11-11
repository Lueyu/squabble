import type { E2bComputeInput, ComputeOutput } from './e2b.adapter';

export type ComputeProviderName = 'local-container' | 'e2b';
export interface ComputeProvider {
  readonly provider: ComputeProviderName;
  status(): 'configured' | 'unconfigured';
  template(): { id: string; version: string } | null;
  kill(sandboxId: string): Promise<boolean>;
  run(input: E2bComputeInput, created: (sandboxId: string) => Promise<void>, shouldContinue?: () => Promise<boolean>): Promise<{
    files: ComputeOutput[]; stdout: string; stderr: string; sandboxId: string; terminationConfirmed: true;
  }>;
}
