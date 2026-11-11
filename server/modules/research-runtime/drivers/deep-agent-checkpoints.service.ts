import { ConflictException, Inject, Injectable, Optional } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { ModelMessage } from 'ai';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '../../../common/platform';
import { agentRuntimeRuns } from '../../../database/agent-tooling.schema';
import { deepAgentDriverCheckpoints as checkpoints } from '../../../database/deep-agent-driver.schema';
import { decryptSecret, encryptSecret } from '../../settings/settings-security';
import { lockMemoryOwner } from '../../research-memory/research-memory.fence';
import { canonicalHash } from '../../../common/agent-contract';

export interface DeepAgentCheckpoint { stepIndex: number; messages: ModelMessage[] }
@Injectable()
export class DeepAgentCheckpointsService {
  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    @Optional() @Inject('RUNTIME_ENCRYPTION_KEY') private readonly configuredKey?: string) {}
  private key(): string {
    const value = this.configuredKey ?? process.env.SETTINGS_ENCRYPTION_KEY ?? process.env.JWT_SECRET;
    if (!value || value.length < 16) throw new Error('RUNTIME_ENCRYPTION_KEY_REQUIRED');
    return value;
  }
  async load(owner: string, runId: string, contextHash: string): Promise<DeepAgentCheckpoint | null> {
    const [row] = await this.db.select().from(checkpoints).where(and(eq(checkpoints.owner, owner), eq(checkpoints.runId, runId)));
    if (!row) return null;
    if (row.contextHash !== contextHash) throw new ConflictException('DEEP_AGENT_CONTEXT_CONFLICT');
    const payload = JSON.parse(decryptSecret(row.transcriptEnc, this.key())) as DeepAgentCheckpoint;
    if (canonicalHash(payload) !== row.transcriptHash) throw new Error('DEEP_AGENT_CHECKPOINT_CORRUPT');
    return payload;
  }
  async save(owner: string, runId: string, token: string, contextHash: string, payload: DeepAgentCheckpoint): Promise<void> {
    const text = JSON.stringify(payload), transcriptHash = canonicalHash(payload);
    if (Buffer.byteLength(text) > 512_000) throw new Error('DEEP_AGENT_CHECKPOINT_LIMIT');
    const transcriptEnc = encryptSecret(text, this.key());
    await this.db.transaction(async tx => {
      await lockMemoryOwner(tx, owner);
      const [run] = await tx.select().from(agentRuntimeRuns).where(and(eq(agentRuntimeRuns.owner, owner), eq(agentRuntimeRuns.id, runId))).for('update');
      if (!run || run.leaseToken !== token || !run.leaseUntil || run.leaseUntil <= new Date() || run.cancelRequested) throw new ConflictException('RUNTIME_LEASE_EXPIRED');
      const [prior] = await tx.select().from(checkpoints).where(and(eq(checkpoints.owner, owner), eq(checkpoints.runId, runId)));
      if (prior && (prior.contextHash !== contextHash || prior.stepIndex > payload.stepIndex
        || prior.stepIndex === payload.stepIndex && prior.transcriptHash !== transcriptHash)) throw new ConflictException('DEEP_AGENT_CHECKPOINT_CONFLICT');
      await tx.insert(checkpoints).values({ owner, runId, contextHash, stepIndex: payload.stepIndex, transcriptHash, transcriptEnc })
        .onConflictDoUpdate({ target: [checkpoints.owner, checkpoints.runId],
          set: { stepIndex: payload.stepIndex, transcriptHash, transcriptEnc, updatedAt: new Date() } });
    });
  }
}
