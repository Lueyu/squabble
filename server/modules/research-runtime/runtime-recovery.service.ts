import { Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '../../common/platform';
import { agentRuntimeRuns, agentRuntimeEvents, agentToolInvocations } from '../../database/agent-tooling.schema';
import { councilSessions } from '../../database/council.schema';
import { libraryEvidenceAvailable } from '../../database/data-library-visibility';
import { assertSourceVersions } from '../research-artifacts/research-artifacts.rules';
import type { AgentSourceVersionRef } from '../../../shared/agent-tooling.interface';
import { RuntimeJournalService } from './runtime-journal.service';

interface RuntimeStatusSource {
  read(owner: string, id: string): Promise<{ id: string; state: string; cursor: number;
    steps: Array<{ id: string; stepIndex: number; state: string; model: string;
      providerRequestId?: string | null; responseEnc?: string | null; usage?: unknown }> }>;
  recover(owner: string, id: string): Promise<string>;
  cancel(owner: string, id: string): Promise<void>;
  settleUnknown(owner: string, id: string): Promise<void>;
}

/** Status and explicit recovery never instantiate or call an executor. */
@Injectable()
export class RuntimeRecoveryService {
  constructor(@Inject(RuntimeJournalService) private readonly journal: RuntimeStatusSource,
    @Optional() @Inject(DRIZZLE_DATABASE) private readonly db?: PostgresJsDatabase) {}

  private async visible(owner: string, id: string): Promise<void> {
    if (!this.db) return;
    const [run] = await this.db.select().from(agentRuntimeRuns).where(and(eq(agentRuntimeRuns.owner, owner), eq(agentRuntimeRuns.id, id)));
    if (!run) throw new NotFoundException('RUNTIME_NOT_FOUND');
    if (run.policy.purpose === 'capability_probe') return;
    if (Array.isArray(run.policy.sourceVersions)) {
      try { await this.db.transaction(tx => assertSourceVersions(tx, owner, run.policy.sourceVersions as AgentSourceVersionRef[])); }
      catch { throw new NotFoundException('RUNTIME_SOURCE_UNAVAILABLE'); }
    }
    const [session] = await this.db.select().from(councilSessions).where(and(eq(councilSessions.owner, owner),
      eq(councilSessions.id, String(run.identity.sessionId)), isNull(councilSessions.deletedAt)));
    if (!session || !await libraryEvidenceAvailable(this.db, owner, [...session.evidenceSnapshot,
      ...(session.checkpoint?.simple?.commonEvidence ?? []), ...Object.values(session.checkpoint?.simple?.privateEvidence ?? {}).flat()])) {
      throw new NotFoundException('RUNTIME_SOURCE_UNAVAILABLE');
    }
  }

  async list(owner: string, sessionId: string) {
    if (!this.db) return [];
    const records = await this.db.select({ id: agentRuntimeRuns.id }).from(agentRuntimeRuns).where(and(
      eq(agentRuntimeRuns.owner, owner), sql`${agentRuntimeRuns.identity}->>'sessionId'=${sessionId}`))
      .orderBy(desc(agentRuntimeRuns.createdAt)).limit(100);
    return Promise.all(records.map(row => this.status(owner, row.id)));
  }

  async status(owner: string, id: string) {
    await this.visible(owner, id);
    const run = await this.journal.read(owner, id);
    const events = this.db ? await this.db.select({ kind: agentRuntimeEvents.kind, code: agentRuntimeEvents.code,
      stepId: agentRuntimeEvents.stepId, at: agentRuntimeEvents.createdAt }).from(agentRuntimeEvents).where(and(
      eq(agentRuntimeEvents.owner, owner), eq(agentRuntimeEvents.runId, id))).orderBy(asc(agentRuntimeEvents.createdAt)).limit(200) : [];
    const tools = this.db ? await this.db.select({ id: agentToolInvocations.id, stepId: agentToolInvocations.stepId,
      toolId: agentToolInvocations.toolId, state: agentToolInvocations.state }).from(agentToolInvocations).where(and(
      eq(agentToolInvocations.owner, owner), eq(agentToolInvocations.runId, id))).limit(100) : [];
    return { id: run.id, state: run.state, cursor: run.cursor,
      remoteStatusLookupSupported: false, unknownUsageRetained: ['provider_unknown', 'settled_unknown'].includes(run.state), events, tools,
      steps: run.steps.map(step => ({ id: step.id, index: step.stepIndex, state: step.state,
        model: step.model, providerRequestId: step.providerRequestId ?? null,
        hasStoredResponse: Boolean(step.responseEnc), usageKnown: this.usageKnown(step.usage) })) };
  }
  private usageKnown(value: unknown): boolean {
    if (!value || typeof value !== 'object') return false;
    const usage = value as Record<string, unknown>;
    return typeof usage.inputTokens === 'number' && Number.isSafeInteger(usage.inputTokens) && usage.inputTokens > 0
      && typeof usage.outputTokens === 'number' && Number.isSafeInteger(usage.outputTokens) && usage.outputTokens >= 0
      && typeof usage.totalTokens === 'number' && Number.isSafeInteger(usage.totalTokens)
      && usage.totalTokens >= usage.inputTokens + usage.outputTokens;
  }
  async recover(owner: string, id: string): Promise<string> { await this.visible(owner, id); return this.journal.recover(owner, id); }
  async cancel(owner: string, id: string): Promise<void> { await this.visible(owner, id); await this.journal.cancel(owner, id); }
  async closeUnknown(owner: string, id: string): Promise<void> { await this.visible(owner, id); await this.journal.settleUnknown(owner, id); }
}
