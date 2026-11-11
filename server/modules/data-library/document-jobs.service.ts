import { Inject, Injectable, Optional } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { and, desc, eq, gt, isNull, or, sql } from 'drizzle-orm';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '../../common/platform';
import { dataLibrarySources as sources, dataLibraryVersions as versions, dataLibraryJobs as jobs } from '../../database/data-library.schema';
import { researchDocumentExtractions as extractions, researchDocumentTasks as tasks } from '../../database/research-artifacts.schema';
import { ResearchArtifactsService } from '../research-artifacts/research-artifacts.service';
import { assertSourceVersions, canonicalJson, hashContent, type SourceDatabase } from '../research-artifacts/research-artifacts.rules';
import type { DocumentExtractor, DocumentTaskReceipt, DocumentTaskStatus, DocumentUpload } from './documents/document-client.interface';
import { validateDocumentUpload } from './documents/document-client.interface';
import { extractDocumentElements, documentSearchText } from './documents/document-provenance';
import { validateDocumentNumbers } from './documents/document-validation';
import { MineruClient } from './documents/mineru-client';
import type { DataDocumentStatus } from '../../../shared/data-library.interface';
import { ToolCapabilityGrantsService } from '../tool-capabilities/tool-capability-grants.service';

export const DOCUMENT_EXTRACTORS = Symbol('DOCUMENT_EXTRACTORS');
type DocumentTask = typeof tasks.$inferSelect;
@Injectable()
export class DocumentJobsService {
  private readonly extractors: Map<string, DocumentExtractor>;
  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly artifacts: ResearchArtifactsService,
    @Optional() @Inject(DOCUMENT_EXTRACTORS) extractors: DocumentExtractor[] = [],
    @Optional() private readonly capabilities?: ToolCapabilityGrantsService) {
    this.extractors = new Map(extractors.map(extractor => [extractor.id, extractor]));
  }
  private extractor(id: string, version?: string): DocumentExtractor {
    const extractor = this.extractors.get(id);
    if (!extractor || version && extractor.version !== version) throw new Error('DOCUMENT_EXTRACTOR_UNAVAILABLE');
    return extractor;
  }
  available(): Array<{ id: string; version: string }> {
    return [...this.extractors.values()].map(extractor => ({ id: extractor.id, version: extractor.version }));
  }
  async describe(owner: string, sourceId: string, versionId?: string): Promise<DataDocumentStatus> {
    const [source] = await this.db.select().from(sources).where(and(eq(sources.owner, owner), eq(sources.id, sourceId), isNull(sources.deletedAt)));
    if (!source) throw new Error('DOCUMENT_SOURCE_NOT_FOUND');
    const [task] = await this.db.select().from(tasks).where(and(eq(tasks.owner, owner), eq(tasks.sourceId, sourceId))).orderBy(desc(tasks.createdAt)).limit(1);
    const [extraction] = source.enabled ? await this.db.select().from(extractions).where(and(eq(extractions.owner, owner),
      eq(extractions.sourceId, sourceId), eq(extractions.sourceVersionId, versionId ?? source.latestVersionId ?? randomUUID()))).limit(1) : [];
    const metadata = extraction?.metadata, validation = metadata?.numericValidation as { status?: string } | undefined;
    return { extractors: this.available(), job: task ? { id: task.jobId, state: task.state } : null,
      extraction: extraction && Array.isArray(metadata?.elements) ? { extractor: extraction.extractor,
        extractorVersion: extraction.extractorVersion, originalHash: extraction.originalHash, artifactId: extraction.artifactId,
        elements: metadata.elements as DataDocumentStatus['extraction']['elements'],
        numericValidation: validation?.status === 'verified' ? 'verified' : validation?.status === 'needs_review' ? 'needs_review' : 'unknown' } : null };
  }
  private async fence(db: SourceDatabase, task: DocumentTask): Promise<typeof sources.$inferSelect> {
    await this.requireCapability(task, db);
    const [source] = await db.select().from(sources).where(and(eq(sources.id, task.sourceId), eq(sources.owner, task.owner),
      eq(sources.enabled, true), isNull(sources.deletedAt), eq(sources.revision, task.sourceRevision),
      eq(sources.activeJobId, task.jobId), eq(sources.leaseToken, task.leaseToken), gt(sources.leaseUntil, new Date()))).for('update');
    if (!source) throw new Error('DOCUMENT_SOURCE_OR_LEASE_CHANGED');
    await assertSourceVersions(db, task.owner, [{ sourceId: task.sourceId, sourceVersionId: task.sourceVersionId, contentHash: task.sourceHash }]);
    return source;
  }
  private async requireCapability(task: DocumentTask, db?: SourceDatabase): Promise<void> {
    if (process.env.TOOL_CAPABILITIES_BUNDLE_ENABLED !== 'true') return;
    const match = /^capability:(\d+):/u.exec(task.configVersion);
    if (!this.capabilities || !match || !Number.isSafeInteger(Number(match[1]))) throw new Error('TOOL_CAPABILITY_REVIEW_REQUIRED');
    await this.capabilities.requireCurrent(task.owner, 'documents', Number(match[1]), ['private_material'], db);
  }
  async start(owner: string, sourceId: string, extractorId: string, configVersion: string): Promise<{ jobId: string; state: string }> {
    const extractor = this.extractor(extractorId);
    if (!/^[A-Za-z0-9._-]{1,100}$/u.test(configVersion)) throw new Error('DOCUMENT_CONFIG_VERSION_REQUIRED');
    const bundled = process.env.TOOL_CAPABILITIES_BUNDLE_ENABLED === 'true';
    if (bundled && !this.capabilities) throw new Error('TOOL_CAPABILITY_DISABLED');
    const grant = bundled ? await this.capabilities!.require(owner, 'documents', ['private_material']) : null;
    const boundConfigVersion = grant ? `capability:${grant.revision}:${configVersion}` : configVersion;
    const claim = await this.db.transaction(async tx => {
      if (grant) await this.capabilities!.requireCurrent(owner, 'documents', grant.revision, ['private_material'], tx);
      const [source] = await tx.select().from(sources).where(and(eq(sources.id, sourceId), eq(sources.owner, owner),
        eq(sources.enabled, true), isNull(sources.deletedAt))).for('update');
      if (!source || !source.fileData || !source.latestVersionId) throw new Error('DOCUMENT_SOURCE_NOT_FOUND');
      if (source.leaseUntil && source.leaseUntil > new Date()) throw new Error('DOCUMENT_JOB_ALREADY_RUNNING');
      if (source.activeJobId) {
        const [existing] = await tx.select().from(tasks).where(eq(tasks.jobId, source.activeJobId));
        if (existing && ['submitting', 'submitted', 'provider_unknown'].includes(existing.state)) throw new Error('DOCUMENT_JOB_ALREADY_RUNNING');
      }
      const [version] = await tx.select().from(versions).where(and(eq(versions.id, source.latestVersionId), eq(versions.owner, owner),
        eq(versions.sourceId, sourceId)));
      if (!version) throw new Error('DOCUMENT_SOURCE_VERSION_NOT_FOUND');
      const file: DocumentUpload = { fileName: source.fileName!, mime: source.mimeType as DocumentUpload['mime'], data: Buffer.from(source.fileData, 'base64') };
      validateDocumentUpload(file);
      const token = randomUUID(), [job] = await tx.insert(jobs).values({ owner, sourceId, state: 'running', leaseToken: token }).returning();
      const [task] = await tx.insert(tasks).values({ jobId: job.id, owner, sourceId, sourceVersionId: version.id,
        sourceHash: version.contentHash, sourceRevision: source.revision, leaseToken: token,
        originalHash: createHash('sha256').update(file.data).digest('hex'), extractor: extractor.id,
        extractorVersion: extractor.version, configVersion: boundConfigVersion, state: 'submitting' }).returning();
      await tx.update(sources).set({ activeJobId: job.id, leaseToken: token, leaseUntil: new Date(Date.now() + 10 * 60_000), state: 'syncing' }).where(eq(sources.id, sourceId));
      return { task, file };
    });
    // Submission is never replayed automatically: a broken response may still have created remote work.
    try {
      await this.requireCapability(claim.task);
      const persistReceipt = (receipt: DocumentTaskReceipt) => this.persistReceipt(claim.task, extractor, receipt);
      const receipt = await extractor.submit(claim.file, persistReceipt);
      await persistReceipt(receipt);
      return { jobId: claim.task.jobId, state: 'submitted' };
    } catch (error) {
      await this.db.update(tasks).set({ state: 'provider_unknown' }).where(and(eq(tasks.jobId, claim.task.jobId), eq(tasks.state, 'submitting')));
      throw error;
    }
  }
  private async persistReceipt(task: DocumentTask, extractor: DocumentExtractor, raw: DocumentTaskReceipt): Promise<void> {
    const validId = (value: unknown): value is string => typeof value === 'string' &&
      value.length > 0 && value.length <= 1024 && !/[\u0000-\u001f\u007f]/u.test(value);
    if (!raw || !validId(raw.taskId) || raw.fileId !== undefined && !validId(raw.fileId)) {
      throw new Error('DOCUMENT_INVALID_RECEIPT');
    }
    const receipt: DocumentTaskReceipt = { taskId: raw.taskId, ...(raw.fileId === undefined ? {} : { fileId: raw.fileId }) };
    // Settlement identity is a durable fact even after cancellation, source edits or lease expiry.
    // This commit deliberately precedes the separate authorization fence for publishing work.
    await this.db.transaction(async tx => {
      const [current] = await tx.select().from(tasks).where(and(eq(tasks.owner, task.owner), eq(tasks.jobId, task.jobId))).for('update');
      if (!current) throw new Error('DOCUMENT_JOB_NOT_FOUND');
      if (current.receipt && (current.receipt.taskId !== receipt.taskId || current.receipt.fileId !== receipt.fileId)) {
        throw new Error('DOCUMENT_RECEIPT_CONFLICT');
      }
      await tx.update(tasks).set({ receipt }).where(and(eq(tasks.owner, task.owner), eq(tasks.jobId, task.jobId)));
    });
    try {
      await this.db.transaction(async tx => {
        await this.fence(tx, task);
        const [current] = await tx.select().from(tasks).where(and(eq(tasks.owner, task.owner), eq(tasks.jobId, task.jobId))).for('update');
        if (!current || !['submitting', 'submitted'].includes(current.state)) throw new Error('DOCUMENT_JOB_LEASE_CHANGED');
        await tx.update(tasks).set({ state: 'submitted' }).where(and(eq(tasks.owner, task.owner), eq(tasks.jobId, task.jobId)));
      });
    } catch (error) {
      await this.db.update(tasks).set({ state: 'provider_unknown', pollToken: null, pollUntil: null }).where(and(
        eq(tasks.owner, task.owner), eq(tasks.jobId, task.jobId), sql`${tasks.state} in ('submitting','submitted')`));
      // A late identity cannot revive the source. Cancel known remote work, or query adapters without cancellation.
      if (extractor.cancel) await extractor.cancel(receipt).catch(() => undefined);
      else await extractor.status(receipt).catch(() => undefined);
      throw error;
    }
  }
  private async task(owner: string, jobId: string): Promise<DocumentTask> {
    const [task] = await this.db.select().from(tasks).where(and(eq(tasks.owner, owner), eq(tasks.jobId, jobId)));
    if (!task) throw new Error('DOCUMENT_JOB_NOT_FOUND'); return task;
  }
  private async recoverLease(task: DocumentTask): Promise<DocumentTask> {
    return this.db.transaction(async tx => {
      const [source] = await tx.select().from(sources).where(and(eq(sources.owner, task.owner), eq(sources.id, task.sourceId),
        eq(sources.enabled, true), isNull(sources.deletedAt), eq(sources.revision, task.sourceRevision),
        eq(sources.activeJobId, task.jobId), eq(sources.leaseToken, task.leaseToken))).for('update');
      if (!source) throw new Error('DOCUMENT_SOURCE_OR_LEASE_CHANGED');
      if (source.leaseUntil && source.leaseUntil > new Date()) return task;
      // Resume a known receipt only. Rotating both durable tokens fences any pre-crash worker.
      if (task.state !== 'submitted' || !task.receipt) throw new Error('DOCUMENT_PROVIDER_OUTCOME_UNKNOWN');
      const leaseToken = randomUUID();
      const [saved] = await tx.update(tasks).set({ leaseToken, pollToken: null, pollUntil: null }).where(and(
        eq(tasks.jobId, task.jobId), eq(tasks.owner, task.owner), eq(tasks.state, 'submitted'), eq(tasks.leaseToken, task.leaseToken))).returning();
      if (!saved) throw new Error('DOCUMENT_JOB_LEASE_CHANGED');
      await tx.update(sources).set({ leaseToken, leaseUntil: new Date(Date.now() + 10 * 60_000) }).where(eq(sources.id, task.sourceId));
      return saved;
    });
  }
  async poll(owner: string, jobId: string): Promise<string> {
    let task = await this.task(owner, jobId);
    if (task.state !== 'submitted') return task.state;
    await this.requireCapability(task);
    task = await this.recoverLease(task);
    if (!task.receipt) throw new Error('DOCUMENT_RECEIPT_MISSING');
    const extractor = this.extractor(task.extractor, task.extractorVersion), pollToken = randomUUID();
    const claimed = await this.db.transaction(async tx => {
      await this.fence(tx, task);
      const [row] = await tx.update(tasks).set({ pollToken, pollUntil: new Date(Date.now() + 120_000) }).where(and(
        eq(tasks.jobId, jobId), eq(tasks.owner, owner), eq(tasks.state, 'submitted'),
        or(isNull(tasks.pollUntil), sql`${tasks.pollUntil} < now()`))).returning();
      if (row) await tx.update(sources).set({ leaseUntil: new Date(Date.now() + 10 * 60_000) }).where(eq(sources.id, task.sourceId));
      return row;
    });
    if (!claimed) return 'running';
    let artifactId: string | null = null, archiveArtifactId: string | null = null;
    try {
      if (task.failureCount >= 3 || Date.now() - task.createdAt.getTime() > 30 * 60_000) {
        await this.finish(task, pollToken, 'failed'); return 'failed';
      }
      const status: DocumentTaskStatus = await extractor.status(task.receipt);
      if (status === 'pending' || status === 'running') {
        await this.db.update(tasks).set({ failureCount: 0 }).where(and(eq(tasks.jobId, jobId), eq(tasks.pollToken, pollToken)));
        return status;
      }
      if (status !== 'completed') { await this.finish(task, pollToken, status === 'cancelled' ? 'cancelled' : 'failed'); return status; }
      let result = await extractor.result(task.receipt);
      await this.requireCapability(task);
      if (extractor instanceof MineruClient && result.archive) result = await extractor.unpack(result.archive);
      const [source] = await this.db.select().from(sources).where(and(eq(sources.id, task.sourceId), eq(sources.owner, owner)));
      const elements = extractDocumentElements(result.lossless, source?.format === 'docx' ? 'docx' : 'pdf');
      const searchableText = documentSearchText(result.markdown, elements);
      const numericValidation = validateDocumentNumbers(elements, []);
      if (result.archive) {
        const archive = await this.artifacts.create(owner, { runId: jobId, type: 'document', mime: 'application/zip',
          data: result.archive, dependencies: [{ sourceId: task.sourceId, sourceVersionId: task.sourceVersionId,
            contentHash: task.sourceHash }], datasetVersionIds: [], dataClasses: ['private_material'], permittedUses: ['research'], retentionUntil: null });
        archiveArtifactId = archive.id;
      }
      const payload = { originalHash: task.originalHash, extractor: task.extractor, extractorVersion: task.extractorVersion,
        configVersion: task.configVersion, markdown: result.markdown, searchableText, lossless: result.lossless, elements, numericValidation, archiveArtifactId };
      const artifact = await this.artifacts.create(owner, { runId: jobId, type: 'document', mime: 'application/json',
        data: Buffer.from(canonicalJson(payload)), dependencies: [{ sourceId: task.sourceId, sourceVersionId: task.sourceVersionId,
          contentHash: task.sourceHash }], datasetVersionIds: [], dataClasses: ['private_material'], permittedUses: ['research'], retentionUntil: null });
      artifactId = artifact.id;
      await this.db.transaction(async tx => {
        const source = await this.fence(tx, task);
        const [current] = await tx.select().from(tasks).where(eq(tasks.jobId, jobId)).for('update');
        if (current.state !== 'submitted' || current.pollToken !== pollToken || current.pollUntil! < new Date()) throw new Error('DOCUMENT_JOB_LEASE_CHANGED');
        const [version] = await tx.insert(versions).values({ owner, sourceId: task.sourceId, version: source.versionCount + 1,
          contentHash: hashContent(payload), rawContent: canonicalJson(result.lossless), extractedText: searchableText,
          sections: elements.map(element => ({ locator: canonicalJson(element.locator), text: element.text })),
          byteLength: Buffer.byteLength(canonicalJson(result.lossless)), extractionState: searchableText ? 'ready' : 'needs-text' }).returning();
        await tx.insert(extractions).values({ owner, sourceId: task.sourceId, sourceVersionId: version.id, jobId,
          originalHash: task.originalHash, extractor: task.extractor, extractorVersion: task.extractorVersion,
          configVersion: task.configVersion, artifactId: artifact.id,
          metadata: { elements, numericValidation, archiveArtifactId, parsingStatus: searchableText ? 'completed' : 'needs_text', archiveSha256: result.archive ?
            createHash('sha256').update(result.archive).digest('hex') : null } });
        await tx.update(sources).set({ latestVersionId: version.id, versionCount: source.versionCount + 1,
          state: searchableText ? 'ready' : 'needs-text', leaseToken: null, leaseUntil: null, activeJobId: null,
          lastSuccessAt: new Date(), lastErrorCode: null }).where(eq(sources.id, task.sourceId));
        await tx.update(jobs).set({ state: 'succeeded', outcome: 'updated', versionId: version.id, finishedAt: new Date() }).where(eq(jobs.id, jobId));
        await tx.update(tasks).set({ state: 'completed', pollToken: null, pollUntil: null }).where(eq(tasks.jobId, jobId));
      });
      return 'completed';
    } catch (error) {
      if (artifactId) await this.artifacts.discard(owner, artifactId);
      if (archiveArtifactId) await this.artifacts.discard(owner, archiveArtifactId);
      await this.db.update(tasks).set({ failureCount: sql`${tasks.failureCount}+1` }).where(and(eq(tasks.jobId, jobId), eq(tasks.pollToken, pollToken)));
      throw error;
    } finally {
      await this.db.update(tasks).set({ pollToken: null, pollUntil: null }).where(and(eq(tasks.jobId, jobId), eq(tasks.pollToken, pollToken)));
    }
  }
  private async finish(task: DocumentTask, pollToken: string, state: 'cancelled' | 'failed'): Promise<void> {
    await this.db.transaction(async tx => {
      await this.fence(tx, task);
      await tx.update(tasks).set({ state, pollToken: null, pollUntil: null }).where(and(eq(tasks.jobId, task.jobId), eq(tasks.pollToken, pollToken)));
      await tx.update(jobs).set({ state, finishedAt: new Date(), errorCode: `DOCUMENT_${state.toUpperCase()}` }).where(eq(jobs.id, task.jobId));
      await tx.update(sources).set({ activeJobId: null, leaseToken: null, leaseUntil: null, state: 'failed' }).where(eq(sources.id, task.sourceId));
    });
  }
  async cancel(owner: string, jobId: string): Promise<void> {
    const task = await this.task(owner, jobId);
    if (task.state === 'completed' || task.state === 'cancelled') return;
    const cancelled = await this.db.transaction(async tx => {
      await tx.select({ id: sources.id }).from(sources).where(and(eq(sources.owner, owner), eq(sources.id, task.sourceId))).for('update');
      const [current] = await tx.update(tasks).set({ state: 'cancelled', pollToken: null, pollUntil: null })
        .where(and(eq(tasks.owner, owner), eq(tasks.jobId, jobId))).returning();
      await tx.update(jobs).set({ state: 'cancelled', finishedAt: new Date() }).where(and(eq(jobs.owner, owner), eq(jobs.id, jobId)));
      await tx.update(sources).set({ leaseToken: null, leaseUntil: null, activeJobId: null }).where(and(eq(sources.owner, owner),
        eq(sources.id, task.sourceId), eq(sources.activeJobId, jobId), eq(sources.leaseToken, task.leaseToken)));
      return current;
    });
    const extractor = this.extractor(task.extractor, task.extractorVersion);
    if (cancelled?.receipt && extractor.cancel) await extractor.cancel(cancelled.receipt);
  }
  async cancelSource(owner: string, sourceId: string): Promise<void> {
    const active = await this.db.select().from(tasks).where(and(eq(tasks.owner, owner), eq(tasks.sourceId, sourceId),
      sql`${tasks.state} in ('submitting','submitted','provider_unknown')`));
    for (const task of active) await this.cancel(owner, task.jobId).catch(() => undefined);
  }
  async runDue(limit = 10): Promise<void> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error('INVALID_JOB_LIMIT');
    await this.db.update(tasks).set({ state: 'provider_unknown' }).where(and(eq(tasks.state, 'submitting'), sql`${tasks.createdAt}<now()-interval '1 minute'`));
    const due = await this.db.select().from(tasks).where(eq(tasks.state, 'submitted')).orderBy(tasks.createdAt).limit(limit);
    for (const task of due) await this.poll(task.owner, task.jobId).catch(() => undefined);
  }
}
