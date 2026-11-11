import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '../../common/platform';
import { agentRuntimeRuns } from '../../database/agent-tooling.schema';
import type { AgentDataClass, AgentSourceVersionRef, AgentToolScope } from '../../../shared/agent-tooling.interface';
import type { ResearchArtifact } from '../../../shared/research-artifact.interface';
import { readDataset } from '../data-library/data-dataset.service';
import { ResearchArtifactsService } from '../research-artifacts/research-artifacts.service';
import { earliestRetention, hashContent, intersectUses, sourceRefs } from '../research-artifacts/research-artifacts.rules';
import { ComputeJobsService } from './compute-jobs.service';
import { E2bAdapter, ComputeE2bError } from './e2b.adapter';
import { ANALYTICS_DEPENDENCIES, assertDatasetComputeInput, computeRequestSchema, statisticsParameters } from './compute-policy';
import type { ComputeRequest } from './compute-policy';
import { backtestDatasetIds, parseBacktestParameters } from './backtest-contract';
import { summarizeComputeResult } from './compute-result-summary';

interface PreparedCompute {
  manifest: Record<string, unknown>; files: Array<{ name: string; base64: string }>;
  dependencies: AgentSourceVersionRef[]; dataClasses: AgentDataClass[]; permittedUses: string[];
  retentionUntil: string | null; datasetVersionIds: string[]; contentHashes: Record<string, string>;
  maxRuntimeMs: number; kind: ComputeRequest['kind']; code: string;
  policyHashes: Record<string, string>;
}

/** Cloud execution accepts only server-read immutable datasets; summaries are never a compute input. */
@Injectable()
export class ResearchComputeService {
  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly jobs: ComputeJobsService, private readonly sandbox: E2bAdapter,
    private readonly artifacts: ResearchArtifactsService) {}

  configuration() { return { provider: 'e2b', status: this.sandbox.status(), template: this.sandbox.template(),
    dependencyVersions: ANALYTICS_DEPENDENCIES, maxRuntimeMs: 120_000, maxDailyJobs: 10,
    network: 'disabled', costsKnown: false }; }

  private async prepare(owner: string, request: ComputeRequest, scope?: AgentToolScope): Promise<PreparedCompute> {
    if (scope && (scope.owner !== owner || scope.runId !== request.runId)) throw new Error('COMPUTE_SCOPE_MISMATCH');
    if (request.kind === 'statistics') {
      const parameters = statisticsParameters(request.parameters);
      if (parameters.inputKind === 'prices' && parameters.calendarDatasetVersionId
        && !request.datasetVersionIds.includes(parameters.calendarDatasetVersionId)) throw new Error('PRICE_CALENDAR_DATASET_REQUIRED');
    }
    if (request.kind === 'backtest') {
      const backtest = parseBacktestParameters(request.parameters);
      if (backtestDatasetIds(backtest).some(id => !request.datasetVersionIds.includes(id))) throw new Error('BACKTEST_DATASET_VERSION_REQUIRED');
    }
    return this.db.transaction(async tx => {
      const inputs = [];
      for (const id of request.datasetVersionIds) {
        const input = await readDataset(tx, owner, id);
        assertDatasetComputeInput(input.metadata, input.rows, request.expectedContentHashes[id]);
        if (scope && input.metadata.dataClasses.some(value => !scope.allowedDataClasses.includes(value))) throw new Error('COMPUTE_DATA_CLASS_DENIED');
        if (scope && [input.metadata.sourceVersion, ...input.metadata.dependencies].some(ref => !scope.sourceVersions.some(
          allowed => hashContent(allowed) === hashContent(ref)))) throw new Error('COMPUTE_SOURCE_SCOPE_DENIED');
        inputs.push(input);
      }
      const dependencies = sourceRefs(inputs.flatMap(input => [input.metadata.sourceVersion, ...input.metadata.dependencies]));
      const dataClasses = [...new Set(inputs.flatMap(input => input.metadata.dataClasses))].sort();
      const permittedUses = intersectUses(inputs.map(input => input.metadata.license.permittedUses));
      const retentionUntil = earliestRetention(inputs.map(input => input.metadata.license.retentionUntil));
      const statistics = request.kind === 'statistics' ? statisticsParameters(request.parameters) : null;
      if (statistics && statistics.inputKind !== 'prices' && inputs[0].metadata.schemaVersion === 'financial-row-v1') {
        throw new Error('FINANCIAL_PRICES_REQUIRE_PRICE_TO_RETURN_TEMPLATE');
      }
      if (statistics?.inputKind === 'prices') {
        const adjustment = inputs[0].metadata.adjustment;
        const expected = { unadjusted: 'unadjusted-price-only', forward: 'provider-adjusted-price',
          backward: 'provider-adjusted-price', total_return: 'total-return-index' }[adjustment];
        if (!expected || expected !== statistics.returnBasis) throw new Error('PRICE_ADJUSTMENT_BASIS_MISMATCH');
        const calendar = inputs.find(input => input.metadata.id === statistics.calendarDatasetVersionId);
        if (statistics.calendarDatasetVersionId && calendar?.metadata.coverage.status !== 'complete') throw new Error('PRICE_CALENDAR_INCOMPLETE');
      }
      const templateId = request.kind === 'statistics' ? statistics.inputKind === 'prices' ? 'prices-to-returns-v1' : 'returns-v1'
        : request.kind === 'exploratory' ? 'free-code-v1'
        : parseBacktestParameters(request.parameters).templateId;
      const code = request.kind === 'exploratory' ? request.code : `# Squabble fixed template ${templateId} version 1\n`;
      const codeHash = createHash('sha256').update(code).digest('hex');
      const files = inputs.map((input, ordinal) => ({ name: `dataset-${ordinal}.json`, data: Buffer.from(JSON.stringify(input.rows)) }));
      if (files.reduce((sum, file) => sum + file.data.length, 0) > 32 * 1024 * 1024) throw new Error('COMPUTE_INPUT_LIMIT');
      const manifest = { version: 1, kind: request.kind, templateId, templateVersion: '1',
        codeHash, codePath: 'code.py', seed: request.seed, parameters: request.parameters,
        effectiveDataClasses: dataClasses, permittedUses, sourceVersions: dependencies,
        dependencies: { ...ANALYTICS_DEPENDENCIES, e2bTemplate: this.sandbox.template()?.version ?? 'unconfigured' },
        limits: { maxRuntimeMs: request.maxRuntimeMs, maxOutputBytes: 16 * 1024 * 1024 },
        datasets: inputs.map((input, ordinal) => ({ datasetVersionId: input.metadata.id, contentHash: input.metadata.contentHash,
          fileSha256: createHash('sha256').update(files[ordinal].data).digest('hex'), path: files[ordinal].name,
          rowCount: input.rows.length, dataClasses: input.metadata.dataClasses, permittedUses: input.metadata.license.permittedUses,
          coverage: input.metadata.coverage, adjustment: input.metadata.adjustment, schema: input.metadata.schema })) };
      files.push({ name: 'code.py', data: Buffer.from(code) });
      return { manifest, files: files.map(file => ({ name: file.name, base64: file.data.toString('base64') })),
        dependencies, dataClasses, permittedUses, retentionUntil, datasetVersionIds: request.datasetVersionIds,
        contentHashes: request.expectedContentHashes, maxRuntimeMs: request.maxRuntimeMs, kind: request.kind, code,
        policyHashes: Object.fromEntries(inputs.map(input => [input.metadata.id,
          hashContent({ dataClasses: input.metadata.dataClasses, license: input.metadata.license })])) };
    });
  }

  private async revalidate(owner: string, input: PreparedCompute, scope?: AgentToolScope): Promise<void> {
    await this.db.transaction(async tx => {
      for (const id of input.datasetVersionIds) {
        const current = await readDataset(tx, owner, id);
        assertDatasetComputeInput(current.metadata, current.rows, input.contentHashes[id]);
        if (hashContent({ dataClasses: current.metadata.dataClasses, license: current.metadata.license }) !== input.policyHashes[id]) {
          throw new Error('COMPUTE_INPUT_POLICY_CHANGED');
        }
        if (scope && current.metadata.dataClasses.some(value => !scope.allowedDataClasses.includes(value))) throw new Error('COMPUTE_DATA_CLASS_DENIED');
      }
    });
  }

  private async assertParent(scope: AgentToolScope | undefined,
    database: Pick<PostgresJsDatabase, 'select'> = this.db): Promise<void> {
    if (!scope) return;
    const [run] = await database.select().from(agentRuntimeRuns).where(and(eq(agentRuntimeRuns.owner, scope.owner),
      eq(agentRuntimeRuns.id, scope.runId)));
    if (!run || run.cancelRequested || !['running', 'result_received'].includes(run.state)
      || run.leaseToken !== scope.leaseToken || !run.leaseUntil || run.leaseUntil <= new Date()
      || run.identity.sessionId !== scope.sessionId || run.identity.revision !== scope.revision) throw new Error('COMPUTE_PARENT_STOPPED');
  }

  async run(owner: string, raw: unknown, scope?: AgentToolScope, signal?: AbortSignal) {
    if (signal?.aborted) throw new Error('COMPUTE_CANCELLED');
    const request = computeRequestSchema.parse(raw);
    if (this.sandbox.status() !== 'configured') throw new Error('E2B_UNCONFIGURED');
    const prepared = await this.prepare(owner, request, scope);
    const job = await this.jobs.create(owner, { runId: request.runId, requestKey: request.requestKey,
      requestHash: hashContent(request), kind: request.kind, maxRuntimeMs: request.maxRuntimeMs, payload: prepared,
      sourceVersionIds: prepared.dependencies.map(ref => ref.sourceVersionId), datasetVersionIds: prepared.datasetVersionIds,
      retentionUntil: prepared.retentionUntil });
    if (signal?.aborted) { await this.jobs.cancel(owner, job.id); return this.jobs.receipt(owner, job.id); }
    if (!await this.jobs.claim(owner, job.id)) return this.status(owner, job.id);
    const saved: ResearchArtifact[] = [];
    let resultArtifact: ResearchArtifact | null = null;
    let executionTerminated = false;
    const cancel = () => { void this.jobs.cancel(owner, job.id).catch(() => {}); };
    signal?.addEventListener('abort', cancel, { once: true });
    const shouldContinue = async () => {
      if (signal?.aborted || (await this.jobs.read(owner, job.id)).cancelRequested) {
        await this.jobs.cancel(owner, job.id); return false;
      }
      try { await this.assertParent(scope); }
      catch { await this.jobs.cancel(owner, job.id); return false; }
      await this.revalidate(owner, prepared, scope);
      return true;
    };
    try {
      // Re-read after the durable creation intent and immediately before cloud egress.
      await this.revalidate(owner, prepared, scope);
      if (!await shouldContinue()) throw new ComputeE2bError('COMPUTE_CANCELLED', null, true);
      const execution = await this.sandbox.run({ jobId: job.id, manifest: prepared.manifest,
        files: prepared.files.map(file => ({ name: file.name, data: Buffer.from(file.base64, 'base64') })),
        maxRuntimeMs: prepared.maxRuntimeMs, maxOutputBytes: 16 * 1024 * 1024 },
      id => this.jobs.created(owner, job.id, id), shouldContinue);
      executionTerminated = execution.terminationConfirmed;
      await this.revalidate(owner, prepared, scope);
      if (!await shouldContinue()) throw new ComputeE2bError('COMPUTE_CANCELLED', execution.sandboxId, true);
      const base = { runId: request.runId, dependencies: prepared.dependencies, datasetVersionIds: prepared.datasetVersionIds,
        dataClasses: prepared.dataClasses, permittedUses: prepared.permittedUses, retentionUntil: prepared.retentionUntil };
      const manifestArtifact = await this.artifacts.create(owner, { ...base, type: 'manifest', mime: 'application/json',
        data: Buffer.from(JSON.stringify({ ...prepared.manifest, stdout: execution.stdout, stderr: execution.stderr,
          sandboxTerminationConfirmed: true, providerCost: null })) });
      saved.push(manifestArtifact);
      const codeArtifact = await this.artifacts.create(owner, { ...base, type: 'code', mime: 'text/plain', data: Buffer.from(prepared.code) });
      saved.push(codeArtifact);
      for (const file of execution.files) {
        if (!await shouldContinue()) throw new ComputeE2bError('COMPUTE_CANCELLED', execution.sandboxId, true);
        const artifact = await this.artifacts.create(owner, { ...base, type: file.mime === 'image/png' ? 'chart' : 'table',
          mime: file.mime, data: file.data });
        saved.push(artifact);
        if (file.name === 'result.json' && file.mime === 'application/json') resultArtifact = artifact;
      }
      if (!await shouldContinue()) throw new ComputeE2bError('COMPUTE_CANCELLED', execution.sandboxId, true);
      if (!resultArtifact) throw new Error('COMPUTE_RESULT_ARTIFACT_REQUIRED');
      const stored = await this.artifacts.download(owner, resultArtifact.id);
      const summary = summarizeComputeResult(request.kind, String(prepared.manifest.templateId), JSON.parse(stored.data.toString('utf8')));
      const accepted = await this.jobs.complete(owner, job.id, { ...summary,
      classification: request.kind === 'exploratory' ? 'exploratory'
        : request.kind === 'statistics' ? 'reproduced-calculation' : 'hypothetical-validated-template-backtest',
      manifestArtifactId: manifestArtifact.id, codeArtifactId: codeArtifact.id,
      resultArtifact: { artifactId: resultArtifact.id, sha256: resultArtifact.sha256 },
      artifacts: saved.map(artifact => ({ artifactId: artifact.id, sha256: artifact.sha256, type: artifact.type })),
      stdout: execution.stdout, stderr: execution.stderr }, async tx => {
        if (signal?.aborted) throw new Error('COMPUTE_CANCELLED');
        await this.assertParent(scope, tx);
        if (signal?.aborted) throw new Error('COMPUTE_CANCELLED');
      });
      if (!accepted) {
        for (const artifact of saved) await this.artifacts.discard(owner, artifact.id).catch(() => {});
        return this.jobs.receipt(owner, job.id);
      }
      return this.status(owner, job.id);
    } catch (error) {
      for (const artifact of saved) await this.artifacts.discard(owner, artifact.id).catch(() => {});
      const failure = error instanceof ComputeE2bError ? error : null;
      await this.jobs.fail(owner, job.id, failure?.code ?? 'COMPUTE_LOCAL_VALIDATION_OR_SAVE_FAILED',
        failure?.terminationConfirmed ?? (executionTerminated || !(await this.jobs.read(owner, job.id)).sandboxId),
        { stdout: failure?.stdout, stderr: failure?.stderr, sandboxId: failure?.sandboxId ?? undefined });
      return this.jobs.receipt(owner, job.id);
    } finally { signal?.removeEventListener('abort', cancel); }
  }
  async status(owner: string, id: string) {
    const job = await this.jobs.read(owner, id);
    const input = await this.jobs.input(owner, id) as PreparedCompute;
    if (!Array.isArray(input.datasetVersionIds)) throw new Error('COMPUTE_INPUT_REVOKED');
    await this.revalidate(owner, input);
    return this.jobs.status(owner, job.id);
  }
  async cancel(owner: string, id: string) { await this.jobs.cancel(owner, id); return this.jobs.receipt(owner, id); }
  async cleanup(owner: string, id: string) {
    const job = await this.jobs.read(owner, id);
    if (job.sandboxId && !job.terminationConfirmed) {
      try { await this.sandbox.kill(job.sandboxId); await this.jobs.confirmTermination(owner, id); }
      catch { await this.jobs.fail(owner, id, 'E2B_CLEANUP_UNKNOWN', false); }
    }
    return this.jobs.receipt(owner, id);
  }
}
