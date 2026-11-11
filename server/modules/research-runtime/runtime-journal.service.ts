import { ConflictException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '../../common/platform';
import { agentRuntimeEvents as events, agentRuntimeRuns as runs, agentRuntimeSteps as steps, agentToolInvocations as invocations } from '../../database/agent-tooling.schema';
import { decryptSecret, encryptSecret } from '../settings/settings-security';
import { assertFrozenInputSnapshot, assertRuntimeExecutionPolicy, canonicalHash } from './runtime-contract';
import type { RuntimeFrozenInputSnapshot, RuntimeIdentity } from '../../../shared/research-runtime.interface';
import { lockMemoryOwner } from '../research-memory/research-memory.fence';

type Tx = Parameters<Parameters<PostgresJsDatabase['transaction']>[0]>[0];
type Run = typeof runs.$inferSelect;
export interface CreateRuntimeRun {
  identity: RuntimeIdentity;
  driver: 'controlled' | 'deep_agents'; frozenInput: RuntimeFrozenInputSnapshot; policy: Record<string, unknown>;
  initialRequest?: unknown;
}
export const runtimeContentHash = canonicalHash;
export type RuntimeBeforeDispatch = (tx: Tx, identity: { dispatchKey: string; requestHash: string }) => Promise<{ budgetId: string }>;

/** Durable receipts precede transport. Replaying a receipt never authorizes another send. */
@Injectable()
export class RuntimeJournalService {
  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    @Optional() @Inject('RUNTIME_ENCRYPTION_KEY') private readonly configuredKey?: string) {}

  private key(): string {
    const key = this.configuredKey ?? process.env.SETTINGS_ENCRYPTION_KEY ?? process.env.JWT_SECRET;
    if (!key || key.length < 16) throw new Error('RUNTIME_ENCRYPTION_KEY_REQUIRED');
    return key;
  }
  private seal(value: unknown): string {
    const text = JSON.stringify(value);
    if (!text || Buffer.byteLength(text) > 512_000) throw new Error('RUNTIME_PAYLOAD_LIMIT');
    return encryptSecret(text, this.key());
  }
  private open(value: string): unknown { return JSON.parse(decryptSecret(value, this.key())); }
  private async locked(tx: Tx, owner: string, id: string): Promise<Run> {
    await lockMemoryOwner(tx, owner);
    const [row] = await tx.select().from(runs).where(and(eq(runs.owner, owner), eq(runs.id, id))).for('update');
    if (!row) throw new NotFoundException('RUNTIME_NOT_FOUND');
    return row;
  }
  private assertLease(row: Run, token: string): void {
    if (row.leaseToken !== token || !row.leaseUntil || row.leaseUntil <= new Date()) throw new ConflictException('RUNTIME_LEASE_EXPIRED');
  }
  private async hasPending(tx: Tx, owner: string, id: string): Promise<boolean> {
    const models = await tx.select({ id: steps.id }).from(steps).where(and(eq(steps.owner, owner), eq(steps.runId, id), eq(steps.state, 'dispatched'))).limit(1);
    const tools = await tx.select({ id: invocations.id }).from(invocations).where(and(eq(invocations.owner, owner), eq(invocations.runId, id),
      inArray(invocations.state, ['dispatched', 'provider_unknown']), isNull(invocations.resultEnc))).limit(1);
    return Boolean(models.length || tools.length);
  }
  private async state(tx: Tx, row: Run, state: string, kind: string, stepId?: string, code?: string,
    audit?: { parseAttemptId: string; responseHash: string; parserVersion: string }): Promise<void> {
    await tx.update(runs).set({ state, cursor: row.cursor + 1, updatedAt: new Date() })
      .where(and(eq(runs.owner, row.owner), eq(runs.id, row.id)));
    await tx.insert(events).values({ owner: row.owner, runId: row.id, stepId, kind, code, ...audit });
  }
  async create(input: CreateRuntimeRun): Promise<Run> {
    assertFrozenInputSnapshot(input.frozenInput); assertRuntimeExecutionPolicy(input.policy);
    const identityHash = runtimeContentHash(input.identity), frozenInputHash = runtimeContentHash(input.frozenInput);
    const initialRequestHash = input.initialRequest ? canonicalHash(input.initialRequest) : null;
    const id = randomUUID(), frozenInputEnc = this.seal(input.frozenInput);
    await this.db.insert(runs).values({ id, owner: input.identity.owner, identityHash, identity: { ...input.identity },
      driver: input.driver, frozenInputHash, frozenInputEnc, policy: input.policy,
      initialRequestHash, initialRequestEnc: input.initialRequest ? this.seal(input.initialRequest) : null }).onConflictDoNothing();
    const [row] = await this.db.select().from(runs).where(and(eq(runs.owner, input.identity.owner), eq(runs.identityHash, identityHash)));
    if (row.frozenInputHash !== frozenInputHash || row.initialRequestHash !== initialRequestHash || row.driver !== input.driver || runtimeContentHash(row.policy) !== runtimeContentHash(input.policy)) {
      throw new ConflictException('RUNTIME_INPUT_CONFLICT');
    }
    return row;
  }
  async read(owner: string, id: string) {
    const [row] = await this.db.select().from(runs).where(and(eq(runs.owner, owner), eq(runs.id, id)));
    if (!row) throw new NotFoundException('RUNTIME_NOT_FOUND');
    const records = await this.db.select().from(steps).where(and(eq(steps.owner, owner), eq(steps.runId, id))).orderBy(asc(steps.stepIndex));
    return { ...row, frozenInput: this.open(row.frozenInputEnc), initialRequest: row.initialRequestEnc ? this.open(row.initialRequestEnc) : null, steps: records };
  }
  async find(identity: RuntimeIdentity) {
    const [row] = await this.db.select().from(runs).where(and(eq(runs.owner, identity.owner), eq(runs.identityHash, canonicalHash(identity))));
    return row ? this.read(identity.owner, row.id) : null;
  }
  async freezeEvidence<T>(owner: string, runId: string, stepId: string, evidence: T): Promise<T> {
    return this.db.transaction(async tx => {
      await this.locked(tx, owner, runId);
      const rows = await tx.execute(sql`select content_enc from agent_runtime_evidence_snapshots where owner=${owner} and run_id=${runId} and step_id=${stepId}`);
      if (rows.length) return this.open(String(rows[0].content_enc)) as T;
      await tx.execute(sql`insert into agent_runtime_evidence_snapshots(owner,run_id,step_id,content_hash,content_enc)
        values(${owner},${runId},${stepId},${canonicalHash(evidence)},${this.seal(evidence)})`);
      return evidence;
    });
  }
  async claim(owner: string, id: string): Promise<{ token: string } | null> {
    return this.db.transaction(async tx => {
      const row = await this.locked(tx, owner, id);
      if (row.cancelRequested || !['queued', 'running', 'result_received', 'failed'].includes(row.state) || row.leaseUntil && row.leaseUntil > new Date()) return null;
      if (await this.hasPending(tx, owner, id)) { await this.state(tx, row, 'provider_unknown', 'lease_expired_after_dispatch'); return null; }
      const token = randomUUID();
      await tx.update(runs).set({ leaseToken: token, leaseUntil: new Date(Date.now() + 60_000),
        state: row.state === 'queued' ? 'running' : row.state }).where(and(eq(runs.owner, owner), eq(runs.id, id)));
      return { token };
    });
  }
  async heartbeat(owner: string, id: string, token: string): Promise<void> {
    await this.db.transaction(async tx => {
      const row = await this.locked(tx, owner, id); this.assertLease(row, token);
      await tx.update(runs).set({ leaseUntil: new Date(Date.now() + 60_000) }).where(and(eq(runs.owner, owner), eq(runs.id, id)));
    });
  }
  async beginStep(owner: string, id: string, token: string, input: { index: number; request: unknown; model: string }, beforeDispatch?: RuntimeBeforeDispatch) {
    const requestHash = runtimeContentHash(input.request), requestEnc = this.seal(input.request);
    return this.db.transaction(async tx => {
      const row = await this.locked(tx, owner, id); this.assertLease(row, token);
      if (row.cancelRequested || !['running', 'result_received'].includes(row.state)) throw new ConflictException('RUNTIME_STATE_BLOCKS_DISPATCH');
      if (!Number.isSafeInteger(input.index) || input.index < 0 || input.index >= Number(row.policy.maxSteps ?? 6)) throw new Error('RUNTIME_STEP_LIMIT');
      const [prior] = await tx.select().from(steps).where(and(eq(steps.owner, owner), eq(steps.runId, id), eq(steps.stepIndex, input.index)));
      if (prior) {
        if (prior.requestHash !== requestHash || prior.model !== input.model) throw new ConflictException('RUNTIME_REQUEST_CONFLICT');
        return { step: prior, fresh: false };
      }
      const previous = await tx.select().from(steps).where(and(eq(steps.owner, owner), eq(steps.runId, id))).orderBy(asc(steps.stepIndex));
      if (input.index !== previous.length || previous.length && previous.at(-1)?.state !== 'parsed') {
        throw new ConflictException('RUNTIME_STEP_ORDER_OR_IN_FLIGHT');
      }
      const dispatchKey = `${id}:model:${input.index}`;
      const budget = await beforeDispatch?.(tx, { dispatchKey, requestHash });
      const [step] = await tx.insert(steps).values({ id: randomUUID(), owner, runId: id, stepIndex: input.index,
        dispatchKey, requestHash, requestEnc, model: input.model, budgetId: budget?.budgetId }).returning();
      await this.state(tx, row, 'running', 'dispatch_intent', step.id);
      return { step, fresh: true };
    });
  }
  async receive(owner: string, id: string, stepId: string, response: unknown): Promise<void> {
    const responseEnc = this.seal(response), responseHash = runtimeContentHash(response);
    const metadata = response && typeof response === 'object' ? response as { usage?: unknown; providerRequestId?: unknown } : null;
    await this.db.transaction(async tx => {
      const row = await this.locked(tx, owner, id);
      const [step] = await tx.select().from(steps).where(and(eq(steps.owner, owner), eq(steps.runId, id), eq(steps.id, stepId))).for('update');
      if (!step) throw new NotFoundException('RUNTIME_STEP_NOT_FOUND');
      if (step.responseHash) {
        if (step.responseHash !== responseHash) throw new ConflictException('RUNTIME_RESPONSE_CONFLICT');
        return;
      }
      await tx.update(steps).set({ responseEnc, responseHash, state: 'result_received', usage: metadata?.usage ?? null,
        providerRequestId: typeof metadata?.providerRequestId === 'string' ? metadata.providerRequestId : null })
        .where(and(eq(steps.owner, owner), eq(steps.id, stepId)));
      const next = ['cancelled', 'settled_unknown', 'accepted'].includes(row.state) ? row.state : row.cancelRequested ? 'cancelled' : 'result_received';
      await this.state(tx, row, next, 'result_received', stepId);
    });
  }
  async response(owner: string, id: string, stepId: string): Promise<unknown> {
    await this.read(owner, id);
    const [step] = await this.db.select().from(steps).where(and(eq(steps.owner, owner), eq(steps.runId, id), eq(steps.id, stepId)));
    if (!step?.responseEnc) throw new NotFoundException('RUNTIME_RESPONSE_NOT_FOUND');
    return this.open(step.responseEnc);
  }
  async recordParse(owner: string, id: string, stepId: string, valid: boolean, code: string | null,
    options: { leaseToken: string; expectedCursor?: number; parserVersion?: string }): Promise<void> {
    await this.db.transaction(async tx => {
      const row = await this.locked(tx, owner, id);
      this.assertLease(row, options.leaseToken);
      if (options.expectedCursor !== undefined && row.cursor !== options.expectedCursor) throw new ConflictException('RUNTIME_CURSOR_CONFLICT');
      if (row.cancelRequested || !['result_received', 'failed'].includes(row.state)) throw new ConflictException('RUNTIME_STATE_BLOCKS_REPARSE');
      const target = await tx.select().from(steps).where(and(eq(steps.owner, owner), eq(steps.runId, id))).orderBy(asc(steps.stepIndex));
      if (target.at(-1)?.id !== stepId) throw new ConflictException('RUNTIME_REPARSE_TARGET_CONFLICT');
      const [step] = await tx.select().from(steps).where(and(eq(steps.owner, owner), eq(steps.runId, id), eq(steps.id, stepId)));
      if (!step?.responseEnc) throw new Error('RUNTIME_RESPONSE_REQUIRED');
      await tx.update(steps).set({ state: valid ? 'parsed' : 'parse_failed' }).where(and(eq(steps.owner, owner), eq(steps.id, stepId)));
      await this.state(tx, row, valid ? 'result_received' : 'failed', valid ? 'parse_accepted' : 'parse_failed', stepId, code ?? undefined,
        { parseAttemptId: randomUUID(), responseHash: step.responseHash!, parserVersion: options.parserVersion ?? 'controlled-v1' });
    });
  }
  async accept(owner: string, id: string, token: string): Promise<void> {
    await this.db.transaction(async tx => {
      const row = await this.locked(tx, owner, id); this.assertLease(row, token);
      if (row.cancelRequested || row.state !== 'result_received') throw new ConflictException('RUNTIME_STATE_BLOCKS_ACCEPT');
      const target = await tx.select().from(steps).where(and(eq(steps.owner, owner), eq(steps.runId, id))).orderBy(asc(steps.stepIndex));
      if (!target.length || target.some(step => step.state !== 'parsed')) throw new ConflictException('RUNTIME_VALIDATION_REQUIRED');
      await this.state(tx, row, 'accepted', 'accepted');
    });
  }
  async cancel(owner: string, id: string): Promise<void> {
    await this.db.transaction(async tx => {
      const row = await this.locked(tx, owner, id);
      if (['accepted', 'cancelled', 'settled_unknown'].includes(row.state)) return;
      await tx.update(runs).set({ cancelRequested: true }).where(and(eq(runs.owner, owner), eq(runs.id, id)));
      await this.state(tx, row, await this.hasPending(tx, owner, id) ? 'provider_unknown' : 'cancelled', 'cancel_requested');
    });
  }
  async recover(owner: string, id: string): Promise<string> {
    return this.db.transaction(async tx => (await this.recoverInTransaction(tx, owner, id)).state);
  }
  async recoverInTransaction(tx: Tx, owner: string, id: string): Promise<{ state: string; cursor: number }> {
    const row = await this.locked(tx, owner, id);
    if (row.state !== 'running' || row.leaseUntil && row.leaseUntil > new Date()) return { state: row.state, cursor: row.cursor };
    const next = await this.hasPending(tx, owner, id) ? 'provider_unknown' : 'queued';
    await this.state(tx, row, next, 'recovered');
    return { state: next, cursor: row.cursor + 1 };
  }
  async settleUnknown(owner: string, id: string): Promise<void> {
    await this.db.transaction(async tx => {
      const row = await this.locked(tx, owner, id);
      if (row.state !== 'provider_unknown') throw new ConflictException('RUNTIME_STATE_BLOCKS_SETTLEMENT');
      await this.state(tx, row, 'settled_unknown', 'closed_with_unknown_provider_cost');
    });
  }
  async parkApproval(owner: string, id: string, token: string): Promise<void> {
    await this.db.transaction(async tx => {
      const row = await this.locked(tx, owner, id); this.assertLease(row, token);
      if (row.cancelRequested || !['running', 'result_received'].includes(row.state)) throw new ConflictException('RUNTIME_STATE_BLOCKS_APPROVAL');
      await this.state(tx, row, 'waiting_approval', 'waiting_approval');
    });
  }
  async resumeApproval(owner: string, id: string, authorize: (tx: Tx) => Promise<void>): Promise<void> {
    await this.db.transaction(async tx => {
      const row = await this.locked(tx, owner, id);
      if (row.cancelRequested || row.state !== 'waiting_approval') throw new ConflictException('RUNTIME_STATE_BLOCKS_APPROVAL');
      if (row.leaseUntil && row.leaseUntil > new Date()) throw new ConflictException('RUNTIME_APPROVAL_WORKER_ACTIVE');
      if (typeof authorize !== 'function') throw new ConflictException('RUNTIME_APPROVAL_RECEIPT_REQUIRED');
      await authorize(tx);
      await this.state(tx, row, 'running', 'approval_resumed');
      await tx.update(runs).set({ leaseToken: null, leaseUntil: null }).where(and(eq(runs.owner, owner), eq(runs.id, id)));
    });
  }
  /** Parent Council resume and child receipt authorization share one transaction. */
  async authorizeResume(tx: Tx, owner: string, id: string, input: {
    action: 'resume_approval' | 'reparse_existing' | 'close_unknown'; expectedCursor: number; stepId?: string;
  }, authorize: (tx: Tx) => Promise<void>): Promise<void> {
    const row = await this.locked(tx, owner, id);
    if (row.cursor !== input.expectedCursor) throw new ConflictException('RUNTIME_CURSOR_CONFLICT');
    if (row.leaseUntil && row.leaseUntil > new Date()) throw new ConflictException('RUNTIME_WORKER_ACTIVE');
    if (input.action === 'close_unknown') {
      if (row.state !== 'provider_unknown') throw new ConflictException('RUNTIME_STATE_BLOCKS_SETTLEMENT');
      await this.state(tx, row, 'settled_unknown', 'closed_with_unknown_provider_cost');
      return;
    }
    if (row.cancelRequested) throw new ConflictException('RUNTIME_CANCELLED');
    if (input.action === 'resume_approval') {
      if (row.state !== 'waiting_approval') throw new ConflictException('RUNTIME_STATE_BLOCKS_APPROVAL');
      await authorize(tx);
      await this.state(tx, row, 'running', 'approval_resumed');
    } else {
      const target = await tx.select().from(steps).where(and(eq(steps.owner, owner), eq(steps.runId, id))).orderBy(asc(steps.stepIndex));
      const last = target.at(-1);
      if (row.state !== 'failed' || !last?.responseEnc || last.state !== 'parse_failed' || input.stepId && last.id !== input.stepId) {
        throw new ConflictException('RUNTIME_REPARSE_TARGET_CONFLICT');
      }
      await this.state(tx, row, 'failed', 'saved_response_reparse_requested', last.id);
    }
    await tx.update(runs).set({ leaseToken: null, leaseUntil: null }).where(and(eq(runs.owner, owner), eq(runs.id, id)));
  }
  async release(owner: string, id: string, token: string): Promise<void> {
    await this.db.transaction(async tx => {
      const row = await this.locked(tx, owner, id);
      if (row.leaseToken !== token) throw new ConflictException('RUNTIME_LEASE_EXPIRED');
      await tx.update(runs).set({ leaseToken: null, leaseUntil: null }).where(and(eq(runs.owner, owner), eq(runs.id, id)));
    });
  }
  async markUnknown(owner: string, id: string, token: string, code: string): Promise<void> {
    await this.db.transaction(async tx => {
      const row = await this.locked(tx, owner, id); this.assertLease(row, token);
      if (['cancelled', 'accepted', 'settled_unknown'].includes(row.state)) return;
      await this.state(tx, row, 'provider_unknown', 'dispatch_unknown', undefined, code);
    });
  }
  async fail(owner: string, id: string, token: string, code: string): Promise<void> {
    await this.db.transaction(async tx => {
      const row = await this.locked(tx, owner, id); this.assertLease(row, token);
      if (['cancelled', 'accepted', 'settled_unknown'].includes(row.state)) return;
      await this.state(tx, row, await this.hasPending(tx, owner, id) ? 'provider_unknown' : 'failed', 'run_failed', undefined, code);
    });
  }
}
