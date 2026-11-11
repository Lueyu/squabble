import { ConflictException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '../../common/platform';
import { agentRuntimeRuns as runs, agentRuntimeSteps as steps, agentToolInvocations as invocations } from '../../database/agent-tooling.schema';
import type { AgentToolDescriptor } from '../../../shared/agent-tooling.interface';
import type { RuntimeToolCall } from '../../../shared/research-runtime.interface';
import { decryptSecret, encryptSecret } from '../settings/settings-security';
import { canonicalHash } from './runtime-contract';
import { lockMemoryOwner } from '../research-memory/research-memory.fence';

export interface RuntimeInvocationInput {
  owner: string; runId: string; stepId: string; leaseToken: string;
  descriptor: AgentToolDescriptor; call: RuntimeToolCall;
}
export interface RuntimeInvocationResult { invocationId: string; result: unknown; reused: boolean }
export interface RuntimeInvocationHooks {
  authorizeWrite?(tx: Parameters<Parameters<PostgresJsDatabase['transaction']>[0]>[0],
    input: RuntimeInvocationInput & { invocationId: string }): Promise<void>;
  beforeDispatch?(tx: Parameters<Parameters<PostgresJsDatabase['transaction']>[0]>[0],
    input: RuntimeInvocationInput & { invocationId: string }): Promise<void>;
  received?(owner: string, invocationId: string, result: unknown): Promise<void>;
  unknown?(owner: string, invocationId: string): Promise<void>;
}
export class RuntimeInvocationUnknownError extends Error {
  constructor(readonly invocationId: string) { super('RUNTIME_TOOL_PROVIDER_UNKNOWN'); }
}

/** A committed invocation receipt authorizes one send. An uncertain receipt is never replayed. */
@Injectable()
export class RuntimeInvocationsService {
  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    @Optional() @Inject('RUNTIME_ENCRYPTION_KEY') private readonly configuredKey?: string) {}

  private key(): string {
    const key = this.configuredKey ?? process.env.SETTINGS_ENCRYPTION_KEY ?? process.env.JWT_SECRET;
    if (!key || key.length < 16) throw new Error('RUNTIME_ENCRYPTION_KEY_REQUIRED');
    return key;
  }
  private seal(value: unknown, maxBytes = 512_000): string {
    const text = JSON.stringify(value);
    if (!text || Buffer.byteLength(text) > maxBytes) throw new Error('RUNTIME_TOOL_PAYLOAD_LIMIT');
    return encryptSecret(text, this.key());
  }
  async count(owner: string, runId: string): Promise<number> {
    const rows = await this.db.select({ id: invocations.id }).from(invocations)
      .where(and(eq(invocations.owner, owner), eq(invocations.runId, runId)));
    return rows.length;
  }
  async assertResolved(owner: string, runId: string, stepId: string): Promise<void> {
    const rows = await this.db.select({ id: invocations.id, resultEnc: invocations.resultEnc }).from(invocations)
      .where(and(eq(invocations.owner, owner), eq(invocations.runId, runId), eq(invocations.stepId, stepId)));
    const unresolved = rows.find(row => !row.resultEnc);
    if (unresolved) throw new RuntimeInvocationUnknownError(unresolved.id);
  }
  async execute(input: RuntimeInvocationInput, invoke: (invocationId: string) => Promise<unknown>,
    hooks: RuntimeInvocationHooks = {}): Promise<RuntimeInvocationResult> {
    if (input.descriptor.effect === 'external_write' && !hooks.authorizeWrite) throw new Error('RUNTIME_TOOL_APPROVAL_REQUIRED');
    const argumentsHash = canonicalHash(input.call.arguments);
    const receipt = await this.db.transaction(async tx => {
      await lockMemoryOwner(tx, input.owner);
      const [run] = await tx.select().from(runs).where(and(eq(runs.owner, input.owner), eq(runs.id, input.runId))).for('update');
      if (!run) throw new NotFoundException('RUNTIME_NOT_FOUND');
      if (run.leaseToken !== input.leaseToken || !run.leaseUntil || run.leaseUntil <= new Date()) throw new ConflictException('RUNTIME_LEASE_EXPIRED');
      if (run.cancelRequested || !['running', 'result_received'].includes(run.state)) throw new ConflictException('RUNTIME_STATE_BLOCKS_TOOL');
      const [step] = await tx.select().from(steps).where(and(eq(steps.owner, input.owner), eq(steps.runId, input.runId), eq(steps.id, input.stepId)));
      if (!step || !step.responseEnc) throw new ConflictException('RUNTIME_TOOL_RESPONSE_REQUIRED');
      const [prior] = await tx.select().from(invocations).where(and(eq(invocations.owner, input.owner),
        eq(invocations.runId, input.runId), eq(invocations.stepId, input.stepId), eq(invocations.toolCallId, input.call.id)));
      if (prior) {
        if (prior.argumentsHash !== argumentsHash || prior.toolId !== input.call.toolId
          || prior.catalogVersionId !== input.descriptor.catalogVersionId) throw new ConflictException('RUNTIME_TOOL_IDENTITY_CONFLICT');
        return { row: prior, fresh: false };
      }
      const existing = await tx.select({ id: invocations.id }).from(invocations)
        .where(and(eq(invocations.owner, input.owner), eq(invocations.runId, input.runId)));
      if (existing.length >= Number(run.policy.maxInvocations ?? run.policy.maxTools ?? 24)) throw new Error('RUNTIME_INVOCATION_LIMIT');
      const invocationId = randomUUID();
      if (input.descriptor.effect === 'external_write') await hooks.authorizeWrite(tx, { ...input, invocationId });
      const [row] = await tx.insert(invocations).values({ id: invocationId, owner: input.owner, runId: input.runId,
        stepId: input.stepId, toolCallId: input.call.id, toolId: input.call.toolId,
        catalogVersionId: input.descriptor.catalogVersionId, argumentsHash,
        argumentsEnc: this.seal(input.call.arguments), state: 'dispatched' }).returning();
      if (hooks.beforeDispatch) await hooks.beforeDispatch(tx, { ...input, invocationId });
      return { row, fresh: true };
    });
    if (!receipt.fresh) {
      if (!receipt.row.resultEnc) throw new RuntimeInvocationUnknownError(receipt.row.id);
      const result: unknown = JSON.parse(decryptSecret(receipt.row.resultEnc, this.key()));
      await hooks.received?.(input.owner, receipt.row.id, result);
      return { invocationId: receipt.row.id, result, reused: true };
    }
    let result: unknown;
    try {
      result = await invoke(receipt.row.id);
      const resultEnc = this.seal(result, input.descriptor.maxOutputBytes);
      await this.db.update(invocations).set({ resultEnc, state: 'result_received', updatedAt: new Date() })
        .where(and(eq(invocations.owner, input.owner), eq(invocations.id, receipt.row.id)));
    } catch {
      await this.db.update(invocations).set({ state: 'provider_unknown', updatedAt: new Date() })
        .where(and(eq(invocations.owner, input.owner), eq(invocations.id, receipt.row.id)));
      await hooks.unknown?.(input.owner, receipt.row.id);
      throw new RuntimeInvocationUnknownError(receipt.row.id);
    }
    await hooks.received?.(input.owner, receipt.row.id, result);
    return { invocationId: receipt.row.id, result, reused: false };
  }
}
