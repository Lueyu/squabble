import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '../../common/platform';
import { toolActions } from '../../database/tool-actions.schema';
import { toolConnections } from '../../database/tool-connections.schema';
import { decryptSecret, encryptSecret } from '../settings/settings-security';
import { toolEncryptionKey } from '../tool-connections/tool-connections.service';
import { toolHash } from '../tool-connections/tool-catalog.service';
import { previewHash, validatePreview, type ToolActionPreview, type ToolActionPreviewInput } from './tool-actions.rules';
import type { AgentToolScope } from '../../../shared/agent-tooling.interface';
import { lockMemoryOwner } from '../research-memory/research-memory.fence';

type Transaction = Parameters<Parameters<PostgresJsDatabase['transaction']>[0]>[0];
type ActionRow = typeof toolActions.$inferSelect;
export const TOOL_ACTION_VALIDATION = Symbol('TOOL_ACTION_VALIDATION');
export interface ToolActionValidationPort {
  /** Revalidate sources, account/target versions, attachments and egress at confirm and dispatch. */
  validate(tx: Transaction, owner: string, preview: ToolActionPreviewInput): Promise<void>;
  /** Database-only read check; GET projections must never probe a remote service. */
  assertVisible?(tx: Transaction, owner: string, preview: ToolActionPreviewInput): Promise<void>;
}
export interface ToolActionClaim {
  owner: string; runId: string; stepId: string; toolCallId: string; invocationId: string;
  toolId: string; argumentsHash: string; catalogVersionId: string; connectionRevision: number; scope: AgentToolScope;
}

@Injectable()
export class ToolActionsService {
  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    @Optional() @Inject(TOOL_ACTION_VALIDATION) private readonly validation?: ToolActionValidationPort) {}

  private contents(row: ActionRow): ToolActionPreviewInput {
    return JSON.parse(decryptSecret(row.previewEnc, toolEncryptionKey())) as ToolActionPreviewInput;
  }
  private project(row: ActionRow): ToolActionPreview {
    return { ...this.contents(row), id: row.id, revision: row.revision, payloadHash: row.payloadHash, state: row.state,
      expiresAt: row.expiresAt.toISOString(), receipt: row.receipt };
  }
  private redacted(row: ActionRow, preview: ToolActionPreviewInput): ToolActionPreview {
    return { ...preview, id: row.id, revision: row.revision, payloadHash: row.payloadHash, state: 'redacted',
      expiresAt: row.expiresAt.toISOString(), args: {}, accountId: 'SOURCE_UNAVAILABLE', target: 'SOURCE_UNAVAILABLE', attachments: [],
      descriptor: { ...preview.descriptor, description: 'Source unavailable', inputSchema: { type: 'object' } },
      scope: { ...preview.scope, sourceVersions: [], allowedAccountIds: [], allowedInstrumentIds: [] },
      receipt: row.receipt ? { state: row.receipt.state } : null };
  }
  private async row(tx: Transaction | PostgresJsDatabase, owner: string, id: string, lock = false): Promise<ActionRow> {
    if (!owner?.trim() || !z.string().uuid().safeParse(id).success) throw new NotFoundException('TOOL_ACTION_NOT_FOUND');
    const query = tx.select().from(toolActions).where(and(eq(toolActions.owner, owner), eq(toolActions.id, id)));
    const [row] = lock ? await query.for('update') : await query;
    if (!row) throw new NotFoundException('TOOL_ACTION_NOT_FOUND');
    return row;
  }
  private async validate(tx: Transaction, owner: string, preview: ToolActionPreviewInput): Promise<void> {
    if (preview.scope.owner !== owner) throw new ConflictException('TOOL_ACTION_SCOPE_CHANGED');
    const [connection] = await tx.select().from(toolConnections).where(and(eq(toolConnections.owner, owner),
      eq(toolConnections.id, preview.descriptor.connectionId!))).for('share');
    if (!connection || connection.status !== 'configured' || connection.revision !== preview.connectionRevision
      || connection.catalogVersionId !== preview.descriptor.catalogVersionId || !connection.allowedToolIds.includes(preview.descriptor.id)) {
      throw new ConflictException('TOOL_ACTION_CONNECTION_CHANGED');
    }
    if (connection.provider === 'composio' && connection.providerConfig?.connectedAccountId !== preview.accountId) {
      throw new ConflictException('TOOL_ACTION_ACCOUNT_CHANGED');
    }
    if (!this.validation && (preview.scope.sourceVersions.length || preview.attachments.length || preview.resourceVersion !== null)) {
      throw new ConflictException('TOOL_ACTION_VALIDATION_UNAVAILABLE');
    }
    await this.validation?.validate(tx, owner, preview);
  }
  async prepare(owner: string, input: ToolActionPreviewInput, interactive: boolean): Promise<ToolActionPreview> {
    try { validatePreview(input); } catch { throw new BadRequestException('INVALID_TOOL_ACTION_PREVIEW'); }
    if (!owner?.trim() || input.scope.owner !== owner) throw new BadRequestException('TOOL_ACTION_SCOPE_CHANGED');
    const payloadHash = previewHash(input), argumentsHash = toolHash(input.args);
    return this.db.transaction(async tx => {
      await lockMemoryOwner(tx, owner);
      await this.validate(tx, owner, input);
      const [inserted] = await tx.insert(toolActions).values({ id: randomUUID(), owner, runId: input.runId, stepId: input.stepId,
        toolCallId: input.toolCallId, toolId: input.descriptor.id, connectionId: input.descriptor.connectionId!,
        connectionRevision: input.connectionRevision, catalogVersionId: input.descriptor.catalogVersionId, payloadHash, argumentsHash,
        previewEnc: encryptSecret(JSON.stringify(input), toolEncryptionKey()), state: interactive ? 'pending' : 'draft',
        expiresAt: new Date(Date.now() + 15 * 60_000) }).onConflictDoNothing().returning();
      if (inserted) return this.project(inserted);
      const [existing] = await tx.select().from(toolActions).where(and(eq(toolActions.owner, owner), eq(toolActions.runId, input.runId),
        eq(toolActions.stepId, input.stepId), eq(toolActions.toolCallId, input.toolCallId))).for('update');
      if (!existing || existing.payloadHash !== payloadHash) throw new ConflictException('TOOL_ACTION_PREVIEW_CHANGED');
      return this.project(existing);
    });
  }
  async list(owner: string, runId?: string): Promise<ToolActionPreview[]> {
    if (!owner?.trim()) throw new BadRequestException('TOOL_OWNER_REQUIRED');
    if (runId !== undefined && !z.uuid().safeParse(runId).success) throw new BadRequestException('RUNTIME_ID_INVALID');
    return this.db.transaction(async tx => {
      const rows = await tx.select().from(toolActions).where(and(eq(toolActions.owner, owner),
        runId ? eq(toolActions.runId, runId) : undefined)).orderBy(desc(toolActions.createdAt)).limit(100);
      const visible: ToolActionPreview[] = [];
      for (const row of rows) {
        const preview = this.contents(row);
        try { await this.assertVisible(tx, owner, preview); visible.push(this.project(row)); }
        catch { visible.push(this.redacted(row, preview)); }
      }
      return visible;
    }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
  }
  async findCall(owner: string, runId: string, stepId: string, toolCallId: string): Promise<ToolActionPreview | null> {
    const [row] = await this.db.select().from(toolActions).where(and(eq(toolActions.owner, owner),
      eq(toolActions.runId, runId), eq(toolActions.stepId, stepId), eq(toolActions.toolCallId, toolCallId)));
    return row ? this.detail(owner, row.id) : null;
  }
  async authorizeResume(tx: Transaction, owner: string, runId: string): Promise<void> {
    const rows = await tx.select().from(toolActions).where(and(eq(toolActions.owner, owner), eq(toolActions.runId, runId))).for('update');
    if (!rows.length || rows.some(row => !['approved', 'completed'].includes(row.state))) throw new ConflictException('TOOL_ACTION_APPROVAL_REQUIRED');
    for (const row of rows) {
      if (row.state === 'approved' && row.expiresAt <= new Date()) throw new ConflictException('TOOL_ACTION_PREVIEW_EXPIRED');
      await this.validate(tx, owner, this.contents(row));
    }
  }
  async cancelRun(owner: string, runId: string): Promise<void> {
    await this.db.transaction(async tx => {
      await lockMemoryOwner(tx, owner);
      await tx.update(toolActions).set({ state: 'rejected', approvedAt: null, updatedAt: new Date() }).where(and(
        eq(toolActions.owner, owner), eq(toolActions.runId, runId), inArray(toolActions.state, ['draft', 'pending', 'approved'])));
    });
  }
  private async assertVisible(tx: Transaction, owner: string, preview: ToolActionPreviewInput): Promise<void> {
    if (preview.scope.owner !== owner) throw new NotFoundException('TOOL_ACTION_NOT_FOUND');
    if (this.validation?.assertVisible || preview.scope.sourceVersions.length || preview.attachments.length) {
      if (!this.validation?.assertVisible) throw new ConflictException('TOOL_ACTION_SOURCE_UNAVAILABLE');
      try { await this.validation.assertVisible(tx, owner, preview); }
      catch { throw new ConflictException('TOOL_ACTION_SOURCE_UNAVAILABLE'); }
    }
  }
  async detail(owner: string, id: string): Promise<ToolActionPreview> {
    return this.db.transaction(async tx => {
      const row = await this.row(tx, owner, id);
      const preview = this.contents(row);
      try { await this.assertVisible(tx, owner, preview); return this.project(row); }
      catch { return this.redacted(row, preview); }
    }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
  }

  async confirm(owner: string, id: string, input: unknown): Promise<ToolActionPreview> {
    const body = z.object({ revision: z.number().int().positive(), payloadHash: z.string().regex(/^[a-f0-9]{64}$/u) }).strict().safeParse(input);
    if (!body.success) throw new BadRequestException('INVALID_TOOL_ACTION_CONFIRMATION');
    return this.db.transaction(async tx => {
      await lockMemoryOwner(tx, owner);
      const row = await this.row(tx, owner, id, true);
      if (row.revision !== body.data.revision || row.payloadHash !== body.data.payloadHash) throw new ConflictException('TOOL_ACTION_PREVIEW_CHANGED');
      if (['dispatched', 'completed', 'failed', 'unknown', 'approved'].includes(row.state)) return this.project(row);
      if (row.state !== 'pending') throw new ConflictException('TOOL_ACTION_INTERACTIVE_CONFIRMATION_REQUIRED');
      if (row.expiresAt <= new Date()) throw new ConflictException('TOOL_ACTION_PREVIEW_EXPIRED');
      await this.validate(tx, owner, this.contents(row));
      const [saved] = await tx.update(toolActions).set({ state: 'approved', approvedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(toolActions.owner, owner), eq(toolActions.id, id), eq(toolActions.state, 'pending'), eq(toolActions.revision, row.revision))).returning();
      if (!saved) throw new ConflictException('TOOL_ACTION_PREVIEW_CHANGED');
      return this.project(saved);
    });
  }
  async reject(owner: string, id: string): Promise<ToolActionPreview> {
    return this.db.transaction(async tx => {
      await lockMemoryOwner(tx, owner);
      const row = await this.row(tx, owner, id, true);
      if (!['pending', 'approved', 'draft', 'rejected'].includes(row.state)) throw new ConflictException('TOOL_ACTION_ALREADY_DISPATCHED');
      const [saved] = await tx.update(toolActions).set({ state: 'rejected', approvedAt: null, updatedAt: new Date() })
        .where(and(eq(toolActions.owner, owner), eq(toolActions.id, id))).returning();
      return this.project(saved);
    });
  }

  /** A preview edit invalidates the old approval without producing another model step. */
  async edit(owner: string, id: string, input: unknown): Promise<ToolActionPreview> {
    const body = z.object({ revision: z.number().int().positive(), payloadHash: z.string().regex(/^[a-f0-9]{64}$/u),
      args: z.record(z.string(), z.unknown()), accountId: z.string().min(1).max(250), target: z.string().min(1).max(4000) }).strict().safeParse(input);
    if (!body.success) throw new BadRequestException('INVALID_TOOL_ACTION_PREVIEW');
    return this.db.transaction(async tx => {
      await lockMemoryOwner(tx, owner);
      const row = await this.row(tx, owner, id, true);
      if (!['pending', 'approved', 'draft'].includes(row.state) || row.revision !== body.data.revision || row.payloadHash !== body.data.payloadHash) {
        throw new ConflictException('TOOL_ACTION_PREVIEW_CHANGED');
      }
      const preview = { ...this.contents(row), args: body.data.args, accountId: body.data.accountId, target: body.data.target };
      try { validatePreview(preview); } catch { throw new BadRequestException('INVALID_TOOL_ACTION_PREVIEW'); }
      await this.validate(tx, owner, preview);
      const [saved] = await tx.update(toolActions).set({ revision: row.revision + 1, payloadHash: previewHash(preview), argumentsHash: toolHash(preview.args),
        previewEnc: encryptSecret(JSON.stringify(preview), toolEncryptionKey()), state: row.state === 'draft' ? 'draft' : 'pending', approvedAt: null,
        expiresAt: new Date(Date.now() + 15 * 60_000), updatedAt: new Date() }).where(and(eq(toolActions.owner, owner), eq(toolActions.id, id))).returning();
      return this.project(saved);
    });
  }

  /** Called inside the runtime's unique invocation claim transaction, before any network dispatch. */
  async claimInTransaction(tx: Transaction, input: ToolActionClaim): Promise<ToolActionPreview> {
    await lockMemoryOwner(tx, input.owner);
    const [row] = await tx.select().from(toolActions).where(and(eq(toolActions.owner, input.owner), eq(toolActions.runId, input.runId),
      eq(toolActions.stepId, input.stepId), eq(toolActions.toolCallId, input.toolCallId))).for('update');
    if (!row || row.state !== 'approved' || row.expiresAt <= new Date()) throw new ConflictException('TOOL_ACTION_APPROVAL_REQUIRED');
    const preview = this.contents(row);
    if (row.toolId !== input.toolId || row.argumentsHash !== input.argumentsHash || row.catalogVersionId !== input.catalogVersionId
      || row.connectionRevision !== input.connectionRevision || toolHash({ ...preview.scope, leaseToken: '' }) !== toolHash({ ...input.scope, leaseToken: '' })) {
      throw new ConflictException('TOOL_ACTION_PREVIEW_CHANGED');
    }
    await this.validate(tx, input.owner, preview);
    const [saved] = await tx.update(toolActions).set({ state: 'dispatched', invocationId: input.invocationId, updatedAt: new Date() })
      .where(and(eq(toolActions.owner, input.owner), eq(toolActions.id, row.id), eq(toolActions.state, 'approved'), eq(toolActions.revision, row.revision))).returning();
    if (!saved) throw new ConflictException('TOOL_ACTION_ALREADY_DISPATCHED');
    return this.project(saved);
  }
  async settle(owner: string, invocationId: string, receipt: NonNullable<ActionRow['receipt']>): Promise<void> {
    if (!owner?.trim() || !['completed', 'failed', 'unknown'].includes(receipt.state)) throw new BadRequestException('INVALID_TOOL_ACTION_RECEIPT');
    await this.db.update(toolActions).set({ state: receipt.state, receipt, updatedAt: new Date() })
      .where(and(eq(toolActions.owner, owner), eq(toolActions.invocationId, invocationId), eq(toolActions.state, 'dispatched')));
  }
}
