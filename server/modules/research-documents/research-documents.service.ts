import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { and, asc, count, desc, eq, exists, gte, ilike, inArray, isNotNull, isNull, lt, notExists, or, sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '../../common/platform';
import { analysis, deepReport, portfolioAnalysisRuns } from '../../database/schema';
import { councilReports, councilSessions } from '../../database/council.schema';
import { REPORT_EXECUTION_SECTION_ID, renderReportExecutionPlan } from '../paper-trading/report-execution-plan';
import { researchDocuments, researchDocumentVersions, researchRevisionDrafts, researchDocumentStrategyUses, researchDocumentSubmissions, researchDocumentAdoptions } from '../../database/research-documents.schema';
import { lockMemoryOwner } from '../research-memory/research-memory.fence';
import { capturePortfolioDailyFacts } from './portfolio-daily-facts';
import { businessDate } from '../experience/simple-experience.rules';
import { experiencePreferences } from '../../database/simple-experience.schema';
import type { ReportSource, ReportReference, ResolvedReportReference, ResearchDocumentVersion, ResearchDocumentView,
  ResearchInputSnapshot, ResearchRevisionDraft, ResearchRevisionInput, SubmitResearchDocument, ResearchDocumentIndex, ResearchDocumentIndexQuery } from '../../../shared/research-document.interface';
import { assertAdoption, assertIdempotency, contentHash, diffSections, parseReportRequest, reportIdSchema, reportReferencesSchema,
  reportSourceSchema, reportIndexSchema, reportCategory, reportTopic, resolveExactReference, sectionsFromRecord, submitSchema, validateRevision } from './research-documents.rules';

export type ResearchDocumentsTransaction = Pick<PostgresJsDatabase, 'select' | 'insert' | 'update'>;
type VersionRow = typeof researchDocumentVersions.$inferSelect;
type DraftRow = typeof researchRevisionDrafts.$inferSelect;
export interface SourceRegistrationMetadata { idempotencyKey?: string; dataAsOf?: string | null; availableAt?: string | null; snapshot?: ResearchInputSnapshot | null }

@Injectable()
export class ResearchDocumentsService {
  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase) {}

  private owner(owner: string): void { if (!owner?.trim()) throw new UnauthorizedException('REPORT_OWNER_REQUIRED'); }
  private id(id: string): void { parseReportRequest(reportIdSchema, id); }
  async list(owner: string, input: ResearchDocumentIndexQuery = {}): Promise<ResearchDocumentIndex> {
    this.owner(owner); const query = parseReportRequest(reportIndexSchema, input);
    const moreLegacySources = await this.registerMissingSources(owner);
    const draftCount = sql<number>`(select count(*)::int from research_revision_drafts d where d.owner = ${owner} and d.report_id = ${researchDocuments.id} and d.published_version_id is null)`;
    const strategyUseCount = sql<number>`(select count(distinct u.strategy_id)::int from research_document_strategy_uses u join research_document_versions v on v.id = u.version_id where u.owner = ${owner} and v.report_id = ${researchDocuments.id})`;
    const updatesAvailable = sql<boolean>`exists(select 1 from research_document_strategy_uses u join research_document_versions v on v.id = u.version_id where u.owner = ${owner} and v.report_id = ${researchDocuments.id} and u.version_id <> ${researchDocuments.latestVersionId})`;
    const category = sql<string>`case when ${researchDocumentVersions.snapshot}->>'experimentId' is not null or ${researchDocumentVersions.snapshot}->>'scene' = 'trade_post_review' then 'review' when ${researchDocumentVersions.kind} = 'deep' or (${researchDocumentVersions.kind} = 'council' and ${researchDocumentVersions.ticker} is not null and ${researchDocumentVersions.ticker} <> 'PORTFOLIO') then 'stock' else 'daily' end`;
    const conditions = [eq(researchDocuments.owner, owner), eq(researchDocumentVersions.owner, owner)];
    if (!query.history) conditions.push(eq(researchDocumentVersions.id, query.state === 'adopted' ? researchDocuments.adoptedVersionId : researchDocuments.latestVersionId));
    if (query.topic) conditions.push(eq(researchDocuments.topicKey, query.topic));
    if(query.source)conditions.push(sql`${researchDocumentVersions.source}->>'type'=${query.source}`);
    if(query.date){
      const [preferences]=await this.db.select().from(experiencePreferences).where(eq(experiencePreferences.owner,owner));
      conditions.push(sql`coalesce(${researchDocumentVersions.snapshot}->>'businessDate',to_char(${researchDocumentVersions.createdAt} AT TIME ZONE ${preferences?.timezone??'Asia/Shanghai'},'YYYY-MM-DD'))=${query.date}`);
    }
    if (query.category !== 'all') conditions.push(sql`${category} = ${query.category}`);
    if (query.search?.trim()) conditions.push(ilike(researchDocumentVersions.title, `%${query.search.trim()}%`));
    if (query.state === 'adopted') conditions.push(eq(researchDocumentVersions.id, researchDocuments.adoptedVersionId));
    if (query.state === 'draft') conditions.push(sql`${draftCount} > 0`);
    if (query.state === 'strategy') conditions.push(sql`${strategyUseCount} > 0`);
    if (query.from) conditions.push(gte(researchDocumentVersions.createdAt, new Date(`${query.from}T00:00:00Z`)));
    if (query.to) conditions.push(lt(researchDocumentVersions.createdAt, new Date(Date.parse(`${query.to}T00:00:00Z`) + 86400000)));
    const [rows, totals, topics] = await Promise.all([
      this.db.select({ version: researchDocumentVersions, document: researchDocuments, draftCount, strategyUseCount, updatesAvailable })
        .from(researchDocumentVersions).innerJoin(researchDocuments, eq(researchDocuments.id, researchDocumentVersions.reportId))
        .where(and(...conditions)).orderBy(desc(researchDocumentVersions.createdAt), desc(researchDocumentVersions.id)).limit(query.limit).offset(query.offset),
      this.db.select({ total: count() }).from(researchDocumentVersions).innerJoin(researchDocuments, eq(researchDocuments.id, researchDocumentVersions.reportId)).where(and(...conditions)),
      this.db.select({ key: researchDocuments.topicKey, count: count() }).from(researchDocuments).where(eq(researchDocuments.owner, owner)).groupBy(researchDocuments.topicKey),
    ]);
    return { total: totals[0]?.total ?? 0, moreLegacySources, topics: topics.map(topic => ({ ...topic, label: topic.key.startsWith('ticker:') ? topic.key.slice(7) : 'Portfolio' })),
      items: await Promise.all(rows.map(async row => ({ id: row.version.id, reportId: row.version.reportId, version: row.version.version,
        title: row.version.title, kind: row.version.kind, ticker: row.version.ticker, topicKey: row.document.topicKey, category: reportCategory(row.version),
        dataAsOf: row.version.dataAsOf?.toISOString() ?? null, availableAt: row.version.availableAt?.toISOString() ?? null, createdAt: row.version.createdAt.toISOString(),generatedAt:typeof row.version.snapshot?.generatedAt==='string'?row.version.snapshot.generatedAt:null,
        status: row.version.revokedAt ? 'revoked' as const : 'valid' as const, sourceStatus: await this.sourceStatus(this.db, owner, row.version.source),
        source: row.version.source, adoptedVersionId: row.document.adoptedVersionId, latestVersionId: row.document.latestVersionId,
        draftCount: Number(row.draftCount), strategyUseCount: Number(row.strategyUseCount), updatesAvailable: row.updatesAvailable }))) };
  }
  /** Import a bounded batch of existing owned sources. New writes already archive atomically. */
  private async registerMissingSources(owner: string): Promise<boolean> {
    const missing = (type: ReportSource['type'], id: AnyPgColumn) => notExists(this.db.select({ id: researchDocumentVersions.id }).from(researchDocumentVersions)
      .where(and(eq(researchDocumentVersions.owner, owner), sql`${researchDocumentVersions.source}->>'type' = ${type}`, sql`${researchDocumentVersions.source}->>'id' = ${id}::text`)));
    const batches = await Promise.all([
      this.db.select({ id: analysis.id }).from(analysis).where(and(eq(analysis.owner, owner), missing('daily', analysis.id))).orderBy(desc(analysis.createdAt)).limit(20),
      this.db.select({ id: deepReport.id }).from(deepReport).where(and(eq(deepReport.owner, owner), missing('deep', deepReport.id))).orderBy(desc(deepReport.createdAt)).limit(20),
      this.db.select({ id: portfolioAnalysisRuns.id }).from(portfolioAnalysisRuns).where(and(eq(portfolioAnalysisRuns.owner, owner), eq(portfolioAnalysisRuns.status, 'completed'), isNotNull(portfolioAnalysisRuns.report), missing('portfolio', portfolioAnalysisRuns.id))).orderBy(desc(portfolioAnalysisRuns.createdAt)).limit(20),
      this.db.select({ id: councilReports.id }).from(councilReports).innerJoin(councilSessions, and(eq(councilSessions.id, councilReports.sessionId), eq(councilSessions.owner, owner)))
        .where(and(eq(councilReports.owner, owner), or(isNull(councilReports.publicationOutcome), eq(councilReports.publicationOutcome, 'succeeded')), missing('council', councilReports.id))).orderBy(desc(councilReports.createdAt)).limit(20),
    ]);
    const types: ReportSource['type'][] = ['daily', 'deep', 'portfolio', 'council'];
    for (let index = 0; index < batches.length; index += 1) for (const row of batches[index]) {
      try { await this.importSource(owner, { type: types[index], id: row.id }); }
      catch (error) { if (!(error instanceof NotFoundException)) throw error; }
    }
    // Earlier installs may already have an immutable archive without the round-card link.
    // Resolve by exact source identity, never by the session's latest document or current title.
    const unlinked = await this.db.select({ reportId: councilReports.id, versionId: researchDocumentVersions.id }).from(councilReports)
      .innerJoin(councilSessions, and(eq(councilSessions.owner, owner), eq(councilSessions.id, councilReports.sessionId)))
      .innerJoin(researchDocumentVersions, and(eq(researchDocumentVersions.owner, owner), eq(researchDocumentVersions.kind, 'council'),
        isNull(researchDocumentVersions.changeReason), isNull(researchDocumentVersions.revokedAt),
        sql`${researchDocumentVersions.source}->>'type'='council' AND ${researchDocumentVersions.source}->>'id'=${councilReports.id}::text`))
      .innerJoin(researchDocuments, and(eq(researchDocuments.owner, owner), eq(researchDocuments.id, researchDocumentVersions.reportId)))
      .where(and(eq(councilReports.owner, owner), isNull(councilReports.researchVersionId),
        or(isNull(councilReports.publicationOutcome), eq(councilReports.publicationOutcome, 'succeeded'))))
      .orderBy(desc(councilReports.createdAt), asc(researchDocumentVersions.version), asc(researchDocumentVersions.id)).limit(20);
    if (unlinked.length) await this.db.transaction(async tx => {
      await lockMemoryOwner(tx, owner);
      for (const row of unlinked) await this.linkCouncilArchive(tx, owner, row.reportId, row.versionId);
    });
    return batches.some(batch => batch.length === 20) || unlinked.length === 20;
  }
  private async linkCouncilArchive(tx: ResearchDocumentsTransaction, owner: string, reportId: string, versionId: string): Promise<void> {
    await tx.update(councilReports).set({ researchVersionId: versionId }).where(and(eq(councilReports.owner, owner), eq(councilReports.id, reportId),
      isNull(councilReports.researchVersionId), or(isNull(councilReports.publicationOutcome), eq(councilReports.publicationOutcome, 'succeeded')),
      exists(tx.select({ id: researchDocumentVersions.id }).from(researchDocumentVersions)
        .innerJoin(researchDocuments, and(eq(researchDocuments.owner, owner), eq(researchDocuments.id, researchDocumentVersions.reportId)))
        .where(and(eq(researchDocumentVersions.owner, owner), eq(researchDocumentVersions.id, versionId), eq(researchDocumentVersions.kind, 'council'),
          isNull(researchDocumentVersions.revokedAt), sql`${researchDocumentVersions.source}->>'type'='council' AND ${researchDocumentVersions.source}->>'id'=${reportId}`)))));
  }
  async sourceUpdates(owner: string, references: ReportReference[]): Promise<Array<{ versionId: string; latestVersionId: string; title: string }>> {
    this.owner(owner); const checked = parseReportRequest(reportReferencesSchema, references);
    if (!checked.length) return [];
    const rows = await this.db.select({ id: researchDocumentVersions.id, latest: researchDocuments.latestVersionId, title: researchDocuments.title })
      .from(researchDocumentVersions).innerJoin(researchDocuments, and(eq(researchDocuments.id, researchDocumentVersions.reportId), eq(researchDocuments.owner, owner)))
      .where(and(eq(researchDocumentVersions.owner, owner), inArray(researchDocumentVersions.id, checked.map(ref => ref.versionId))));
    return rows.flatMap(row => row.latest && row.latest !== row.id ? [{ versionId: row.id, latestVersionId: row.latest, title: row.title }] : []);
  }
  async withSubmission<T extends Record<string, unknown>>(owner: string, key: string, payload: unknown,
    write: (tx: ResearchDocumentsTransaction) => Promise<T>): Promise<T> {
    this.owner(owner);
    if (!key || key.length > 300 || JSON.stringify(payload).length > 1_000_000) throw new BadRequestException('REPORT_INVALID_SUBMISSION');
    const hash = contentHash(payload);
    return this.db.transaction(async tx => {
      await lockMemoryOwner(tx, owner);
      const [existing] = await tx.select().from(researchDocumentSubmissions).where(and(eq(researchDocumentSubmissions.owner, owner), eq(researchDocumentSubmissions.key, key)));
      if (existing) { assertIdempotency(existing.payloadHash, hash); return existing.result as T; }
      const result = await write(tx);
      await tx.insert(researchDocumentSubmissions).values({ owner, key, payloadHash: hash, result });
      return result;
    });
  }
  private version(row: VersionRow, sourceStatus: 'available' | 'missing' = 'available'): ResearchDocumentVersion {
    return { id: row.id, reportId: row.reportId, version: row.version, title: row.title, kind: row.kind, ticker: row.ticker,
      content: row.content, sections: row.sections, dataAsOf: row.dataAsOf?.toISOString() ?? null, availableAt: row.availableAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(), source: row.source, snapshot: row.snapshot, parentVersionId: row.parentVersionId,
      changeReason: row.changeReason, contentHash: row.contentHash, status: row.revokedAt ? 'revoked' : 'valid', sourceStatus };
  }
  private draft(row: DraftRow): ResearchRevisionDraft {
    return { id: row.id, reportId: row.reportId, parentVersionId: row.parentVersionId, revision: row.revision,
      title: row.title, content: row.content, sections: row.sections, changeReason: row.changeReason,
      sourceReferences: row.sourceReferences,
      createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
  }
  private async versionRow(tx: ResearchDocumentsTransaction, owner: string, id: string): Promise<VersionRow> {
    const [row] = await tx.select().from(researchDocumentVersions).where(and(eq(researchDocumentVersions.owner, owner), eq(researchDocumentVersions.id, id))).limit(1);
    if (!row) throw new NotFoundException('REPORT_NOT_FOUND');
    return row;
  }
  async getVersion(owner: string, id: string): Promise<ResearchDocumentVersion> {
    return this.getVersionInTransaction(this.db, owner, id);
  }
  async getVersionInTransaction(tx: ResearchDocumentsTransaction, owner: string, id: string): Promise<ResearchDocumentVersion> {
    this.owner(owner); this.id(id);
    const row = await this.versionRow(tx, owner, id);
    return this.version(row, await this.sourceStatus(tx, owner, row.source));
  }
  async listVersions(owner: string, reportId: string): Promise<ResearchDocumentVersion[]> {
    this.owner(owner); this.id(reportId);
    const rows = await this.db.select().from(researchDocumentVersions).where(and(eq(researchDocumentVersions.owner, owner), eq(researchDocumentVersions.reportId, reportId))).orderBy(desc(researchDocumentVersions.version));
    return Promise.all(rows.map(async row => this.version(row, await this.sourceStatus(this.db, owner, row.source))));
  }
  async resolveReferences(owner: string, references: ReportReference[]): Promise<ResolvedReportReference[]> {
    this.owner(owner); const checked = parseReportRequest(reportReferencesSchema, references);
    return Promise.all(checked.map(async reference => resolveExactReference(await this.getVersion(owner, reference.versionId), reference)));
  }
  /** Final execution fence. Caller holds lockMemoryOwner; source row locks last until its ledger transaction commits. */
  async assertExecutionSourcesInTransaction(tx: ResearchDocumentsTransaction, owner: string, references: ReportReference[], decisionAt: Date): Promise<ResolvedReportReference[]> {
    this.owner(owner); const checked = parseReportRequest(reportReferencesSchema, references);
    if (!Number.isFinite(decisionAt.getTime())) throw new BadRequestException('REPORT_INVALID_DECISION_TIME');
    const active = new Set<string>(); const complete = new Map<string, ResearchDocumentVersion>();
    const inspect = async (reference: ReportReference, depth: number): Promise<ResolvedReportReference> => {
      if (active.has(reference.versionId) || depth > 50 || complete.size + active.size >= 100) throw new ConflictException('REPORT_REFERENCE_CHAIN_INVALID');
      const cached = complete.get(reference.versionId);
      if (cached) return resolveExactReference(cached, reference);
      active.add(reference.versionId);
      const row = await this.versionRow(tx, owner, reference.versionId);
      if (row.revokedAt) throw new ConflictException('REPORT_REVOKED');
      if (await this.sourceStatus(tx, owner, row.source, true) === 'missing') throw new ConflictException('REPORT_SOURCE_MISSING');
      if (!row.availableAt) throw new ConflictException('REPORT_AVAILABILITY_UNKNOWN');
      if (row.availableAt.getTime() > decisionAt.getTime()) throw new ConflictException('REPORT_NOT_YET_AVAILABLE');
      if (row.dataAsOf && row.dataAsOf.getTime() > decisionAt.getTime()) throw new ConflictException('REPORT_FUTURE_DATA');
      const version = this.version(row); const resolved = resolveExactReference(version, reference);
      try {
        // Labels such as historicalOnly alone cannot establish a fresh executable conclusion.
        // Until an explicit evidence replacement is published, every frozen dependency remains a fence.
        for (const dependency of this.executionDependencies(row.snapshot)) await inspect(dependency, depth + 1);
      } catch { throw new ConflictException('REPORT_TRANSITIVE_SOURCE_INVALID'); }
      active.delete(reference.versionId); complete.set(reference.versionId, version);
      return resolved;
    };
    const result: ResolvedReportReference[] = [];
    for (const reference of checked) result.push(await inspect(reference, 0));
    return result;
  }
  private executionDependencies(snapshot: ResearchInputSnapshot | null): ReportReference[] {
    if (!snapshot) return [];
    const references: ReportReference[] = [];
    const collect = (record: Record<string, unknown>) => {
      for (const key of ['references', 'resolvedReferences', 'reportReferences']) {
        if (record[key] === null || record[key] === undefined) continue;
        if (!Array.isArray(record[key]) || record[key].length > 100) throw new ConflictException('REPORT_REFERENCE_CHAIN_INVALID');
        for (const item of record[key]) {
          if (!item || typeof item !== 'object' || !('versionId' in item)) throw new ConflictException('REPORT_REFERENCE_CHAIN_INVALID');
          const reference = item as ReportReference;
          parseReportRequest(reportIdSchema, reference.versionId);
          references.push({ versionId: reference.versionId, ...(reference.sectionId ? { sectionId: reference.sectionId } : {}), ...(reference.excerpt ? { excerpt: reference.excerpt } : {}) });
        }
      }
      if (record.sourceReportVersionId !== null && record.sourceReportVersionId !== undefined) references.push({ versionId: parseReportRequest(reportIdSchema, record.sourceReportVersionId) });
    };
    collect(snapshot);
    if (snapshot.continuationSummary && typeof snapshot.continuationSummary === 'object') collect(snapshot.continuationSummary as Record<string, unknown>);
    return [...new Map(references.map(ref => [`${ref.versionId}:${ref.sectionId ?? ''}:${ref.excerpt ?? ''}`, ref])).values()];
  }
  async view(owner: string, id: string): Promise<ResearchDocumentView> {
    const version = await this.getVersion(owner, id);
    const [document] = await this.db.select().from(researchDocuments).where(and(eq(researchDocuments.owner, owner), eq(researchDocuments.id, version.reportId)));
    if (!document) throw new NotFoundException('REPORT_NOT_FOUND');
    const [versions, drafts, uses, adoptions] = await Promise.all([this.listVersions(owner, document.id),
      this.db.select().from(researchRevisionDrafts).where(and(eq(researchRevisionDrafts.owner, owner), eq(researchRevisionDrafts.reportId, document.id), isNull(researchRevisionDrafts.publishedVersionId))),
      this.db.select({ strategyId: researchDocumentStrategyUses.strategyId, versionId: researchDocumentStrategyUses.versionId, createdAt: researchDocumentStrategyUses.createdAt })
        .from(researchDocumentStrategyUses).innerJoin(researchDocumentVersions, and(eq(researchDocumentVersions.id, researchDocumentStrategyUses.versionId), eq(researchDocumentVersions.owner, owner)))
        .where(and(eq(researchDocumentStrategyUses.owner, owner), eq(researchDocumentVersions.reportId, document.id))),
      this.db.select().from(researchDocumentAdoptions).where(and(eq(researchDocumentAdoptions.owner, owner), eq(researchDocumentAdoptions.reportId, document.id)))
        .orderBy(desc(researchDocumentAdoptions.createdAt))]);
    const parent = version.parentVersionId ? await this.getVersion(owner, version.parentVersionId) : null;
    return { document: { id: document.id, title: document.title, kind: document.kind, ticker: document.ticker, parentReportId: document.parentReportId,
      latestVersionId: document.latestVersionId, adoptedVersionId: document.adoptedVersionId, strategyVersionIds: [...new Set(uses.map(use => use.versionId))] },
      version, versions, drafts: drafts.map(row => this.draft(row)), diff: parent ? diffSections(parent.sections, version.sections) : [],
      strategyUses: uses.map(use => ({ ...use, createdAt: use.createdAt.toISOString() })),
      adoptions: adoptions.map(event => ({ id: event.id, versionId: event.versionId, previousVersionId: event.previousVersionId,
        actorId: event.actorId, createdAt: event.createdAt.toISOString() })) };
  }

  /** Internal trusted submission boundary. Public HTTP writes use owned source import or revision drafts. */
  async submit(owner: string, input: SubmitResearchDocument): Promise<ResearchDocumentVersion> {
    this.owner(owner);
    return this.db.transaction(async tx => { await lockMemoryOwner(tx, owner); return this.submitInTransaction(tx, owner, input); });
  }
  async submitInTransaction(tx: ResearchDocumentsTransaction, owner: string, input: SubmitResearchDocument, sourceKey?: string): Promise<ResearchDocumentVersion> {
    this.owner(owner); const checked = parseReportRequest(submitSchema, input);
    if (new Set(checked.sections.map(s => s.id)).size !== checked.sections.length) throw new BadRequestException('REPORT_DUPLICATE_SECTION');
    if (JSON.stringify(checked.snapshot ?? null).length > 1_000_000) throw new BadRequestException('REPORT_SNAPSHOT_TOO_LARGE');
    const { idempotencyKey, ...payload } = checked;
    const hash = contentHash(payload);
    const [existing] = await tx.select().from(researchDocumentVersions).where(and(eq(researchDocumentVersions.owner, owner), eq(researchDocumentVersions.idempotencyKey, idempotencyKey)));
    if (existing) { assertIdempotency(existing.contentHash, hash); return this.version(existing); }
    let document: typeof researchDocuments.$inferSelect | undefined;
    if (checked.reportId) {
      [document] = await tx.select().from(researchDocuments).where(and(eq(researchDocuments.owner, owner), eq(researchDocuments.id, checked.reportId))).for('update');
      if (!document) throw new NotFoundException('REPORT_NOT_FOUND');
    } else if (sourceKey) {
      [document] = await tx.select().from(researchDocuments).where(and(eq(researchDocuments.owner, owner), eq(researchDocuments.sourceKey, sourceKey))).for('update');
    }
    if (!document) {
      [document] = await tx.insert(researchDocuments).values({ owner, title: checked.title, kind: checked.kind, ticker: checked.ticker ?? null, topicKey: reportTopic(checked.ticker), sourceKey }).returning();
    }
    const parentVersionId = checked.parentVersionId ?? document.latestVersionId;
    if (parentVersionId) {
      const parent = await this.versionRow(tx, owner, parentVersionId);
      if (parent.reportId !== document.id && parent.reportId !== document.parentReportId) throw new ConflictException('REPORT_BRANCH_MISMATCH');
    }
    const [previous] = await tx.select({ version: researchDocumentVersions.version }).from(researchDocumentVersions)
      .where(and(eq(researchDocumentVersions.owner, owner), eq(researchDocumentVersions.reportId, document.id))).orderBy(desc(researchDocumentVersions.version)).limit(1);
    const [created] = await tx.insert(researchDocumentVersions).values({ owner, reportId: document.id, version: (previous?.version ?? 0) + 1,
      idempotencyKey, contentHash: hash, title: checked.title, kind: checked.kind, ticker: checked.ticker ?? null,
      content: checked.content, sections: checked.sections, source: checked.source ?? null, snapshot: checked.snapshot ?? null,
      dataAsOf: checked.dataAsOf ? new Date(checked.dataAsOf) : null, availableAt: checked.availableAt ? new Date(checked.availableAt) : null,
      parentVersionId, changeReason: checked.changeReason ?? null }).returning();
    await tx.update(researchDocuments).set({ latestVersionId: created.id, title: created.title }).where(and(eq(researchDocuments.owner, owner), eq(researchDocuments.id, document.id)));
    return this.version(created);
  }
  async importSource(owner: string, source: ReportSource): Promise<ResearchDocumentVersion> {
    this.owner(owner); parseReportRequest(reportSourceSchema, source);
    return this.db.transaction(async tx => { await lockMemoryOwner(tx, owner); return this.importSourceInTransaction(tx, owner, source); });
  }
  /** Call after acquiring lockMemoryOwner, before overwriting any mutable legacy source. */
  async importSourceInTransaction(tx: ResearchDocumentsTransaction, owner: string, source: ReportSource, metadata: SourceRegistrationMetadata = {}): Promise<ResearchDocumentVersion> {
    this.owner(owner); parseReportRequest(reportSourceSchema, source);
    const loaded = await this.loadSource(tx, owner, source);
    const previous = await tx.select().from(researchDocumentVersions).where(and(eq(researchDocumentVersions.owner, owner),
      inArray(researchDocumentVersions.reportId, tx.select({ id: researchDocuments.id }).from(researchDocuments).where(and(eq(researchDocuments.owner, owner), eq(researchDocuments.sourceKey, loaded.sourceKey)))),
      isNull(researchDocumentVersions.changeReason), sql`${researchDocumentVersions.source}->>'type' = ${source.type}`, sql`${researchDocumentVersions.source}->>'id' = ${source.id}`)).orderBy(desc(researchDocumentVersions.version));
    // A discussion may be renamed later; the report's archived title and text remain fixed.
    const match = previous.find(row => row.content === loaded.input.content && (source.type === 'council' || row.title === loaded.input.title) && contentHash(row.sections) === contentHash(loaded.input.sections)
      && (metadata.snapshot === undefined || contentHash(row.snapshot) === contentHash(metadata.snapshot)));
    if (match && !metadata.idempotencyKey) {
      if (source.type === 'council') await this.linkCouncilArchive(tx, owner, source.id, match.id);
      return this.version(match);
    }
    if (previous.length && !match && source.type !== 'daily') throw new ConflictException('REPORT_IDEMPOTENCY_CONFLICT');
    const retry = metadata.idempotencyKey ? previous.find(row => row.idempotencyKey === metadata.idempotencyKey) : undefined;
    const input = { ...loaded.input, source, dataAsOf: metadata.dataAsOf ?? null, availableAt: metadata.availableAt ?? null,
      snapshot: metadata.snapshot === undefined ? loaded.snapshot : metadata.snapshot };
    if (retry && metadata.availableAt === undefined) input.availableAt = retry.availableAt?.toISOString() ?? null;
    const sourceRevision = source.type === 'daily' ? `:${contentHash(input)}` : '';
    const version = await this.submitInTransaction(tx, owner, { ...input, idempotencyKey: metadata.idempotencyKey ?? `source:${source.type}:${source.id}${sourceRevision}` }, loaded.sourceKey);
    if (source.type === 'council') await this.linkCouncilArchive(tx, owner, source.id, version.id);
    return version;
  }
  async writeDaily(owner: string, input: Omit<typeof analysis.$inferInsert, 'owner' | 'id'>, metadata: SourceRegistrationMetadata = {}): Promise<typeof analysis.$inferSelect> {
    this.owner(owner);
    return this.db.transaction(async tx => { await lockMemoryOwner(tx, owner); return this.writeDailyInTransaction(tx, owner, input, metadata); });
  }
  async writeDailyInTransaction(tx: ResearchDocumentsTransaction, owner: string, input: Omit<typeof analysis.$inferInsert, 'owner' | 'id'>, metadata: SourceRegistrationMetadata = {}): Promise<typeof analysis.$inferSelect> {
    const [existing] = await tx.select().from(analysis).where(and(eq(analysis.owner, owner), eq(analysis.analysisDate, input.analysisDate), eq(analysis.ticker, input.ticker))).for('update');
    if (existing) await this.importSourceInTransaction(tx, owner, { type: 'daily', id: existing.id });
    const [written] = await tx.insert(analysis).values({ ...input, owner }).onConflictDoUpdate({ target: [analysis.owner, analysis.analysisDate, analysis.ticker],
      set: { rating: input.rating, action: input.action, analysis: input.analysis, targetPrice: input.targetPrice, catalysts: input.catalysts, risks: input.risks,
        updatedAt: new Date(), updatedBy: owner } }).returning();
    if (input.ticker.toUpperCase() === 'PORTFOLIO') {
      const capturedAt = new Date();
      const { dailyFacts: _untrustedFacts, ...suppliedSnapshot } = metadata.snapshot ?? {};
      metadata = { ...metadata, snapshot: Object.keys(suppliedSnapshot).length ? suppliedSnapshot : null };
      const dailyFacts = await capturePortfolioDailyFacts(tx, owner, capturedAt);
      // Server capture belongs to today's ledger. Backfilled historical reports cannot borrow today's facts.
      if (input.analysisDate === dailyFacts.businessDate) metadata = { ...metadata, snapshot: { ...metadata.snapshot, dailyFacts }, availableAt: metadata.availableAt ?? capturedAt.toISOString() };
    }
    await this.importSourceInTransaction(tx, owner, { type: 'daily', id: written.id }, metadata);
    return written;
  }
  private async loadSource(tx: ResearchDocumentsTransaction, owner: string, source: ReportSource, lock = false): Promise<{
    input: Omit<SubmitResearchDocument, 'idempotencyKey'>; sourceKey: string; snapshot: ResearchInputSnapshot | null;
  }> {
    let fields: Record<string, unknown>; let title: string; let ticker: string | null; let sourceKey = `${source.type}:${source.id}`;
    let snapshot: ResearchInputSnapshot | null = null;let proposalLanguage='zh-CN';
    const [preferences]=await tx.select().from(experiencePreferences).where(eq(experiencePreferences.owner,owner));
    const timezone=preferences?.timezone??'Asia/Shanghai';
    if (source.type === 'daily') {
      const query = tx.select().from(analysis).where(and(eq(analysis.owner, owner), eq(analysis.id, source.id)));
      const [row] = lock ? await query.for('share') : await query;
      if (!row) throw new NotFoundException('REPORT_SOURCE_NOT_FOUND');
      ticker = row.ticker; title = `${row.analysisDate} · ${ticker}`;
      fields = { analysisDate: row.analysisDate, rating: row.rating, action: row.action, analysis: row.analysis, targetPrice: row.targetPrice, catalysts: row.catalysts, risks: row.risks };
    } else if (source.type === 'deep') {
      const query = tx.select().from(deepReport).where(and(eq(deepReport.owner, owner), eq(deepReport.id, source.id)));
      const [row] = lock ? await query.for('share') : await query;
      if (!row) throw new NotFoundException('REPORT_SOURCE_NOT_FOUND');
      ticker = row.ticker; title = `${ticker} · Deep research`; sourceKey = `deep:${ticker}`;
      const { id: _id, owner: _owner, createdAt: _created, updatedAt: _updated, createdBy: _creator, updatedBy: _updater, ...body } = row;
      fields = body;
    } else if (source.type === 'portfolio') {
      const query = tx.select().from(portfolioAnalysisRuns).where(and(eq(portfolioAnalysisRuns.owner, owner), eq(portfolioAnalysisRuns.id, source.id)));
      const [row] = lock ? await query.for('share') : await query;
      if (!row || row.status !== 'completed' || !row.report) throw new NotFoundException('REPORT_SOURCE_NOT_FOUND');
      ticker = null; title = 'Portfolio research'; sourceKey = 'portfolio';
      fields = row.report as Record<string, unknown>; snapshot = {...row.snapshot as ResearchInputSnapshot,businessDate:businessDate(row.completedAt??row.createdAt,timezone),generatedAt:(row.completedAt??row.createdAt).toISOString()};
      if (snapshot?.dailyFacts) fields = { dailyLedgerFacts: snapshot.dailyFacts, ...fields };
    } else {
      const query = tx.select({ report: councilReports, session: councilSessions }).from(councilReports)
        .innerJoin(councilSessions, and(eq(councilSessions.id, councilReports.sessionId), eq(councilSessions.owner, owner)))
        .where(and(eq(councilReports.owner, owner), eq(councilReports.id, source.id)));
      const [row] = lock ? await query.for('share') : await query;
      if (!row || row.report.publicationOutcome === 'failed') throw new NotFoundException('REPORT_SOURCE_NOT_FOUND');
      ticker = row.session.ticker === 'PORTFOLIO' ? null : row.session.ticker;
      proposalLanguage=row.session.language;
      title = row.session.title || `${ticker ?? 'Portfolio'} · Research discussion`; sourceKey = `council:${row.session.id}`;
      fields = { summary: row.report.summary, dissent: row.report.dissent, nextReviewCondition: row.report.nextReviewCondition,
        evidence: row.report.evidence, researchStance: row.report.researchStance, thesisCandidates: row.report.thesisCandidates };
      snapshot = { businessDate:row.session.checkpoint?.simple?.contextDate??businessDate(row.report.createdAt,timezone),generatedAt:row.report.createdAt.toISOString(),evidence: row.report.evidence, inputRevision: row.report.revision, sessionId: row.session.id,
        scene: row.session.scene, subject: row.session.subject, period: row.session.period, references: row.session.references,
        resolvedReferences: row.session.resolvedReferences, parentSessionId: row.session.parentSessionId,
        parentMessageId: row.session.parentMessageId, inheritedContext: row.session.inheritedContext, continuationSummary: row.session.continuationSummary,
        ...(row.report.coverage?.executionPlan?{executionPlan:row.report.coverage.executionPlan}:{}),
        ...(row.report.coverage?.executionPlanError?{executionPlanError:row.report.coverage.executionPlanError}:{}) };
    }
    const sections = sectionsFromRecord(fields);
    if(snapshot?.executionPlan)sections.push({id:REPORT_EXECUTION_SECTION_ID,title:'执行策略草案 / Execution strategy proposal',content:renderReportExecutionPlan(snapshot.executionPlan,proposalLanguage)});
    else if(snapshot?.executionPlanError)sections.push({id:REPORT_EXECUTION_SECTION_ID,title:'执行策略草案 / Execution strategy proposal',content:snapshot.executionPlanError==='invalid'?'本次策略参数未通过校验，尚无可执行方案。请补充条件后重新生成研究。 / Strategy parameters failed validation; no executable proposal is available.':'本次报告未返回结构化执行策略，尚无可执行方案。可更新分析补齐。 / This report did not return a structured execution proposal. Update the analysis to obtain one.'});
    if (!sections.length) throw new BadRequestException('REPORT_EMPTY_SOURCE');
    return { input: { title, kind: source.type, ticker, content: sections.map(s => `## ${s.title}\n\n${s.content}`).join('\n\n'), sections }, sourceKey, snapshot };
  }
  private async sourceStatus(tx: ResearchDocumentsTransaction, owner: string, source: ReportSource | null, lock = false): Promise<'available' | 'missing'> {
    if (!source) return 'available';
    try { await this.loadSource(tx, owner, source, lock); return 'available'; }
    catch (error) { if (error instanceof NotFoundException || error instanceof BadRequestException) return 'missing'; throw error; }
  }

  async createDraft(owner: string, parentVersionId: string, input: ResearchRevisionInput): Promise<ResearchRevisionDraft> {
    this.owner(owner); this.id(parentVersionId);
    return this.db.transaction(async tx => {
      await lockMemoryOwner(tx, owner); return this.createDraftInTransaction(tx, owner, parentVersionId, input);
    });
  }
  /** The caller holds lockMemoryOwner and its own source revision fence. */
  async createDraftInTransaction(tx: ResearchDocumentsTransaction, owner: string, parentVersionId: string, input: ResearchRevisionInput): Promise<ResearchRevisionDraft> {
    this.owner(owner); this.id(parentVersionId); const checked = validateRevision(input);
    const parent = await this.versionRow(tx, owner, parentVersionId);
    for (const reference of checked.sourceReferences ?? []) resolveExactReference(this.version(await this.versionRow(tx, owner, reference.versionId)), reference);
    const [row] = await tx.insert(researchRevisionDrafts).values({ owner, reportId: parent.reportId, parentVersionId, ...checked,
      sections: checked.sections ?? [{ id: 'revision', title: checked.title, content: checked.content }] }).returning();
    return this.draft(row);
  }
  async updateDraft(owner: string, id: string, input: ResearchRevisionInput, expectedRevision: number): Promise<ResearchRevisionDraft> {
    this.owner(owner); this.id(id); const checked = validateRevision(input);
    return this.db.transaction(async tx => {
      await lockMemoryOwner(tx, owner);
      for (const reference of checked.sourceReferences ?? []) resolveExactReference(this.version(await this.versionRow(tx, owner, reference.versionId)), reference);
      const [row] = await tx.update(researchRevisionDrafts).set({ ...checked, sections: checked.sections ?? [{ id: 'revision', title: checked.title, content: checked.content }],
        revision: expectedRevision + 1, updatedAt: new Date() }).where(and(eq(researchRevisionDrafts.owner, owner), eq(researchRevisionDrafts.id, id),
        eq(researchRevisionDrafts.revision, expectedRevision), isNull(researchRevisionDrafts.publishedVersionId))).returning();
      if (!row) throw new ConflictException('REPORT_DRAFT_CONFLICT');
      return this.draft(row);
    });
  }
  async publishDraft(owner: string, id: string, expectedRevision: number): Promise<ResearchDocumentVersion> {
    this.owner(owner); this.id(id);
    return this.db.transaction(async tx => {
      await lockMemoryOwner(tx, owner);
      const [draft] = await tx.select().from(researchRevisionDrafts).where(and(eq(researchRevisionDrafts.owner, owner), eq(researchRevisionDrafts.id, id))).for('update');
      if (!draft) throw new NotFoundException('REPORT_DRAFT_NOT_FOUND');
      if (draft.revision !== expectedRevision) throw new ConflictException('REPORT_DRAFT_CONFLICT');
      if (draft.publishedVersionId) return this.version(await this.versionRow(tx, owner, draft.publishedVersionId));
      const parent = await this.versionRow(tx, owner, draft.parentVersionId);
      if (parent.revokedAt) throw new ConflictException('REPORT_REVOKED');
      const [document] = await tx.select().from(researchDocuments).where(and(eq(researchDocuments.owner, owner), eq(researchDocuments.id, draft.reportId))).for('update');
      if (document.latestVersionId !== parent.id) throw new ConflictException('REPORT_BASE_CHANGED_CREATE_BRANCH');
      // A manual report edit is new prose, not a fresh validated AI execution proposal.
      const {executionPlan:_plan,executionPlanError:_planError,...revisionSnapshot}=parent.snapshot??{};
      const version = await this.submitInTransaction(tx, owner, { idempotencyKey: `draft:${id}`, reportId: draft.reportId,
        title: draft.title, kind: parent.kind, ticker: parent.ticker, content: draft.content, sections: draft.sections,
        parentVersionId: parent.id, changeReason: draft.changeReason, dataAsOf: parent.dataAsOf?.toISOString() ?? null,
        availableAt: new Date().toISOString(), snapshot: { ...revisionSnapshot, reportReferences: [{ versionId: parent.id }, ...(draft.sourceReferences ?? [])] }, source: parent.source });
      await tx.update(researchRevisionDrafts).set({ publishedVersionId: version.id }).where(and(eq(researchRevisionDrafts.owner, owner), eq(researchRevisionDrafts.id, id)));
      return version;
    });
  }
  async adopt(owner: string, versionId: string, expectedAdoptedVersionId: string | null): Promise<void> {
    this.owner(owner); this.id(versionId); if (expectedAdoptedVersionId) this.id(expectedAdoptedVersionId);
    await this.db.transaction(async tx => {
      await lockMemoryOwner(tx, owner); const version = await this.versionRow(tx, owner, versionId);
      const [document] = await tx.select().from(researchDocuments).where(and(eq(researchDocuments.owner, owner), eq(researchDocuments.id, version.reportId))).for('update');
      assertAdoption(document.id, document.adoptedVersionId, this.version(version), expectedAdoptedVersionId);
      if (await this.sourceStatus(tx, owner, version.source) === 'missing') throw new ConflictException('REPORT_SOURCE_MISSING');
      if (document.adoptedVersionId === versionId) return;
      await tx.insert(researchDocumentAdoptions).values({ owner, reportId: document.id, versionId,
        previousVersionId: document.adoptedVersionId, actorId: owner });
      await tx.update(researchDocuments).set({ adoptedVersionId: versionId }).where(and(eq(researchDocuments.owner, owner), eq(researchDocuments.id, document.id)));
    });
  }
  async fork(owner: string, versionId: string, title: string): Promise<ResearchDocumentVersion> {
    this.owner(owner); this.id(versionId); if (!title?.trim() || title.length > 300) throw new BadRequestException('REPORT_INVALID_TITLE');
    return this.db.transaction(async tx => {
      await lockMemoryOwner(tx, owner); const parent = await this.versionRow(tx, owner, versionId);
      if (parent.revokedAt) throw new ConflictException('REPORT_REVOKED');
      if (await this.sourceStatus(tx, owner, parent.source) === 'missing') throw new ConflictException('REPORT_SOURCE_MISSING');
      const [document] = await tx.insert(researchDocuments).values({ owner, title: title.trim(), kind: parent.kind, ticker: parent.ticker, topicKey: reportTopic(parent.ticker), parentReportId: parent.reportId }).returning();
      return this.submitInTransaction(tx, owner, { idempotencyKey: `fork:${document.id}`, reportId: document.id, title: document.title,
        kind: parent.kind, ticker: parent.ticker, content: parent.content, sections: parent.sections, parentVersionId: parent.id,
        changeReason: 'Independent research branch', dataAsOf: parent.dataAsOf?.toISOString() ?? null, availableAt: parent.availableAt?.toISOString() ?? null,
        source: parent.source, snapshot: { ...parent.snapshot, reportReferences: [{ versionId: parent.id }] } });
    });
  }
  async recordStrategyUse(owner: string, versionId: string, strategyId: string): Promise<void> {
    this.owner(owner); this.id(versionId); this.id(strategyId);
    await this.db.transaction(async tx => { await lockMemoryOwner(tx, owner); await this.recordStrategyUseInTransaction(tx, owner, versionId, strategyId); });
  }
  async recordStrategyUseInTransaction(tx: ResearchDocumentsTransaction, owner: string, versionId: string, strategyId: string): Promise<void> {
    const version = await this.versionRow(tx, owner, versionId);
    if (version.revokedAt) throw new ConflictException('REPORT_REVOKED');
    if (await this.sourceStatus(tx, owner, version.source) === 'missing') throw new ConflictException('REPORT_SOURCE_MISSING');
    await tx.insert(researchDocumentStrategyUses).values({ owner, versionId, strategyId }).onConflictDoNothing();
  }
  async revoke(owner: string, versionId: string, reason: string): Promise<void> {
    this.owner(owner); this.id(versionId); if (!reason?.trim() || reason.length > 3000) throw new BadRequestException('REPORT_REVOCATION_REASON_REQUIRED');
    await this.db.transaction(async tx => {
      await lockMemoryOwner(tx, owner); await this.versionRow(tx, owner, versionId);
      await tx.update(researchDocumentVersions).set({ revokedAt: new Date(), revocationReason: reason.trim() }).where(and(eq(researchDocumentVersions.owner, owner), eq(researchDocumentVersions.id, versionId)));
    });
  }
}
