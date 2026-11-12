import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '../../common/platform';
import { a2aAgentConnections as connections, a2aAgentInvocations as invocations, a2aAgentRequests as requests } from '../../database/a2a-agents.schema';
import { assertA2aConnectionFingerprint, readA2aConnectionFingerprint } from '../../database/a2a-agent-context';
import type { TeamDatabase } from '../../database/team-context';
import type { A2aConnection, A2aConnectionFingerprint, A2aTaskReceipt } from '../../../shared/a2a-agents.interface';
import { decryptSecret, encryptSecret } from '../settings/settings-security';
import { A2aProtocolAdapter, registeredA2aServices } from './a2a-protocol.adapter';
import { LlmBudgetService } from '../llm-budget/llm-budget.service';
import { captureTelemetry, TelemetryCaptureService } from '../telemetry/telemetry-capture.service';
import type { TelemetryDimensions, TelemetrySpanRecord } from '../../../shared/telemetry.interface';

const uuid = z.uuid(), key = z.string().trim().min(1).max(160);
const hash = (value: unknown) => {
  const canonical = (input: unknown): unknown => Array.isArray(input) ? input.map(canonical)
    : input && typeof input === 'object' ? Object.fromEntries(Object.entries(input).filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => a.localeCompare(b)).map(([name, entry]) => [name, canonical(entry)])) : input;
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
};
const secretKey = () => {
  const value = process.env.SETTINGS_ENCRYPTION_KEY || process.env.JWT_SECRET;
  if (!value || value.length < 16) throw new Error('A2A_ENCRYPTION_KEY_REQUIRED');
  return value;
};
const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const result = schema.safeParse(value);
  if (!result.success) throw new BadRequestException({ code: 'A2A_INVALID_INPUT', message: 'Check the external assistant connection settings' });
  return result.data;
};
type ConnectionRow = typeof connections.$inferSelect;
type InvocationRow = typeof invocations.$inferSelect;
const terminal = (state: string) => ['completed', 'failed', 'cancelled', 'rejected', 'input_required', 'auth_required'].includes(state);
const settled = (state: string) => ['completed', 'failed', 'cancelled', 'rejected'].includes(state);
export class A2aExecutionError extends Error {
  constructor(readonly code: string, readonly taskId?: string, readonly contextId?: string) { super(code); this.name = 'A2aExecutionError'; }
}
export interface A2aExecution {
  connectionId: string; messageId: string; prompt: string; fingerprint?: A2aConnectionFingerprint;
  timeoutMs?: number; pollIntervalMs?: number;
  budgetTaskId?: string; budgetPurpose?: string;
  activityContext?: TelemetryDimensions & { sessionId: string; revision: number; cycleId: string; parentId?: string; attempt?: number };
  onDispatch?(submission?: { inputBytes: number }): Promise<void>;
  withHandoff?(handoff: () => Promise<void>): Promise<void>;
  onTask?(ref: { taskId: string; contextId: string }): Promise<void>;
  shouldContinue?(): Promise<boolean>;
}
export interface A2aExecutionResult {
  taskId: string; remoteTaskId?: string; contextId?: string; text: string; data?: unknown;
  usageTokens: null; externalUsageUnknown: true;
}
function view(row: ConnectionRow): A2aConnection {
  return { id: row.id, name: row.name, cardUrl: row.cardUrl, revision: row.revision, status: row.status as A2aConnection['status'],
    cardHash: row.cardHash, protocolVersion: '1.0', interfaceUrl: row.interfaceUrl, ...(row.tenant ? { tenant: row.tenant } : {}),
    cardName: row.cardName, cardVersion: row.cardVersion, skills: row.skills, capabilities: row.capabilities,
    credentialConfigured: Boolean(row.secretEnc), localEndpoint: row.localEndpoint, updatedAt: row.updatedAt.toISOString() };
}
function receipt(row: InvocationRow): A2aTaskReceipt {
  return { id: row.id, connectionId: row.connectionId, messageId: row.messageId, remoteTaskId: row.remoteTaskId, contextId: row.contextId,
    state: row.state, acceptance: row.acceptance as A2aTaskReceipt['acceptance'], cancellation: row.cancellation as A2aTaskReceipt['cancellation'],
    externalUsageUnknown: true, externalCostUnknown: true, modelKnown: false, toolsKnown: false,
    outputBytes: row.outputBytes, failureCode: row.failureCode, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
}

/** Owns protocol transport and durable correlation, never workflow scheduling or publication. */
@Injectable()
export class A2aAgentsService {
  private readonly adapter: A2aProtocolAdapter;
  constructor(@Inject(DRIZZLE_DATABASE) readonly db: PostgresJsDatabase, @Optional() adapter?: A2aProtocolAdapter,
    @Optional() private readonly budgets?: LlmBudgetService, @Optional() private readonly telemetry?: TelemetryCaptureService) { this.adapter = adapter ?? new A2aProtocolAdapter(); }
  private async lock(tx: TeamDatabase, owner: string) { await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${owner}, 734964))`); }
  private async connection(owner: string, id: string, tx: TeamDatabase = this.db): Promise<ConnectionRow> {
    parse(uuid, id);
    const [row] = await tx.select().from(connections).where(and(eq(connections.owner, owner), eq(connections.id, id)));
    if (!row) throw new NotFoundException('A2A_CONNECTION_NOT_FOUND');
    return row;
  }
  private async invocation(owner: string, id: string): Promise<InvocationRow> {
    parse(uuid, id);
    const [row] = await this.db.select().from(invocations).where(and(eq(invocations.owner, owner), eq(invocations.id, id)));
    if (!row) throw new NotFoundException('A2A_TASK_NOT_FOUND');
    return row;
  }
  private async patch(row: InvocationRow, changes: Partial<typeof invocations.$inferInsert>): Promise<InvocationRow> {
    return this.db.transaction(async tx => {
      const [current] = await tx.select().from(invocations).where(and(eq(invocations.owner, row.owner), eq(invocations.id, row.id))).for('update');
      // A stale caller cannot undo terminal settlement or its acceptance/error metadata.
      const update = { ...changes };
      if (settled(current.state) && update.state && update.state !== current.state) return current;
      if (settled(current.state) && !settled(row.state)) {
        if (update.cancellation === 'refused' && current.state !== 'cancelled') {
          const [saved] = await tx.update(invocations).set({ cancellation: 'refused', updatedAt: new Date() })
            .where(and(eq(invocations.owner, row.owner), eq(invocations.id, row.id))).returning();
          return saved;
        }
        return current;
      }
      const [saved] = await tx.update(invocations).set({ ...update, updatedAt: new Date() }).where(and(eq(invocations.owner, row.owner), eq(invocations.id, row.id))).returning();
      return saved;
    });
  }
  private async mutate<T>(owner: string, requestKey: string, input: unknown, action: (tx: TeamDatabase) => Promise<T>): Promise<T> {
    const inputHash = hash(input);
    return this.db.transaction(async tx => {
      await this.lock(tx, owner);
      const [prior] = await tx.select().from(requests).where(and(eq(requests.owner, owner), eq(requests.requestKey, requestKey)));
      if (prior) { if (prior.inputHash !== inputHash) throw new ConflictException('A2A_REQUEST_KEY_CONFLICT'); return prior.result as T; }
      const result = await action(tx);
      await tx.insert(requests).values({ owner, requestKey, inputHash, result });
      return result;
    });
  }
  async list(owner: string): Promise<{ items: A2aConnection[] }> {
    return { items: (await this.db.select().from(connections).where(eq(connections.owner, owner)).orderBy(desc(connections.updatedAt)).limit(100)).map(view) };
  }
  async detail(owner: string, id: string) { return view(await this.connection(owner, id)); }
  async create(owner: string, input: unknown): Promise<A2aConnection> {
    const body = parse(z.object({ requestKey: key, name: z.string().trim().min(1).max(100), cardUrl: z.url().max(500), credential: z.string().min(1).max(8000).optional(), trustLocalEndpoint: z.boolean().default(false) }).strict(), input);
    return this.mutate(owner, body.requestKey, { operation: 'create', body }, async tx => {
      const cardUrl = await this.adapter.policy.normalizeEndpoint(body.cardUrl);
      const local = registeredA2aServices().some(service => service.endpoint === cardUrl);
      if (local && !body.trustLocalEndpoint) throw new BadRequestException('A2A_LOCAL_TRUST_REQUIRED');
      const card = await this.adapter.discover(cardUrl, body.credential);
      const [row] = await tx.insert(connections).values({ owner, name: body.name, cardUrl, ...card, tenant: card.tenant ?? null,
        localEndpoint: local, secretEnc: body.credential ? encryptSecret(body.credential, secretKey()) : null }).returning();
      return view(row);
    });
  }
  async update(owner: string, id: string, input: unknown) {
    const body = parse(z.object({ requestKey: key, expectedRevision: z.number().int().positive(), name: z.string().trim().min(1).max(100).optional(), credential: z.string().max(8000).optional() }).strict(), input);
    return this.mutate(owner, body.requestKey, { operation: 'update', id, body }, async tx => {
      const row = await this.connection(owner, id, tx); this.revision(row, body.expectedRevision);
      const [saved] = await tx.update(connections).set({ revision: row.revision + 1, name: body.name ?? row.name,
        ...(body.credential !== undefined ? { secretEnc: body.credential ? encryptSecret(body.credential, secretKey()) : null } : {}), updatedAt: new Date() }).where(and(eq(connections.owner, owner), eq(connections.id, id))).returning();
      return view(saved);
    });
  }
  private revision(row: ConnectionRow, expected: number) { if (row.revision !== expected) throw new ConflictException('A2A_REVISION_CONFLICT'); }
  async disable(owner: string, id: string, input: unknown) {
    const body = parse(z.object({ requestKey: key, expectedRevision: z.number().int().positive() }).strict(), input);
    return this.mutate(owner, body.requestKey, { operation: 'disable', id, body }, async tx => {
      const row = await this.connection(owner, id, tx); this.revision(row, body.expectedRevision);
      const [saved] = await tx.update(connections).set({ status: 'disabled', revision: row.revision + 1, updatedAt: new Date() }).where(and(eq(connections.owner, owner), eq(connections.id, id))).returning();
      return view(saved);
    });
  }
  async refreshCard(owner: string, id: string, input: unknown) {
    const body = parse(z.object({ requestKey: key, expectedRevision: z.number().int().positive() }).strict(), input);
    return this.mutate(owner, body.requestKey, { operation: 'refresh', id, body }, async tx => {
      const row = await this.connection(owner, id, tx); this.revision(row, body.expectedRevision);
      const card = await this.adapter.discover(row.cardUrl, row.secretEnc ? decryptSecret(row.secretEnc, secretKey()) : undefined);
      const [saved] = await tx.update(connections).set({ ...card, tenant: card.tenant ?? null, revision: row.revision + 1, updatedAt: new Date() }).where(and(eq(connections.owner, owner), eq(connections.id, id))).returning();
      return view(saved);
    });
  }
  resolveRuntimeFingerprint(owner: string, id: string) { return readA2aConnectionFingerprint(this.db, owner, id); }
  assertFingerprint(owner: string, fingerprint: A2aConnectionFingerprint) { return assertA2aConnectionFingerprint(this.db, owner, fingerprint); }
  async checkExisting(owner: string, connectionId: string, messageId: string): Promise<A2aTaskReceipt | null> {
    const [row] = await this.db.select().from(invocations).where(and(eq(invocations.owner, owner), eq(invocations.connectionId, parse(uuid, connectionId)), eq(invocations.messageId, parse(key, messageId))));
    return row ? receipt(row) : null;
  }
  async inspectTask(owner: string, id: string) { return receipt(await this.invocation(owner, id)); }
  async listTasks(owner: string, input: unknown = {}) {
    const q = parse(z.object({ limit: z.coerce.number().int().min(1).max(100).default(30), cursor: z.string().max(1000).optional() }).strict(), input);
    let cursor: { id: string; at: string } | undefined;
    if (q.cursor) {
      try { cursor = parse(z.object({ id: uuid, at: z.iso.datetime() }).strict(), JSON.parse(Buffer.from(q.cursor, 'base64url').toString())); }
      catch { throw new BadRequestException('A2A_INVALID_CURSOR'); }
    }
    const rows = await this.db.select().from(invocations).where(and(eq(invocations.owner, owner), cursor ? sql`(${invocations.createdAt},${invocations.id})<(${cursor.at}::timestamptz,${cursor.id}::uuid)` : undefined)).orderBy(desc(invocations.createdAt), desc(invocations.id)).limit(q.limit + 1);
    const last = rows[q.limit - 1];
    return { items: rows.slice(0, q.limit).map(receipt), nextCursor: rows.length > q.limit && last ? Buffer.from(JSON.stringify({ id: last.id, at: last.createdAt.toISOString() })).toString('base64url') : null };
  }
  private credential(row: InvocationRow) { return row.settlementSecretEnc ? decryptSecret(row.settlementSecretEnc, secretKey()) : undefined; }
  private async saveResponse(row: InvocationRow, raw: unknown, send: boolean): Promise<InvocationRow> {
    const committed = await this.db.transaction(async tx => {
      const [current] = await tx.select().from(invocations).where(and(eq(invocations.owner, row.owner), eq(invocations.id, row.id))).for('update');
      // The first terminal response is immutable as a whole. Later polls/cancellation may
      // describe older or contradictory remote state, including another terminal state.
      if (settled(current.state)) return { row: current, errorCode: null };
      const changes: Partial<typeof invocations.$inferInsert> = {
        rawResponseEnc: encryptSecret(JSON.stringify({ raw, send }), secretKey()),
      };
      // Write encrypted bytes before parsing, under the same lock as all derived fields.
      // Parser failures are returned after commit so invalid original output remains durable.
      await tx.update(invocations).set(changes).where(and(eq(invocations.owner, row.owner), eq(invocations.id, row.id)));
      let errorCode: string | null = null;
      try {
        const result = this.adapter.unwrap(raw);
        const candidate = result && typeof result === 'object' ? (send ? (result as Record<string, unknown>).task : result) : undefined;
        if (candidate && typeof candidate === 'object' && typeof (candidate as Record<string, unknown>).id === 'string') {
          const id = (candidate as { id: string }).id;
          if (id.length > 200 || current.remoteTaskId && current.remoteTaskId !== id) throw new Error('A2A_TASK_MISMATCH');
          const task = candidate as { contextId?: unknown; status?: { state?: unknown } };
          if (current.contextId && typeof task.contextId === 'string' && current.contextId !== task.contextId) throw new Error('A2A_TASK_MISMATCH');
          const states: Record<string, InvocationRow['state']> = { TASK_STATE_SUBMITTED: 'submitted', TASK_STATE_WORKING: 'working', TASK_STATE_COMPLETED: 'completed', TASK_STATE_FAILED: 'failed', TASK_STATE_CANCELED: 'cancelled', TASK_STATE_INPUT_REQUIRED: 'input_required', TASK_STATE_AUTH_REQUIRED: 'auth_required', TASK_STATE_REJECTED: 'rejected' };
          const state = typeof task.status?.state === 'string' ? states[task.status.state] : undefined;
          changes.remoteTaskId = id;
          if (state) changes.state = state;
          if (typeof task.contextId === 'string' && task.contextId.length <= 200) changes.contextId = task.contextId;
        }
        const parsed = this.adapter.output(result, send);
        if (current.contextId && parsed.contextId && current.contextId !== parsed.contextId) throw new Error('A2A_TASK_MISMATCH');
        Object.assign(changes, { state: parsed.state, remoteTaskId: parsed.remoteTaskId ?? current.remoteTaskId, contextId: parsed.contextId ?? current.contextId,
          outputBytes: parsed.text ? Buffer.byteLength(parsed.text) : current.outputBytes, failureCode: null,
          ...(parsed.state === 'cancelled' ? { cancellation: 'confirmed' }
            : settled(parsed.state) && current.cancellation === 'requested' ? { cancellation: 'refused' } : {}) });
      } catch (error) {
        errorCode = error instanceof Error && /^A2A_[A-Z_]+$/u.test(error.message) ? error.message : 'A2A_INVALID_OUTPUT';
        Object.assign(changes, { acceptance: 'invalid', failureCode: errorCode });
      }
      const [saved] = await tx.update(invocations).set({ ...changes, updatedAt: new Date() })
        .where(and(eq(invocations.owner, row.owner), eq(invocations.id, row.id))).returning();
      return { row: saved, errorCode };
    });
    if (committed.errorCode) throw new A2aExecutionError(committed.errorCode, committed.row.id, committed.row.contextId ?? undefined);
    return committed.row;
  }
  async execute(owner: string, options: A2aExecution): Promise<A2aExecutionResult> {
    let taskId: string | undefined;
    const observe = async (status: TelemetrySpanRecord['status'], code: string | null = null) => {
      if (!taskId || !options.activityContext || !this.telemetry) return;
      const row = await this.invocation(owner, taskId).catch(() => null);
      if (!row) return;
      const context = options.activityContext;
      captureTelemetry(this.telemetry, owner, { ...context, id: 'a2a:' + row.id, runId: `research:${context.sessionId}:${context.revision}:${context.cycleId}`,
        sourceId: row.id, parentId: context.parentId ?? null, kind: 'agent', name: 'a2a-execution', title: 'Agent execution', scene: 'research', status,
        agentId: context.memberId ?? null, agentName: null, provider: 'a2a', model: null, configuredModel: null, executionMode: 'a2a',
        startedAt: row.createdAt.toISOString(), completedAt: status === 'running' ? null : row.updatedAt.toISOString(), durationMs: null,
        inputTokens: null, outputTokens: null, totalTokens: null, estimatedCostUsd: null, errorCode: code, attempt: context.attempt ?? 1, traceId: null });
    };
    try {
      const result = await this.executeInvocation(owner, { ...options, onTask: async ref => {
        taskId = ref.taskId; await observe('running'); await options.onTask?.(ref);
      } });
      await observe('completed'); return result;
    } catch (error) {
      const code = error instanceof Error && /^A2A_[A-Z_]+$/u.test(error.message) ? error.message : 'A2A_EXECUTION_FAILED';
      await observe(['A2A_DISPATCH_UNKNOWN', 'A2A_TIMEOUT', 'A2A_STATUS_UNKNOWN', 'A2A_INPUT_REQUIRED', 'A2A_AUTH_REQUIRED'].includes(code) ? 'unknown' : code === 'A2A_CANCELLED' ? 'cancelled' : 'failed', code);
      throw error;
    }
  }
  private async executeInvocation(owner: string, options: A2aExecution): Promise<A2aExecutionResult> {
    parse(uuid, options.connectionId); parse(key, options.messageId); parse(z.string().min(1).max(250_000), options.prompt);
    const timeoutMs = Math.max(10, Math.min(120_000, options.timeoutMs ?? 120_000));
    const inputHash = hash({ prompt: options.prompt, fingerprint: options.fingerprint ?? null });
    const prepared = await this.db.transaction(async tx => {
      await this.lock(tx, owner);
      const [prior] = await tx.select().from(invocations).where(and(eq(invocations.owner, owner), eq(invocations.connectionId, options.connectionId), eq(invocations.messageId, options.messageId)));
      if (prior) { if (prior.inputHash !== inputHash) throw new ConflictException('A2A_MESSAGE_CONFLICT'); return { row: prior, fresh: false }; }
      const connection = await this.connection(owner, options.connectionId, tx);
      const fingerprint = options.fingerprint ?? await readA2aConnectionFingerprint(tx, owner, options.connectionId);
      await assertA2aConnectionFingerprint(tx, owner, fingerprint);
      const [row] = await tx.insert(invocations).values({ owner, connectionId: connection.id, messageId: options.messageId, inputHash, fingerprint,
        settlementSecretEnc: connection.secretEnc, deadlineAt: new Date(Date.now() + timeoutMs) }).returning();
      return { row, fresh: true };
    });
    let row = prepared.row;
    await options.onTask?.({ taskId: row.id, contextId: row.contextId ?? '' });
    if (prepared.fresh) {
      let dispatched = false;
      try {
        if (options.shouldContinue && !await options.shouldContinue()) throw new Error('A2A_PUBLICATION_BLOCKED');
        await options.onDispatch?.({ inputBytes: Buffer.byteLength(options.prompt) });
        // No external usage proof means the conservative reservation stays charged, including cancellation.
        await this.budgets?.reserve(owner, { dispatchKey: 'a2a:' + row.id, requestHash: row.inputHash,
          taskId: options.budgetTaskId ?? row.id, purpose: options.budgetPurpose ?? 'a2a:research', model: 'a2a:external-unknown',
          messages: [{ role: 'user', content: options.prompt }] });
        let sending: Promise<unknown> | undefined;
        const handoff = async () => {
          await assertA2aConnectionFingerprint(this.db, owner, row.fingerprint);
          dispatched = true;
          sending = this.adapter.rpc(row.fingerprint.interfaceUrl, 'SendMessage', { message: { messageId: row.messageId, role: 'ROLE_USER', parts: [{ text: options.prompt }] },
            configuration: { acceptedOutputModes: ['application/json', 'text/plain'], returnImmediately: true, historyLength: 0 }, ...(row.fingerprint.tenant ? { tenant: row.fingerprint.tenant } : {}) }, this.credential(row), timeoutMs);
          // Attach immediately while caller handoff transactions finish, retaining rejection for the awaited promise.
          sending.catch(() => undefined);
        };
        if (options.withHandoff) await options.withHandoff(handoff); else await handoff();
        if (!sending) throw new Error('A2A_HANDOFF_MISSING');
        row = await this.saveResponse(row, await sending, true);
      } catch (error) {
        if (error instanceof A2aExecutionError) throw error;
        row = await this.patch(row, { state: dispatched ? 'dispatch_unknown' : 'failed', acceptance: dispatched ? 'pending' : 'blocked', failureCode: dispatched ? 'A2A_DISPATCH_UNKNOWN' : 'A2A_PUBLICATION_BLOCKED' });
        if (!dispatched && error instanceof Error && error.message !== 'A2A_PUBLICATION_BLOCKED') throw error;
        throw new A2aExecutionError(row.failureCode!, row.id);
      }
    }
    await options.onTask?.({ taskId: row.id, contextId: row.contextId ?? '' });
    if (!row.remoteTaskId && !terminal(row.state)) throw new A2aExecutionError('A2A_DISPATCH_UNKNOWN', row.id);
    while (!terminal(row.state)) {
      if (options.shouldContinue && !await options.shouldContinue()) {
        const cancelled = await this.cancelTask(owner, row.id);
        throw new A2aExecutionError(cancelled.state === 'cancelled' ? 'A2A_CANCELLED'
          : ['completed', 'failed', 'rejected'].includes(cancelled.state) ? 'A2A_PUBLICATION_BLOCKED' : 'A2A_CANCEL_PENDING', row.id);
      }
      if (Date.now() >= row.deadlineAt.getTime()) { await this.patch(row, { failureCode: 'A2A_TIMEOUT' }); throw new A2aExecutionError('A2A_TIMEOUT', row.id); }
      row = await this.poll(row);
      if (!terminal(row.state)) await new Promise(resolve => setTimeout(resolve, Math.max(5, Math.min(1000, options.pollIntervalMs ?? 250))));
    }
    return this.reparse(owner, row.id, options.shouldContinue);
  }
  private async poll(row: InvocationRow): Promise<InvocationRow> {
    if (!row.remoteTaskId) return row;
    try {
      const raw = await this.adapter.rpc(row.fingerprint.interfaceUrl, 'GetTask', { id: row.remoteTaskId, historyLength: 0, ...(row.fingerprint.tenant ? { tenant: row.fingerprint.tenant } : {}) }, this.credential(row));
      return await this.saveResponse(row, raw, false);
    } catch (error) {
      if (error instanceof A2aExecutionError) throw error;
      await this.patch(row, { failureCode: 'A2A_STATUS_UNKNOWN' });
      throw new A2aExecutionError('A2A_STATUS_UNKNOWN', row.id);
    }
  }
  async read(owner: string, id: string) {
    const row = await this.invocation(owner, id);
    return receipt(row.remoteTaskId && !['completed', 'failed', 'cancelled', 'rejected'].includes(row.state) ? await this.poll(row) : row);
  }
  async reparse(owner: string, id: string, shouldContinue?: () => Promise<boolean>): Promise<A2aExecutionResult> {
    const row = await this.invocation(owner, id);
    if (row.state !== 'completed') throw new A2aExecutionError(({ input_required: 'A2A_INPUT_REQUIRED', auth_required: 'A2A_AUTH_REQUIRED', cancelled: 'A2A_CANCELLED', failed: 'A2A_TASK_FAILED', rejected: 'A2A_REJECTED' } as Record<string, string>)[row.state] ?? 'A2A_DISPATCH_UNKNOWN', row.id);
    try {
      await assertA2aConnectionFingerprint(this.db, owner, row.fingerprint);
      if (shouldContinue && !await shouldContinue()) throw new Error('A2A_PUBLICATION_BLOCKED');
    } catch (error) { await this.patch(row, { acceptance: 'blocked', failureCode: 'A2A_PUBLICATION_BLOCKED' }); throw error; }
    if (!row.rawResponseEnc) throw new A2aExecutionError('A2A_INVALID_OUTPUT', row.id);
    const saved = JSON.parse(decryptSecret(row.rawResponseEnc, secretKey())) as { raw: unknown; send: boolean };
    const parsed = this.adapter.output(this.adapter.unwrap(saved.raw), saved.send);
    return { taskId: row.id, ...(row.remoteTaskId ? { remoteTaskId: row.remoteTaskId } : {}), ...(row.contextId ? { contextId: row.contextId } : {}),
      text: parsed.text ?? '', ...(parsed.data !== undefined ? { data: parsed.data } : {}), usageTokens: null, externalUsageUnknown: true };
  }
  /** Called only after the owning workflow validates its domain output. Protocol completion is separate. */
  async acceptResult(owner: string, id: string, options: { structuredOutput?: boolean; shouldContinue?: () => Promise<boolean> } = {}) {
    const row = await this.invocation(owner, id);
    await this.reparse(owner, id, options.shouldContinue);
    await this.db.transaction(async tx => {
      await this.lock(tx, owner);
      await assertA2aConnectionFingerprint(tx, owner, row.fingerprint);
      if (options.shouldContinue && !await options.shouldContinue()) throw new Error('A2A_PUBLICATION_BLOCKED');
      await tx.update(invocations).set({ acceptance: 'accepted', failureCode: null, updatedAt: new Date() }).where(and(eq(invocations.owner, owner), eq(invocations.id, id), eq(invocations.state, 'completed')));
      if (options.structuredOutput) {
        const connection = await this.connection(owner, row.connectionId, tx);
        if (!connection.capabilities.structuredOutputVerified) await tx.update(connections).set({ capabilities: { ...connection.capabilities, structuredOutputVerified: true } }).where(and(eq(connections.owner, owner), eq(connections.id, connection.id), eq(connections.revision, row.fingerprint.connectionRevision)));
      }
    });
    return this.inspectTask(owner, id);
  }
  async cancelTask(owner: string, id: string): Promise<A2aTaskReceipt> {
    let row = await this.invocation(owner, id);
    if (row.state === 'cancelled') return receipt(row);
    if (['completed', 'failed', 'rejected'].includes(row.state)) return receipt(await this.patch(row, { cancellation: 'refused' }));
    row = await this.patch(row, { cancellation: 'requested' });
    if (!row.remoteTaskId) return receipt(await this.patch(row, { cancellation: 'unknown' }));
    try {
      const raw = await this.adapter.rpc(row.fingerprint.interfaceUrl, 'CancelTask', { id: row.remoteTaskId, ...(row.fingerprint.tenant ? { tenant: row.fingerprint.tenant } : {}) }, this.credential(row));
      if (this.adapter.isRemoteError(raw)) return receipt(await this.patch(row, { cancellation: 'refused' }));
      row = await this.saveResponse(row, raw, false);
      return receipt(await this.patch(row, { cancellation: row.state === 'cancelled' ? 'confirmed' : terminal(row.state) ? 'refused' : 'requested' }));
    } catch { return receipt(await this.patch(row, { cancellation: 'unknown', failureCode: 'A2A_CANCEL_UNKNOWN' })); }
  }
}
