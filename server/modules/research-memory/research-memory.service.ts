import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { and, desc, eq, inArray, isNull, lte } from 'drizzle-orm';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '../../common/platform';
import { QuoteService } from '../quote/quote.service';
import { councilReports, councilSessions } from '../../database/council.schema';
import { researchMemories, researchMemoryPreferences, researchTheses, researchThesisVersions, researchMemoryEvidence } from '../../database/research-memory.schema';
import type { ArchiveResearchReport, MemoryCitation, MemoryFlag, MemoryOmission, ResearchMemoryItem, ResearchMemoryList,
  ResearchMemoryPreferences, ResearchMemoryQuery, ResearchMemoryRecall, ResearchMemoryRecallItem,
  ResearchThesis, ResearchThesisVersion, ThesisContent, UpdateResearchThesis, ResearchEvidenceGraph } from '@shared/research-memory.interface';
import { canonicalMemorySymbol, normalizedTopic, rankMemoryRecall } from './research-memory.rules';
import { memoryIdSchema, memoryPreferencesSchema, memoryQuerySchema, memoryUpdateSchema,
  thesisCandidateSchema, thesisDeleteSchema, thesisUpdateSchema } from './research-memory.requests';
import { isUnverifiedCitation, normalizeThesisContent, thesisEvidenceIds, thesisFingerprint, validateThesisReferences } from './research-memory.theses';
import { acceptedWorkflowProvenance } from './research-memory.provenance';
import { memoryReference } from './research-memory.context';
import { compactEvidenceMetadata, evidenceVisibleAt, normalizeEvidenceMetadata, thesisFreshness } from './research-memory.temporal';
import { archiveEvidence, bindThesisEvidence, evidenceComparisons, evidenceRelations } from './research-memory.evidence';

type MemoryRow = typeof researchMemories.$inferSelect;
type ThesisRow = typeof researchTheses.$inferSelect;
type ReportRow = typeof councilReports.$inferSelect;
const EMPTY_CONTENT: ThesisContent = { claim: '', supportingEvidence: [], opposingEvidence: [], assumptions: [], indicators: [], invalidationConditions: [] };
const DEFAULT_PREFERENCES: ResearchMemoryPreferences = { autoArchive: true, recallEnabled: true };

@Injectable()
export class ResearchMemoryService {
  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase, private readonly quotes: QuoteService) {}

  async getPreferences(owner: string): Promise<ResearchMemoryPreferences> {
    this.owner(owner);
    const [row] = await this.db.select().from(researchMemoryPreferences).where(eq(researchMemoryPreferences.owner, owner));
    return row ? { autoArchive: row.autoArchive, recallEnabled: row.recallEnabled } : { ...DEFAULT_PREFERENCES };
  }
  async updatePreferences(owner: string, input: ResearchMemoryPreferences): Promise<ResearchMemoryPreferences> {
    this.owner(owner);
    const parsed = memoryPreferencesSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException('MEMORY_INVALID_PREFERENCES');
    await this.db.insert(researchMemoryPreferences).values({ owner, ...parsed.data })
      .onConflictDoUpdate({ target: researchMemoryPreferences.owner, set: parsed.data });
    return parsed.data;
  }

  async archiveReport(owner: string, input: ArchiveResearchReport): Promise<ResearchMemoryItem | null> {
    if (!(await this.getPreferences(owner)).autoArchive) return null;
    this.id(input.sessionId); this.id(input.report.id);
    const symbol = this.symbol(input);
    const [source] = await this.db.select({ report: councilReports, session: councilSessions }).from(councilReports)
      .innerJoin(councilSessions, and(eq(councilReports.sessionId, councilSessions.id), eq(councilSessions.owner, owner)))
      .where(and(eq(councilReports.id, input.report.id), eq(councilReports.owner, owner),
        eq(councilReports.sessionId, input.sessionId), eq(councilReports.version, input.report.version))).limit(1);
    if (!source) throw new NotFoundException('MEMORY_SOURCE_NOT_FOUND');
    if (source.session.status !== 'completed') throw new BadRequestException('MEMORY_SOURCE_NOT_COMPLETED');
    const sourceSymbol = this.symbol({ ticker: source.session.ticker });
    if (sourceSymbol.ticker !== symbol.ticker || sourceSymbol.market !== symbol.market
      || input.language !== source.session.language) throw new BadRequestException('MEMORY_SOURCE_MISMATCH');
    const report = source.report;
    const supplied = input.thesisCandidates !== undefined;
    const raw = supplied ? input.thesisCandidates! : report.thesisCandidates ?? [];
    if (!Array.isArray(raw) || raw.length > 5) throw new BadRequestException('MEMORY_TOO_MANY_CANDIDATES');
    const workflow = !supplied ? await acceptedWorkflowProvenance(this.db, owner, source.session.id, report) : undefined;
    const seen = new Set<string>();
    const candidates = raw.map(candidate => {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw new BadRequestException('MEMORY_INVALID_THESIS');
      // Stored provenance is server-owned; request bodies cannot assert it.
      const { provenance: _provenance, ...stored } = candidate;
      const parsed = thesisCandidateSchema.safeParse(supplied ? candidate : stored);
      if (!parsed.success) throw new BadRequestException('MEMORY_INVALID_THESIS');
      const { expiresAt, ...fields } = parsed.data;
      const content = normalizeThesisContent(fields, supplied ? 'user' : 'agent');
      if (workflow) content.provenance = { origin: 'agent', workflow };
      this.validateEvidence(content, report);
      const accepted = Boolean(workflow && this.hasSources(content, report) && thesisEvidenceIds(content).every(id => {
        const evidence = report.evidence.find(item => item.id === id)!;
        return !isUnverifiedCitation(evidence);
      }));
      return { content, expiresAt: expiresAt ? new Date(expiresAt) : null, status: accepted ? 'accepted' as const : 'candidate' as const };
    }).filter(candidate => {
      const fingerprint = thesisFingerprint({ ...candidate.content, expiresAt: candidate.expiresAt?.toISOString() ?? null } as ThesisContent);
      if (seen.has(fingerprint)) return false;
      seen.add(fingerprint); return true;
    });
    const id = await this.db.transaction(async tx => {
      const [created] = await tx.insert(researchMemories).values({ owner, ...symbol, topic: normalizedTopic(input.topic),
        language: input.language, sessionId: source.session.id, reportId: report.id, reportVersion: report.version,
        reportRevision: report.revision, reportCreatedAt: report.createdAt, summary: report.summary.slice(0, 3000),
        decision: report.decision, createdAt: new Date() }).onConflictDoNothing().returning();
      if (!created) {
        const [existing] = await tx.select().from(researchMemories).where(and(eq(researchMemories.owner, owner),
          eq(researchMemories.reportId, report.id), eq(researchMemories.reportVersion, report.version)));
        return existing?.deletedAt ? null : existing?.id ?? null;
      }
      const evidence = await archiveEvidence(tx, owner, created, report.evidence);
      for (const { content, expiresAt, status } of candidates) {
        const [thesis] = await tx.insert(researchTheses).values({ owner, memoryId: created.id, content, status, expiresAt, createdAt: created.createdAt, updatedAt: created.createdAt }).returning();
        const [version] = await tx.insert(researchThesisVersions).values({ owner, thesisId: thesis.id, version: 1, content,
          status, action: status === 'accepted' ? 'accept' : 'candidate', excluded: false, expiresAt: thesis.expiresAt, createdAt: created.createdAt }).returning();
        await bindThesisEvidence(tx, owner, version.id, content, evidence);
      }
      return created.id;
    });
    return id ? this.getMemory(owner, id) : null;
  }

  async list(owner: string, input: ResearchMemoryQuery): Promise<ResearchMemoryList> {
    this.owner(owner);
    const parsed = memoryQuerySchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException('MEMORY_INVALID_QUERY');
    const symbol = this.symbol(parsed.data);
    const rows = await this.db.select().from(researchMemories).where(and(eq(researchMemories.owner, owner),
      eq(researchMemories.ticker, symbol.ticker), eq(researchMemories.market, symbol.market), isNull(researchMemories.deletedAt),
      parsed.data.asOf ? lte(researchMemories.createdAt, new Date(parsed.data.asOf)) : undefined))
      .orderBy(desc(researchMemories.reportCreatedAt)).limit(100);
    const memories = (await Promise.all(rows.map(row => this.materializeMemory(owner, row, parsed.data.asOf))))
      .filter(memory => !parsed.data.asOf || !memory.excluded && memory.sourceStatus !== 'not-yet-known');
    const thesisRows = rows.length ? await this.db.select().from(researchTheses).where(and(eq(researchTheses.owner, owner),
      inArray(researchTheses.memoryId, rows.map(row => row.id)), isNull(researchTheses.deletedAt))).orderBy(desc(researchTheses.updatedAt)) : [];
    const theses: ResearchThesis[] = [];
    for (const current of thesisRows) {
      const memory = memories.find(item => item.id === current.memoryId);
      if (!memory || parsed.data.asOf && (current.excluded || memory.excluded)) continue;
      const row = await this.thesisAt(owner, current, parsed.data.asOf);
      if (row) theses.push(this.materializeThesis(row, memory, parsed.data.asOf));
    }
    return { memories, theses, preferences: await this.getPreferences(owner) };
  }

  async getMemory(owner: string, id: string, asOf?: string): Promise<ResearchMemoryItem> {
    return this.materializeMemory(owner, await this.memoryRow(owner, id), asOf);
  }
  async updateMemory(owner: string, id: string, input: { excluded: boolean }): Promise<ResearchMemoryItem> {
    await this.memoryRow(owner, id);
    if (!memoryUpdateSchema.safeParse(input).success) throw new BadRequestException('MEMORY_INVALID_UPDATE');
    await this.db.update(researchMemories).set({ excluded: input.excluded })
      .where(and(eq(researchMemories.owner, owner), eq(researchMemories.id, id), isNull(researchMemories.deletedAt)));
    return this.getMemory(owner, id);
  }
  async deleteMemory(owner: string, id: string): Promise<{ deleted: true }> {
    await this.memoryRow(owner, id);
    await this.db.transaction(async tx => {
      // Lock/update children before deleting their versions: a concurrent editor cannot insert a new
      // version between the purge and tombstone. The source archive remains a non-resurrectable ID.
      const theses = await tx.update(researchTheses).set({ deletedAt: new Date(), excluded: true, content: EMPTY_CONTENT })
        .where(and(eq(researchTheses.owner, owner), eq(researchTheses.memoryId, id))).returning({ id: researchTheses.id });
      if (theses.length) await tx.delete(researchThesisVersions).where(and(eq(researchThesisVersions.owner, owner),
        inArray(researchThesisVersions.thesisId, theses.map(thesis => thesis.id))));
      await tx.delete(researchMemoryEvidence).where(and(eq(researchMemoryEvidence.owner, owner), eq(researchMemoryEvidence.memoryId, id)));
      await tx.update(researchMemories).set({ deletedAt: new Date(), excluded: true, summary: '' })
        .where(and(eq(researchMemories.owner, owner), eq(researchMemories.id, id)));
    });
    return { deleted: true };
  }

  async getThesis(owner: string, id: string, asOf?: string): Promise<ResearchThesis> {
    const row = await this.thesisAt(owner, await this.thesisRow(owner, id), asOf);
    if (!row) throw new NotFoundException('MEMORY_THESIS_NOT_FOUND');
    return this.materializeThesis(row, await this.getMemory(owner, row.memoryId, asOf), asOf);
  }
  async updateThesis(owner: string, id: string, input: UpdateResearchThesis): Promise<ResearchThesis> {
    const parsed = thesisUpdateSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException('MEMORY_INVALID_THESIS_UPDATE');
    const current = await this.thesisRow(owner, id);
    if (current.version !== input.expectedVersion) throw new ConflictException('MEMORY_VERSION_CONFLICT');
    const memory = await this.memoryRow(owner, current.memoryId);
    const source = await this.sourceReport(owner, memory);
    const content = parsed.data.content ? normalizeThesisContent({ ...current.content, ...parsed.data.content, provenance: { origin: 'user' } }, 'user')
      : normalizeThesisContent(current.content);
    if (source) this.validateEvidence(content, source);
    else if (parsed.data.content && thesisEvidenceIds(content).length) throw new BadRequestException('MEMORY_SOURCE_REQUIRED');
    if (input.action === 'confirm' && (!source || !this.hasSources(content, source))) {
      throw new BadRequestException('MEMORY_SOURCE_REQUIRED');
    }
    const status = input.action === 'confirm' ? 'confirmed' : input.action === 'dismiss' ? 'dismissed'
      : input.action === 'expire' ? 'expired' : input.action === 'edit' && current.status === 'accepted' ? 'candidate' : current.status;
    const expiresAt = input.expiresAt === undefined ? current.expiresAt : input.expiresAt ? new Date(input.expiresAt) : null;
    await this.db.transaction(async tx => {
      const [updated] = await tx.update(researchTheses).set({ content, status, version: current.version + 1,
        excluded: input.excluded ?? current.excluded, expiresAt, updatedAt: new Date() })
        .where(and(eq(researchTheses.owner, owner), eq(researchTheses.id, id),
          eq(researchTheses.version, input.expectedVersion), isNull(researchTheses.deletedAt))).returning();
      if (!updated) throw new ConflictException('MEMORY_VERSION_CONFLICT');
      const [version] = await tx.insert(researchThesisVersions).values({ owner, thesisId: id, version: updated.version,
        content: updated.content, status: updated.status, action: input.action, excluded: updated.excluded, expiresAt,
        changeReason: parsed.data.changeReason ?? null, createdAt: updated.updatedAt }).returning();
      const evidence = await tx.select().from(researchMemoryEvidence).where(and(eq(researchMemoryEvidence.owner, owner), eq(researchMemoryEvidence.memoryId, memory.id)));
      await bindThesisEvidence(tx, owner, version.id, content, evidence);
    });
    return this.getThesis(owner, id);
  }
  async deleteThesis(owner: string, id: string, expectedVersion: number): Promise<{ deleted: true }> {
    await this.thesisRow(owner, id);
    if (!thesisDeleteSchema.safeParse({ expectedVersion }).success) throw new BadRequestException('MEMORY_INVALID_VERSION');
    await this.db.transaction(async tx => {
      const [removed] = await tx.update(researchTheses).set({ content: EMPTY_CONTENT, deletedAt: new Date(),
        excluded: true, version: expectedVersion + 1, updatedAt: new Date() }).where(and(eq(researchTheses.owner, owner),
        eq(researchTheses.id, id), eq(researchTheses.version, expectedVersion), isNull(researchTheses.deletedAt))).returning();
      if (!removed) throw new ConflictException('MEMORY_VERSION_CONFLICT');
      await tx.delete(researchThesisVersions).where(and(eq(researchThesisVersions.owner, owner), eq(researchThesisVersions.thesisId, id)));
    });
    return { deleted: true };
  }
  async thesisVersions(owner: string, id: string): Promise<ResearchThesisVersion[]> {
    const thesis = await this.getThesis(owner, id);
    const versions = await this.db.select().from(researchThesisVersions)
      .where(and(eq(researchThesisVersions.owner, owner), eq(researchThesisVersions.thesisId, id)))
      .orderBy(desc(researchThesisVersions.version));
    return versions.map(row => ({ version: row.version, action: row.action, status: row.status,
      content: thesis.sourceStatus === 'available' ? normalizeThesisContent(row.content) : null, expiresAt: row.expiresAt?.toISOString() ?? null,
      excluded: row.excluded, sourceStatus: thesis.sourceStatus, changeReason: row.changeReason, createdAt: row.createdAt.toISOString() }));
  }

  async recall(owner: string, query: ResearchMemoryQuery & { enabled?: boolean }): Promise<ResearchMemoryRecall> {
    const { enabled, ...filters } = query;
    if (!memoryQuerySchema.safeParse(filters).success) throw new BadRequestException('MEMORY_INVALID_QUERY');
    const preferences = await this.getPreferences(owner);
    if (enabled === false || !preferences.recallEnabled) return { items: [], context: '', preferences, ...(query.asOf ? { asOf: query.asOf } : {}) };
    const listing = await this.list(owner, filters);
    const items: ResearchMemoryRecallItem[] = [];
    for (const memory of listing.memories) {
      if (!memory.excluded && memory.source) items.push(this.historyRecallItem(memory, query.asOf));
    }
    for (const thesis of listing.theses) {
      if (this.recallableThesis(thesis) && !listing.memories.find(memory => memory.id === thesis.memoryId)?.excluded) {
        items.push(this.thesisRecallItem(thesis, query.asOf));
      }
    }
    return { ...rankMemoryRecall(items, query.topic ?? '', preferences), ...(query.asOf ? { asOf: query.asOf } : {}) };
  }
  /** A checkpoint pins IDs/versions, never authority. Resolve owner and live source for every prompt. */
  async refreshRecall(owner: string, frozen: ResearchMemoryRecall, query?: ResearchMemoryQuery & { enabled?: boolean }): Promise<ResearchMemoryRecall> {
    const cutoff = query?.asOf ?? frozen.asOf;
    if (query && !memoryQuerySchema.safeParse((({ enabled: _enabled, ...filters }) => filters)({ ...query, asOf: cutoff })).success
      || cutoff && !memoryQuerySchema.shape.asOf.safeParse(cutoff).success) throw new BadRequestException('MEMORY_INVALID_QUERY');
    const preferences = await this.getPreferences(owner);
    const requested = frozen.items.slice(0, 3).map(memoryReference);
    if (!preferences.recallEnabled || query?.enabled === false) return { items: [], context: '', preferences, requested,
      omissions: requested.map(item => ({ ...item, reason: 'disabled' })), ...(cutoff ? { asOf: cutoff } : {}) };
    const symbol = query ? this.symbol(query) : undefined;
    const items: ResearchMemoryRecallItem[] = [];
    const omissions: MemoryOmission[] = [];
    for (const item of frozen.items.slice(0, 3)) {
      let reason: MemoryOmission['reason'] = 'revoked', currentVersion: number | undefined;
      try {
        if (item.kind === 'history') {
          const memory = await this.getMemory(owner, item.id, cutoff);
          if (memory.source && !memory.excluded && (!symbol || memory.ticker === symbol.ticker && memory.market === symbol.market)) {
            if (memory.source.reportVersion === item.version) { items.push(this.historyRecallItem(memory, cutoff)); continue; }
            reason = 'version-changed'; currentVersion = memory.source.reportVersion;
          }
        } else if (item.kind === 'thesis') {
          const thesis = await this.getThesis(owner, item.id, cutoff);
          const memory = await this.getMemory(owner, thesis.memoryId, cutoff);
          if (!memory.excluded && this.recallableThesis(thesis) && (!symbol || memory.ticker === symbol.ticker && memory.market === symbol.market)) {
            if (thesis.version === item.version) { items.push(this.thesisRecallItem(thesis, cutoff)); continue; }
            reason = 'version-changed'; currentVersion = thesis.version;
          } else if (!memory.excluded && (!symbol || memory.ticker === symbol.ticker && memory.market === symbol.market)
            && thesis.version !== item.version && !thesis.excluded && thesis.source && !['dismissed', 'expired'].includes(thesis.status)) {
            reason = 'version-changed'; currentVersion = thesis.version;
          }
        }
      } catch (error) { if (!(error instanceof NotFoundException)) throw error; }
      omissions.push({ ...memoryReference(item), reason, ...(currentVersion ? { currentVersion } : {}) });
    }
    return { ...rankMemoryRecall(items, '', preferences), requested, omissions, ...(cutoff ? { asOf: cutoff } : {}) };
  }

  private owner(owner: string): void { if (!owner?.trim()) throw new UnauthorizedException('MEMORY_OWNER_REQUIRED'); }
  private id(id: string): void { if (!memoryIdSchema.safeParse(id).success) throw new BadRequestException('MEMORY_INVALID_ID'); }
  private symbol(input: ResearchMemoryQuery) {
    return canonicalMemorySymbol(input.ticker, input.market, ticker => this.quotes.detectMarket(ticker));
  }
  private async memoryRow(owner: string, id: string): Promise<MemoryRow> {
    this.owner(owner); this.id(id);
    const [row] = await this.db.select().from(researchMemories).where(and(eq(researchMemories.owner, owner),
      eq(researchMemories.id, id), isNull(researchMemories.deletedAt))).limit(1);
    if (!row) throw new NotFoundException('MEMORY_NOT_FOUND');
    return row;
  }
  private async thesisRow(owner: string, id: string): Promise<ThesisRow> {
    this.owner(owner); this.id(id);
    const [row] = await this.db.select().from(researchTheses).where(and(eq(researchTheses.owner, owner),
      eq(researchTheses.id, id), isNull(researchTheses.deletedAt))).limit(1);
    if (!row) throw new NotFoundException('MEMORY_THESIS_NOT_FOUND');
    return row;
  }
  private async sourceReport(owner: string, memory: MemoryRow): Promise<ReportRow | null> {
    const [row] = await this.db.select({ report: councilReports, ticker: councilSessions.ticker }).from(councilReports)
      .innerJoin(councilSessions, and(eq(councilReports.sessionId, councilSessions.id), eq(councilSessions.owner, owner)))
      .where(and(eq(councilReports.owner, owner), eq(councilReports.id, memory.reportId),
        eq(councilReports.sessionId, memory.sessionId), eq(councilReports.version, memory.reportVersion),
        eq(councilReports.revision, memory.reportRevision))).limit(1);
    if (!row) return null;
    const symbol = this.symbol({ ticker: row.ticker });
    return symbol.ticker === memory.ticker && symbol.market === memory.market ? row.report : null;
  }
  private async materializeMemory(owner: string, row: MemoryRow, asOf = new Date().toISOString()): Promise<ResearchMemoryItem> {
    const source = await this.sourceReport(owner, row);
    const records = source ? await this.db.select().from(researchMemoryEvidence)
      .where(and(eq(researchMemoryEvidence.owner, owner), eq(researchMemoryEvidence.memoryId, row.id))) : [];
    const known = row.createdAt.getTime() <= Date.parse(asOf) && row.reportCreatedAt.getTime() <= Date.parse(asOf)
      && source?.evidence.every(item => {
        const record = records.find(record => record.evidenceId === item.id);
        return evidenceVisibleAt(record?.metadata ?? normalizeEvidenceMetadata(item), (record?.ingestedAt ?? row.createdAt).toISOString(), asOf);
      });
    const report = known ? source : null;
    const comparisons = report && !row.excluded ? await evidenceComparisons(this.db, owner, row, records, asOf,
      ticker => { const symbol = this.symbol({ ticker }); return symbol.ticker === row.ticker && symbol.market === row.market; }) : [];
    const conflicts = new Set(comparisons.filter(item => item.kind === 'conflict').map(item => item.left));
    const citations: MemoryCitation[] = report?.evidence.map(evidence => {
      const record = records.find(record => record.evidenceId === evidence.id);
      return { evidenceId: evidence.id, title: evidence.title, sourceUrl: this.sourceUrl(evidence.sourceUrl),
        fetchedAt: evidence.fetchedAt, ...(record ? { recordId: record.id } : {}),
        metadata: compactEvidenceMetadata(record?.metadata ?? normalizeEvidenceMetadata(evidence)),
        ...(record && conflicts.has(record.id) ? { conflicting: true } : {}) };
    }) ?? [];
    const flags: MemoryFlag[] = ['opinion'];
    if (conflicts.size) flags.push('contradictory', 'needs_review');
    if (!citations.length || citations.some(isUnverifiedCitation)) flags.push('unverified');
    if (!citations.length || citations.some(citation => citation.metadata?.sources.some(source => source.verification === 'unknown'))) flags.push('provenance_unknown');
    return { id: row.id, ticker: row.ticker, market: row.market, topic: row.topic, language: row.language,
      summary: report ? row.summary : '', decision: report ? row.decision : 'wait', excluded: row.excluded,
      sourceStatus: report ? 'available' : source ? 'not-yet-known' : 'source-deleted', source: report ? { sessionId: row.sessionId,
        reportId: row.reportId, reportVersion: row.reportVersion, reportRevision: row.reportRevision,
        reportCreatedAt: row.reportCreatedAt.toISOString(),
        url: `/council?sessionId=${row.sessionId}&reportId=${row.reportId}#report-${row.reportId}-v${row.reportVersion}` } : null,
      citations, flags, thesisStructure: report?.thesisCandidates?.length ? 'present' : 'missing', createdAt: row.createdAt.toISOString() };
  }
  private materializeThesis(row: ThesisRow, memory: ResearchMemoryItem, asOf = new Date().toISOString()): ResearchThesis {
    const available = memory.sourceStatus === 'available';
    const ids = thesisEvidenceIds(row.content);
    const citations = memory.citations.filter(citation => ids.includes(citation.evidenceId));
    const flags: MemoryFlag[] = ['opinion'];
    const conflict = citations.some(citation => citation.conflicting);
    const freshness = thesisFreshness(row.content, row.expiresAt?.toISOString() ?? null, asOf, conflict);
    if (conflict) flags.push('contradictory');
    if (freshness === 'needs_review') flags.push('needs_review');
    if (freshness === 'expired') flags.push('stale');
    if (!row.content.supportingEvidence.length || citations.length !== ids.length || citations.some(isUnverifiedCitation)) flags.push('unverified');
    if (!citations.length || citations.some(citation => citation.metadata?.sources.some(source => source.verification === 'unknown'))) flags.push('provenance_unknown');
    return { ...normalizeThesisContent(available ? row.content : EMPTY_CONTENT), id: row.id, memoryId: row.memoryId, ticker: memory.ticker,
      market: memory.market, topic: memory.topic, status: row.status, freshness,
      version: row.version, excluded: row.excluded, expiresAt: row.expiresAt?.toISOString() ?? null,
      sourceStatus: memory.sourceStatus, source: memory.source, citations, flags,
      createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
  }
  private async thesisAt(owner: string, current: ThesisRow, asOf?: string): Promise<ThesisRow | null> {
    if (!asOf) return current;
    if (current.createdAt.getTime() > Date.parse(asOf)) return null;
    const [version] = await this.db.select().from(researchThesisVersions).where(and(eq(researchThesisVersions.owner, owner),
      eq(researchThesisVersions.thesisId, current.id), lte(researchThesisVersions.createdAt, new Date(asOf))))
      .orderBy(desc(researchThesisVersions.version)).limit(1);
    return version ? { ...current, version: version.version, content: version.content, status: version.status,
      excluded: current.excluded || version.excluded, expiresAt: version.expiresAt, updatedAt: version.createdAt } : null;
  }
  async evidenceGraph(owner: string, memoryId: string): Promise<ResearchEvidenceGraph> {
    const row = await this.memoryRow(owner, memoryId), memory = await this.materializeMemory(owner, row);
    if (!memory.source || memory.excluded) return { evidence: [], relations: [], comparisons: [] };
    const records = await this.db.select().from(researchMemoryEvidence).where(and(eq(researchMemoryEvidence.owner, owner), eq(researchMemoryEvidence.memoryId, memoryId)));
    const comparisons = await evidenceComparisons(this.db, owner, row, records, new Date().toISOString(),
      ticker => { const symbol = this.symbol({ ticker }); return symbol.ticker === row.ticker && symbol.market === row.market; });
    return { evidence: records.map(({ owner: _owner, ingestedAt, ...record }) => ({ ...record, ingestedAt: ingestedAt.toISOString() })),
      relations: await evidenceRelations(this.db, owner, records), comparisons };
  }
  private sourceUrl(value: string | null): string | null {
    try { const url = new URL(value ?? ''); return ['https:', 'http:'].includes(url.protocol) ? url.toString() : null; } catch { return null; }
  }
  private validateEvidence(content: ThesisContent, report: ReportRow): void {
    if (!validateThesisReferences(content, new Set(report.evidence.map(evidence => evidence.id)))) {
      throw new BadRequestException('MEMORY_INVALID_EVIDENCE');
    }
  }
  private hasSources(content: ThesisContent, report: ReportRow): boolean {
    return content.supportingEvidence.length > 0 && content.supportingEvidence.every(ref => report.evidence.some(evidence =>
      evidence.id === ref.evidenceId && this.sourceUrl(evidence.sourceUrl) && Number.isFinite(Date.parse(evidence.fetchedAt))
      && Date.parse(evidence.fetchedAt) <= Date.now() + 300_000));
  }
  private recallableThesis(thesis: ResearchThesis): boolean {
    return ['accepted', 'confirmed'].includes(thesis.status) && !thesis.excluded && Boolean(thesis.source)
      && !thesis.flags.includes('unverified') && !['expired', 'not_yet_valid'].includes(thesis.freshness ?? 'unknown');
  }
  private historyRecallItem(memory: ResearchMemoryItem, asOf?: string): ResearchMemoryRecallItem {
    return { kind: 'history', id: memory.id, memoryId: memory.id, version: memory.source!.reportVersion, topic: memory.topic,
      summary: memory.summary, flags: memory.flags, source: memory.source!, citations: memory.citations, ...(asOf ? { asOf } : {}) };
  }
  private thesisRecallItem(thesis: ResearchThesis, asOf?: string): ResearchMemoryRecallItem {
    const { claim, supportingEvidence, opposingEvidence, assumptions, indicators, invalidationConditions,
      horizon, boundaryOrigin, evidenceRelations, provenance } = thesis;
    const content: ThesisContent = { claim, supportingEvidence, opposingEvidence, assumptions, indicators, invalidationConditions,
      ...(horizon ? { horizon } : {}), boundaryOrigin, evidenceRelations, provenance };
    return { kind: 'thesis', id: thesis.id, memoryId: thesis.memoryId, version: thesis.version, topic: thesis.topic,
      summary: [thesis.claim, ...thesis.opposingEvidence.map(line => `Opposing: ${line}`),
        ...thesis.assumptions.map(line => `Assumption: ${line}`), ...thesis.indicators.map(line => `Indicator: ${line}`),
        ...thesis.invalidationConditions.map(line => `Invalidation: ${line}`)].join('\n'),
      flags: thesis.flags, source: thesis.source!, citations: thesis.citations, provenance: thesis.provenance,
      content, status: thesis.status, expiresAt: thesis.expiresAt, freshness: thesis.freshness, ...(asOf ? { asOf } : {}),
      endorsement: thesis.status === 'confirmed' ? 'user' : 'agent' };
  }
}
