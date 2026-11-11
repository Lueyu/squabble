import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import type { AgentToolScope } from '../../../shared/agent-tooling.interface';
import { DataDatasetService } from '../data-library/data-dataset.service';
import { hashContent } from '../research-artifacts/research-artifacts.rules';
import { ResearchComputeService } from './research-compute.service';

const toolInputSchema = z.object({ datasetVersionIds: z.array(z.uuid()).min(1).max(20),
  parameters: z.record(z.string(), z.unknown()), seed: z.number().int().min(0).max(2_147_483_647),
  maxRuntimeMs: z.number().int().min(1000).max(120_000).optional(),
}).strict();

/** Runtime ownership, request identity and expected hashes are injected, never model-authorized. */
@Injectable()
export class ResearchComputeToolsService {
  constructor(private readonly datasets: DataDatasetService, private readonly compute: ResearchComputeService) {}

  async invoke(owner: string, kind: 'statistics' | 'backtest', raw: unknown, scope: AgentToolScope, signal?: AbortSignal) {
    if (scope.owner !== owner) throw new Error('COMPUTE_SCOPE_MISMATCH');
    const input = toolInputSchema.parse(raw), hashes: Record<string, string> = {};
    for (const id of input.datasetVersionIds) hashes[id] = (await this.datasets.read(owner, id)).contentHash;
    const job = await this.compute.run(owner, { ...input, runId: scope.runId, kind,
      requestKey: `tool:${scope.runId}:${hashContent({ kind, input })}`, expectedContentHashes: hashes }, scope, signal);
    return { status: job.state === 'succeeded' ? 'succeeded' as const : job.state === 'cancelled' ? 'cancelled' as const : 'unavailable' as const,
      data: job, sources: [], asOf: new Date().toISOString(), truncated: false,
      ...(job.state === 'succeeded' ? {} : { errorCode: job.errorCode ?? 'COMPUTE_NOT_COMPLETED' }) };
  }
}
