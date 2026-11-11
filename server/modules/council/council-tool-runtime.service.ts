import { ConflictException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { ModelMessage } from 'ai';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '../../common/platform';
import { assertFrozenInputSnapshot, canonicalHash } from '../../common/agent-contract';
import { councilSessions } from '../../database/council.schema';
import { libraryEvidenceAvailable, libraryEvidenceReferences } from '../../database/data-library-visibility';
import { dataLibraryVersions } from '../../database/data-library.schema';
import { researchDatasetVersions } from '../../database/research-artifacts.schema';
import { datasetContentHash } from '../data-library/data-dataset.rules';
import { readDataset } from '../data-library/data-dataset.service';
import { assertSourceVersions } from '../research-artifacts/research-artifacts.rules';
import { toolConnections } from '../../database/tool-connections.schema';
import { ToolActionsService } from '../tool-actions/tool-actions.service';
import type { ToolActionPreview } from '../tool-actions/tool-actions.rules';
import type { CouncilMember } from '../../../shared/council.interface';
import type { AgentDataClass, AgentToolDescriptor, AgentToolScope } from '../../../shared/agent-tooling.interface';
import type { CouncilRuntimePending, CouncilRuntimeRecoveryInput, RuntimeFrozenInputSnapshot, RuntimeIdentity } from '../../../shared/research-runtime.interface';
import type { ResearchToolScope } from '../../../shared/research-tools.interface';
import type { ModelStepRequest } from '../research-core/model-step.interface';
import { ModelStepService } from '../research-core/model-step.service';
import { LlmBudgetService } from '../llm-budget/llm-budget.service';
import { ResearchToolsService } from '../research-tools/research-tools.service';
import { ResearchRuntimeService, type RuntimeExecuteInput, type RuntimeLoopPorts } from '../research-runtime/research-runtime.service';
import { DeepAgentsDriver } from '../research-runtime/drivers/deep-agents.driver';
import { RuntimeJournalService } from '../research-runtime/runtime-journal.service';
import { RuntimeDispatchService } from '../research-runtime/runtime-dispatch.service';
import { RuntimeInvocationsService } from '../research-runtime/runtime-invocations.service';
import { ModelCapabilityService } from '../research-runtime/model-capability.service';
import { ToolConnectionsService } from '../tool-connections/tool-connections.service';
import { ToolBudgetService } from '../tool-connections/tool-budget.service';
import { catalogSnapshot } from '../tool-connections/tool-catalog.service';
import type { CouncilEvidence } from './council.rules';
import type { MemberAttempt } from './council-member-attempts.service';
import { CouncilMemberAttemptsService } from './council-member-attempts.service';
import { councilMemberAttempts, councilRecoveryRequests } from '../../database/simple-council.schema';

type Session = typeof councilSessions.$inferSelect & { memberAttempt?: MemberAttempt };
export class ResearchRuntimeSuspended extends Error {
  constructor(readonly runId: string, readonly state: string) { super(`RESEARCH_RUNTIME_${state.toUpperCase()}`); }
}
const json = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Freeze complete facts once; subsequent runs must not refill old inputs with today's values. */
export function freezeCouncilInput(evidence: CouncilEvidence[], context: Record<string, unknown>): RuntimeFrozenInputSnapshot {
  const originals = evidence.filter(item => item.sourceName === 'Frozen owner context').map(item => JSON.parse(item.content) as Record<string, unknown>);
  const holdings: RuntimeFrozenInputSnapshot['payload']['holdings'] = [], cash: RuntimeFrozenInputSnapshot['payload']['cash'] = [];
  for (const source of originals) {
    if (Array.isArray(source.holdings)) for (const raw of source.holdings) {
      if (!raw || typeof raw !== 'object' || typeof raw.ticker !== 'string') throw new Error('FROZEN_HOLDING_INVALID');
      holdings.push({ ...json(raw), accountId: String(raw.accountId ?? 'owner-portfolio'),
        instrumentId: `${String(raw.market ?? 'UNKNOWN')}:${raw.ticker}`,
        quantity: raw.shares === null || raw.quantity === null || raw.shares === undefined && raw.quantity === undefined
          ? null : String(raw.shares ?? raw.quantity) });
    }
    if (Array.isArray(source.cash)) for (const raw of source.cash) {
      if (!raw || typeof raw !== 'object' || typeof raw.currency !== 'string') throw new Error('FROZEN_CASH_INVALID');
      cash.push({ ...json(raw), accountId: String(raw.accountId ?? 'owner-portfolio'),
        amount: raw.amount === null || raw.amount === undefined ? null : String(raw.amount), currency: raw.currency });
    }
  }
  const frozenContext = json(context);
  // The complete owner rows appear once in the protected payload, rather than twice in the prompt budget.
  if (Array.isArray(frozenContext.evidence)) frozenContext.evidence = frozenContext.evidence.map(item =>
    item?.sourceName === 'Frozen owner context' || item?.source === 'Frozen owner context'
      ? { ...item, content: 'Complete owner facts are in the frozen holdings/cash and ownerContext fields.' } : item);
  const payload = json({ holdings, cash, sourcePayloads: [], context: { ...frozenContext,
    ownerContext: originals.map(({ holdings: _holdings, cash: _cash, ...rest }) => rest) } });
  const snapshot = { version: 1, datasetVersionIds: [], datasets: [], payload, payloadHash: canonicalHash(payload) };
  assertFrozenInputSnapshot(snapshot);
  return snapshot;
}

@Injectable()
export class CouncilToolRuntimeService {
  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly model: ModelStepService, private readonly capabilities: ModelCapabilityService,
    private readonly journal: RuntimeJournalService, private readonly dispatch: RuntimeDispatchService,
    private readonly invocations: RuntimeInvocationsService, private readonly tools: ResearchToolsService,
    private readonly connections: ToolConnectionsService, private readonly toolBudgets: ToolBudgetService,
    private readonly budgets: LlmBudgetService, private readonly actions: ToolActionsService,
    @Optional() private readonly deepDriver?: DeepAgentsDriver) {}

  async eligible(owner: string, row: Session, member: CouncilMember): Promise<boolean> {
    if (member.executionMode === 'local' || row.checkpoint?.toolRuntimeVersion !== 1 || row.checkpoint.workflow) return false;
    const identity = this.identity(owner, row, member), hash = canonicalHash(identity);
    const retained = await this.db.execute(sql`select route from agent_runtime_execution_routes where owner=${owner} and identity_hash=${hash}`);
    if (retained.length) return retained[0].route !== 'legacy';
    const enabled = await this.capabilities.enabled(owner, member.connectionId, member.model);
    const config = enabled ? await this.model.resolve(owner, member.connectionId, member.model) : null;
    const route = enabled ? await this.capabilities.driver?.(owner, member.connectionId ?? '') ?? 'controlled' : 'legacy';
    await this.db.execute(sql`insert into agent_runtime_execution_routes(owner,identity_hash,identity,route,model_config)
      values(${owner},${hash},${JSON.stringify(identity)}::jsonb,${route},${JSON.stringify(config)}::jsonb)
      on conflict(owner,identity_hash) do nothing`);
    const saved = await this.db.execute(sql`select route from agent_runtime_execution_routes where owner=${owner} and identity_hash=${hash}`);
    return saved[0].route !== 'legacy';
  }

  private identity(owner: string, row: Session, member: CouncilMember): RuntimeIdentity {
    if (!row.checkpoint) throw new Error('RUNTIME_CHECKPOINT_REQUIRED');
    return { owner, sessionId: row.id, cycleId: row.checkpoint.cycleId, revision: row.revision,
      memberId: member.id, turn: row.checkpoint.nextTurn, executionAttempt: row.memberAttempt?.attempt ?? 1 };
  }

  async pending(owner: string, runId: string): Promise<CouncilRuntimePending> {
    await this.journal.recover(owner, runId);
    const run = await this.journal.read(owner, runId), last = run.steps.at(-1);
    return { runId, memberId: String(run.identity.memberId), turn: Number(run.identity.turn),
      ...(typeof run.policy.memberAttemptId === 'string' ? { attemptId: run.policy.memberAttemptId } : {}),
      state: run.state, expectedCursor: run.cursor, ...(last ? { stepId: last.id } : {}) };
  }

  async interrupted(owner: string, row: Session): Promise<CouncilRuntimePending[]> {
    const rows = await this.db.execute(sql`select id from agent_runtime_runs where owner=${owner}
      and identity->>'sessionId'=${row.id} and identity->>'cycleId'=${row.checkpoint?.cycleId ?? ''}
      and state not in ('accepted','cancelled','settled_unknown')`);
    return Promise.all(rows.map(item => this.pending(owner, String(item.id))));
  }

  async cancelSession(owner: string, sessionId: string): Promise<void> {
    const rows = await this.db.execute(sql`select id from agent_runtime_runs where owner=${owner}
      and identity->>'sessionId'=${sessionId} and state not in ('accepted','cancelled','settled_unknown')`);
    for (const row of rows) {
      await this.journal.cancel(owner, String(row.id));
      await this.actions.cancelRun(owner, String(row.id));
    }
  }

  async settled(owner: string, runId: string): Promise<boolean> {
    const run = await this.journal.read(owner, runId).catch(() => null);
    return Boolean(run && ['cancelled', 'accepted', 'settled_unknown'].includes(run.state));
  }

  async recover(owner: string, sessionId: string, input: CouncilRuntimeRecoveryInput): Promise<boolean> {
    const hash = canonicalHash({ sessionId, ...input });
    return this.db.transaction(async tx => {
      const [session] = await tx.select().from(councilSessions).where(and(eq(councilSessions.owner, owner),
        eq(councilSessions.id, sessionId), isNull(councilSessions.deletedAt))).for('update');
      if (!session) throw new NotFoundException('RESEARCH_CONVERSATION_NOT_FOUND');
      const [prior] = await tx.select().from(councilRecoveryRequests).where(and(eq(councilRecoveryRequests.owner, owner),
        eq(councilRecoveryRequests.requestKey, input.requestKey)));
      if (prior) { if (prior.inputHash !== hash) throw new ConflictException('REQUEST_KEY_CONFLICT'); return false; }
      if (session.revision !== input.expectedRevision) throw new ConflictException('RESEARCH_REVISION_CHANGED');
      const pending = session.checkpoint?.runtimePending?.find(item => item.runId === input.runtimeTarget.runId);
      if (!pending || pending.expectedCursor !== input.runtimeTarget.expectedCursor
        || input.runtimeTarget.stepId && pending.stepId !== input.runtimeTarget.stepId) throw new ConflictException('RUNTIME_TARGET_CHANGED');
      const run = await tx.execute(sql`select identity,policy,state,cursor from agent_runtime_runs
        where owner=${owner} and id=${pending.runId} for update`);
      const identity = run[0]?.identity as Record<string, unknown> | undefined;
      if (!identity || identity.sessionId !== sessionId || identity.cycleId !== session.checkpoint?.cycleId
        || identity.revision !== session.revision || input.action !== 'check_existing' && run[0].cursor !== pending.expectedCursor) throw new ConflictException('RUNTIME_TARGET_CHANGED');
      if (input.action === 'check_existing') {
        // Only reconcile local receipts/expired leases; this API never queries or resends synchronous model requests.
        const saved = await this.journal.recoverInTransaction(tx, owner, pending.runId);
        await tx.update(councilSessions).set({ checkpoint: { ...session.checkpoint!, runtimePending:
          session.checkpoint!.runtimePending!.map(item => item.runId === pending.runId
            ? { ...item, state: saved.state, expectedCursor: saved.cursor } : item) } }).where(eq(councilSessions.id, sessionId));
        await tx.insert(councilRecoveryRequests).values({ owner, sessionId, memberId: pending.memberId,
          requestKey: input.requestKey, inputHash: hash, action: 'runtime:check_existing', attemptId: pending.attemptId ?? null });
        return false;
      }
      if (session.status === 'running' || session.checkpoint?.simple?.stopped && input.action !== 'close_unknown') throw new ConflictException('RUNTIME_SESSION_NOT_RESUMABLE');
      await this.journal.authorizeResume(tx, owner, pending.runId, { action: input.action,
        expectedCursor: pending.expectedCursor, stepId: pending.stepId }, inner => this.actions.authorizeResume(inner, owner, pending.runId));
      const resumed = input.action !== 'close_unknown';
      const runtimePending = session.checkpoint!.runtimePending!.map(item => item.runId === pending.runId
        ? { ...item, state: resumed ? input.action === 'resume_approval' ? 'running' : 'failed' : 'settled_unknown', resumeRequested: resumed,
          expectedCursor: item.expectedCursor + 1 } : item).filter(item => item.state !== 'settled_unknown');
      await tx.update(councilSessions).set({ status: resumed ? 'running' : 'paused', error: null,
        checkpoint: { ...session.checkpoint!, runtimePending,
          ...(!resumed && session.checkpoint?.simple ? { simple: { ...session.checkpoint.simple, stopped: true } } : {}) },
        updatedAt: new Date() }).where(eq(councilSessions.id, sessionId));
      if (pending.attemptId) await tx.update(councilMemberAttempts).set({ status: resumed ? 'running' : 'cancelled',
        failure: resumed ? null : { code: 'RUNTIME_CLOSED_UNKNOWN_COST_RETAINED', stage: 'runtime', recoveries: [] },
        updatedAt: new Date() }).where(and(eq(councilMemberAttempts.owner, owner), eq(councilMemberAttempts.id, pending.attemptId)));
      await tx.insert(councilRecoveryRequests).values({ owner, sessionId, memberId: pending.memberId,
        requestKey: input.requestKey, inputHash: hash, action: `runtime:${input.action}`, attemptId: pending.attemptId ?? null });
      return resumed;
    });
  }

  async execute(input: { owner: string; row: Session; member: CouncilMember; prompt: ModelMessage[];
    context: Record<string, unknown>; evidence: CouncilEvidence[];
    shouldContinue(): Promise<boolean>; validate(text: string, evidence: CouncilEvidence[]): Promise<void>;
    activity(name: string, state: 'running' | 'succeeded' | 'failed'): Promise<void>;
  }): Promise<{ text: string; sources: CouncilEvidence[]; runId: string; tokens: number; usageUnknown: boolean }> {
    const { owner, row, member } = input;
    if (!row.checkpoint) throw new Error('RUNTIME_CHECKPOINT_REQUIRED');
    const identity = this.identity(owner, row, member);
    if (row.memberAttempt && !await new CouncilMemberAttemptsService(this.db).update(owner, row.memberAttempt.id,
      { status: 'running', startedAt: new Date() })) throw new Error('RUNTIME_SOURCE_OR_SCOPE_CHANGED');
    const toolScope: ResearchToolScope = { sessionId: row.id, revision: row.revision, memberId: member.id, memberName: member.name,
      managedRuntime: true,
      turn: row.checkpoint.nextTurn, ticker: row.ticker, language: row.language, webResearch: Boolean(row.profileSnapshot.council?.webResearch),
      expiresAt: Date.now() + 30 * 60_000, ...(row.memberAttempt ? { attemptId: row.memberAttempt.id } : {}) };
    let retained = await this.journal.find(identity);
    let request: ModelStepRequest;
    let dataClasses: AgentDataClass[] = ['public', ...(input.evidence.some(item => item.sourceName === 'Frozen owner context') ? ['portfolio' as const] : []),
      ...(input.evidence.some(item => item.libraryReferences?.length) ? ['private_material' as const] : [])];
    let sourceVersions: AgentToolScope['sourceVersions'] = [];
    for (const ref of libraryEvidenceReferences(input.evidence)) {
      const [version] = await this.db.select().from(dataLibraryVersions).where(and(eq(dataLibraryVersions.owner, owner), eq(dataLibraryVersions.id, ref.versionId), eq(dataLibraryVersions.sourceId, ref.sourceId)));
      if (!version) throw new Error('RUNTIME_SOURCE_OR_SCOPE_CHANGED');
      sourceVersions.push({ sourceId: ref.sourceId, sourceVersionId: ref.versionId, contentHash: version.contentHash });
    }
    if (retained) {
      if (!retained.initialRequest) throw new Error('RUNTIME_INITIAL_REQUEST_UNAVAILABLE');
      request = retained.initialRequest as ModelStepRequest;
      sourceVersions = retained.policy.sourceVersions as AgentToolScope['sourceVersions'];
      dataClasses = retained.policy.dataClasses as AgentDataClass[];
    } else {
      const choices = await this.db.execute(sql`select model_config,route from agent_runtime_execution_routes
        where owner=${owner} and identity_hash=${canonicalHash(identity)} and route in ('controlled','deep_agents')`);
      const config = choices[0]?.model_config as Awaited<ReturnType<ModelStepService['resolve']>> | undefined;
      if (!config) throw new Error('RUNTIME_EXECUTION_ROUTE_REQUIRED');
      const budget = await this.budgets.getSettings(owner);
      const bundle = await this.tools.bundle(owner, toolScope), external = await this.connections.freezeCatalog(owner);
      const builtin: AgentToolDescriptor[] = bundle.descriptors.map(tool => ({ id: `builtin:${tool.name}`, connectionId: null,
        catalogVersionId: 'builtin-research-v1', schemaHash: canonicalHash(tool.inputSchema), name: tool.name, description: tool.description,
        inputSchema: tool.inputSchema, effect: tool.effect ?? 'read', dataClasses: tool.name.includes('library') || tool.name.includes('browser') ? ['private_material'] : ['public'],
        timeoutMs: tool.timeoutMs ?? 60_000, maxOutputBytes: tool.maxOutputBytes ?? 24_000,
        supportsCancellation: ['browser_research', 'read_browser_source', 'run_statistics', 'run_backtest'].includes(tool.name),
        supportsStatusLookup: false, remoteIdempotency: 'unsupported' }));
      const driver = choices[0].route === 'deep_agents' ? 'deep_agents' : 'controlled';
      const granted = external.descriptors.filter(tool => dataClasses.every(kind => tool.dataClasses.includes(kind))
        && (driver !== 'deep_agents' || tool.effect !== 'external_write'));
      const catalog = catalogSnapshot([...builtin, ...granted], external.connectionRevisions);
      request = { ...config, owner, connectionRevision: 1, maxOutputTokens: budget.enabled ? Math.min(1800, budget.maxOutputTokens) : 1800,
        timeoutMs: 120_000, catalog,
        messages: [...input.prompt.filter(message => message.role === 'system'), { role: 'user',
          content: 'Use the complete immutable research context in the protected frozen-input message. Return only the requested final contribution JSON after any required tool calls.' }] };
      const frozenInput = freezeCouncilInput(input.evidence, input.context);
      for (const ref of sourceVersions) {
        const datasets = await this.db.select().from(researchDatasetVersions).where(and(
          eq(researchDatasetVersions.owner, owner), eq(researchDatasetVersions.sourceVersionId, ref.sourceVersionId)));
        for (const dataset of datasets) {
          const saved = await this.db.transaction(tx => readDataset(tx, owner, dataset.id));
          if (dataset.contentHash !== datasetContentHash(saved.metadata, saved.rows)) throw new Error('RUNTIME_DATASET_CHANGED');
          frozenInput.datasets.push({ datasetVersionId: dataset.id, contentHash: dataset.contentHash });
          frozenInput.datasetVersionIds.push(dataset.id);
          frozenInput.payload.sourcePayloads.push({ datasetVersionId: dataset.id, contentHash: dataset.contentHash,
            storageRef: dataset.metadata.storageRef, sourceVersionId: ref.sourceVersionId });
        }
      }
      frozenInput.payloadHash = canonicalHash(frozenInput.payload);
      const run = await this.journal.create({ identity, driver, frozenInput, initialRequest: request,
        policy: { loopOwner: 'runtime', maxModelRequestsPerStep: 1, sdkRetries: 0, sdkToolExecution: false, sdkToolApproval: false,
          providerExecutedWrites: false, fallback: null, maxSteps: 6, maxTools: 24, memberAttemptId: row.memberAttempt?.id ?? null,
          sourceVersions, dataClasses } });
      retained = await this.journal.read(owner, run.id);
    }
    const run = retained, frozen = run.frozenInput as RuntimeFrozenInputSnapshot;
    toolScope.frozenInstrumentIds = frozen.payload.holdings.map(item => item.instrumentId);
    toolScope.frozenAccountIds = [...new Set([...frozen.payload.holdings.map(item => item.accountId), ...frozen.payload.cash.map(item => item.accountId)])];
    const scope: AgentToolScope = { owner, runId: run.id, sessionId: row.id, revision: row.revision, leaseToken: '',
      allowedInstrumentIds: frozen.payload.holdings.map(item => item.instrumentId),
      allowedAccountIds: [...new Set([...frozen.payload.holdings.map(item => item.accountId), ...frozen.payload.cash.map(item => item.accountId)])],
      allowedDataClasses: dataClasses, sourceVersions, permissionRevision: row.revision };
    const currentAuthority = async (original: AgentToolScope): Promise<AgentToolScope> => {
      const [current] = await this.db.select().from(councilSessions).where(and(eq(councilSessions.owner, owner),
        eq(councilSessions.id, row.id), isNull(councilSessions.deletedAt)));
      if (!current) throw new Error('RUNTIME_SOURCE_OR_SCOPE_CHANGED');
      const own = current.checkpoint?.simple?.stage === 'independent'
        ? [...input.evidence, ...(current.checkpoint.simple.privateEvidence?.[member.id] ?? [])]
        : [...input.evidence, ...current.evidenceSnapshot];
      const refs = new Map(original.sourceVersions.map(ref => [ref.sourceVersionId, ref]));
      for (const ref of libraryEvidenceReferences(own)) {
        const [version] = await this.db.select().from(dataLibraryVersions).where(and(eq(dataLibraryVersions.owner, owner),
          eq(dataLibraryVersions.id, ref.versionId), eq(dataLibraryVersions.sourceId, ref.sourceId)));
        if (!version) throw new Error('RUNTIME_SOURCE_OR_SCOPE_CHANGED');
        refs.set(version.id, { sourceId: ref.sourceId, sourceVersionId: version.id, contentHash: version.contentHash });
      }
      const policies = await this.db.transaction(tx => assertSourceVersions(tx, owner, [...refs.values()]));
      return { ...original, sourceVersions: [...refs.values()].sort((a, b) => a.sourceVersionId.localeCompare(b.sourceVersionId)),
        allowedDataClasses: [...new Set([...dataClasses, ...policies.flatMap(policy => policy.dataClasses)])].sort() };
    };
    const verify = async (descriptor?: AgentToolDescriptor): Promise<void> => {
      if (!await this.capabilities.enabled(owner, member.connectionId, member.model)) throw new Error('RUNTIME_CAPABILITY_REVOKED');
      const config = await this.model.resolve(owner, member.connectionId, member.model);
      if (config.connectionConfigHash !== request.connectionConfigHash) throw new Error('MODEL_CONNECTION_CHANGED');
      if (!await input.shouldContinue() || !await this.tools.isCurrent(owner, toolScope)) throw new Error('RUNTIME_SOURCE_OR_SCOPE_CHANGED');
      if (!await libraryEvidenceAvailable(this.db, owner, input.evidence)) throw new Error('RUNTIME_SOURCE_OR_SCOPE_CHANGED');
      const authority = await currentAuthority(scope);
      if (descriptor?.connectionId && !authority.allowedDataClasses.every(kind => descriptor.dataClasses.includes(kind))) {
        throw new Error('TOOL_DATA_EGRESS_NOT_AUTHORIZED');
      }
      for (const ref of frozen.datasets) {
        const saved = await this.db.transaction(tx => readDataset(tx, owner, ref.datasetVersionId));
        if (saved.metadata.contentHash !== ref.contentHash || datasetContentHash(saved.metadata, saved.rows) !== ref.contentHash) {
          throw new Error('RUNTIME_DATASET_CHANGED');
        }
      }
    };
    const ports: RuntimeLoopPorts = { dispatch: this.dispatch,
      shouldContinue: input.shouldContinue, assertScope: async (_scope, _stage, descriptor) => verify(descriptor),
      tools: {
        invoke: async (descriptor, args, _scope, invocationId, signal) => {
          await input.activity(descriptor.name, 'running');
          try {
            let result: unknown;
            const authority = await currentAuthority(_scope);
            if (descriptor.connectionId === null) result = this.tools.runtimeEnvelope(await this.tools.call(owner, { ...toolScope, runtimeScope: authority },
              { callId: invocationId, name: descriptor.name, arguments: args }, { signal, shouldContinue: input.shouldContinue,
                telemetryContext: { runId: run.id, sourceId: row.taskId ?? row.id, parentId: invocationId } }), invocationId);
            else {
              if (!authority.allowedDataClasses.every(kind => descriptor.dataClasses.includes(kind))) throw new Error('TOOL_DATA_EGRESS_NOT_AUTHORIZED');
              const remote = await this.connections.invokeFrozen(owner, descriptor, request.catalog.connectionRevisions[descriptor.connectionId], args,
                { invocationId, signal, beforeDispatch: () => verify(descriptor) });
              if (remote.receipt.state !== 'completed') throw new Error('TOOL_PROVIDER_RESULT_UNKNOWN');
              const accepted = await this.tools.acceptExternalResult(owner, toolScope, descriptor, {
                status: 'succeeded', data: { output: remote.output, dataAsOf: remote.dataAsOf, providerReceipt: remote.receipt },
                sources: [{ title: descriptor.name, fetchedAt: remote.observedAt }], asOf: remote.observedAt, truncated: false });
              result = { ...this.tools.runtimeEnvelope(accepted, invocationId), usage: remote.usage ?? null };
            }
            await input.activity(descriptor.name, 'succeeded'); return result;
          } catch (error) { await input.activity(descriptor.name, 'failed'); throw error; }
        },
        receipts: {
          beforeDispatch: async (tx, invocation) => { await this.toolBudgets.reserve(owner, run.id, invocation.invocationId,
            { quantity: 1, unit: 'calls', priceVersion: 'operation-only-v1' }, tx); },
          received: async (who, invocationId) => this.toolBudgets.settle(who, invocationId, 1),
          unknown: async (who, invocationId) => this.toolBudgets.markUnknown(who, invocationId),
        },
      },
      approvals: { park: async batch => {
        const approvalScope = await currentAuthority(batch.scope);
        const previews: Array<{ call: typeof batch.calls[number]; preview: ToolActionPreview }> = [];
        for (const call of batch.calls) {
          let preview = await this.actions.findCall(owner, run.id, batch.stepId, call.id);
          const descriptor = request.catalog.descriptors.find(tool => tool.id === call.toolId)!;
          if (!preview) {
            const [connection] = await this.db.select().from(toolConnections).where(and(eq(toolConnections.owner, owner), eq(toolConnections.id, descriptor.connectionId!)));
            if (!connection) throw new Error('TOOL_CONNECTION_UNAVAILABLE');
            const accountId = connection.providerConfig?.connectedAccountId ?? connection.id;
            const target = String(call.arguments.to ?? call.arguments.recipient ?? call.arguments.page_id ?? call.arguments.parent_id ?? descriptor.name).slice(0, 4000);
            preview = await this.actions.prepare(owner, { runId: run.id, stepId: batch.stepId, toolCallId: call.id, descriptor,
              connectionRevision: request.catalog.connectionRevisions[descriptor.connectionId!], args: call.arguments, scope: approvalScope,
              accountId, target, attachments: [], costLimit: { maxCalls: 1, maxAmount: null, currency: null }, resourceVersion: null }, true);
          }
          if (preview.state === 'redacted' || preview.state === 'rejected') throw new Error('TOOL_ACTION_SOURCE_OR_APPROVAL_UNAVAILABLE');
          previews.push({ call, preview });
        }
        if (previews.some(item => item.preview.state !== 'approved' && item.preview.state !== 'completed')) return { status: 'waiting_approval', results: [] };
        const results: Array<{ call: typeof batch.calls[number]; result: unknown }> = [];
        for (const item of previews) {
          const descriptor = item.preview.descriptor;
          const saved = await this.invocations.execute({ owner, runId: run.id, stepId: batch.stepId, leaseToken: batch.scope.leaseToken,
            descriptor, call: { ...item.call, arguments: item.preview.args } }, async invocationId => {
            const result = await this.connections.invokeFrozen(owner, descriptor, item.preview.connectionRevision, item.preview.args,
              { invocationId, beforeDispatch: () => verify(descriptor) });
            if (result.receipt.state !== 'completed') throw new Error('TOOL_ACTION_PROVIDER_UNKNOWN');
            const envelope = this.tools.runtimeEnvelope({ status: 'succeeded', data: { output: result.output,
              dataAsOf: result.dataAsOf, providerReceipt: result.receipt }, sources: [{ title: descriptor.name, fetchedAt: result.observedAt }],
              asOf: result.observedAt, truncated: false }, invocationId);
            return { ...envelope, usage: result.usage ?? null, effectivePayloadHash: item.preview.payloadHash, effectiveArguments: item.preview.args };
          }, { ...ports.tools.receipts,
            authorizeWrite: async (tx, invocation) => { await this.actions.claimInTransaction(tx, { owner, runId: run.id, stepId: batch.stepId,
              toolCallId: item.call.id, invocationId: invocation.invocationId, toolId: descriptor.id,
              argumentsHash: canonicalHash(item.preview.args), catalogVersionId: descriptor.catalogVersionId,
              connectionRevision: item.preview.connectionRevision, scope: { ...approvalScope, leaseToken: batch.scope.leaseToken } }); },
            received: async (who, id, result) => { await ports.tools.receipts?.received?.(who, id, result); await this.actions.settle(who, id, { state: 'completed' }); },
            unknown: async (who, id) => { await ports.tools.receipts?.unknown?.(who, id); await this.actions.settle(who, id, { state: 'unknown' }); },
          });
          results.push({ call: item.call, result: saved.result });
        }
        return { status: 'completed', results };
      } },
    };
    let sources: CouncilEvidence[] = [];
    const runtime = new ResearchRuntimeService(this.journal, this.model, this.invocations, ports);
    const executeRuntime = (execution: RuntimeExecuteInput) => run.driver === 'deep_agents'
      ? this.deepDriver ? this.deepDriver.execute(execution, ports) : Promise.reject(new Error('DEEP_AGENT_DRIVER_UNAVAILABLE'))
      : runtime.execute(execution);
    let result: Awaited<ReturnType<ResearchRuntimeService['execute']>>;
    try { result = await executeRuntime({ owner, runId: run.id, modelRequest: request, scope,
      validateFinal: async text => {
        const [current] = await this.db.select().from(councilSessions).where(and(eq(councilSessions.owner, owner), eq(councilSessions.id, row.id), isNull(councilSessions.deletedAt)));
        if (!current) throw new Error('RUNTIME_SOURCE_OR_SCOPE_CHANGED');
        const available = current.checkpoint?.simple?.stage === 'independent'
          ? [...input.evidence, ...(current.checkpoint.simple.privateEvidence?.[member.id] ?? [])]
          : [...input.evidence, ...current.evidenceSnapshot];
        const unique = [...new Map(available.map(item => [item.id, item])).values()];
        const last = (await this.journal.read(owner, run.id)).steps.at(-1);
        if (!last) throw new Error('RUNTIME_RESPONSE_REQUIRED');
        sources = await this.journal.freezeEvidence(owner, run.id, last.id, unique);
        if (!await libraryEvidenceAvailable(this.db, owner, sources)) throw new Error('RUNTIME_SOURCE_OR_SCOPE_CHANGED');
        await input.validate(text, sources);
      } }); } catch {
      throw new ResearchRuntimeSuspended(run.id, (await this.journal.read(owner, run.id)).state);
    }
    if (result.status !== 'accepted' || !result.text) throw new ResearchRuntimeSuspended(run.id, result.status);
    const finished = await this.journal.read(owner, run.id);
    let tokens = 0, usageUnknown = false;
    for (const step of finished.steps) {
      const response = await this.journal.response(owner, run.id, step.id) as {
        usage?: { inputTokens: number | null; outputTokens: number | null; totalTokens: number | null } | null;
      };
      const usage = response.usage;
      if (!usage || !Number.isSafeInteger(usage.inputTokens) || usage.inputTokens === null || usage.inputTokens <= 0
        || !Number.isSafeInteger(usage.outputTokens) || usage.outputTokens === null || usage.outputTokens < 0
        || !Number.isSafeInteger(usage.totalTokens) || usage.totalTokens === null || usage.totalTokens < usage.inputTokens + usage.outputTokens) usageUnknown = true;
      else tokens += usage.totalTokens;
    }
    return { text: result.text, sources, runId: run.id, tokens, usageUnknown };
  }
}
