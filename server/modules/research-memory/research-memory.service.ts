import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { and, desc, eq, inArray, isNull, ne, or } from 'drizzle-orm';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '../../common/platform';
import { QuoteService } from '../quote/quote.service';
import { councilReports, councilSessions } from '../../database/council.schema';
import { researchMemories, researchMemoryPreferences, researchTheses, researchThesisVersions } from '../../database/research-memory.schema';
import type { ArchiveResearchReport, MemoryCitation, MemoryFlag, ResearchMemoryItem, ResearchMemoryList,
  ResearchMemoryPreferences, ResearchMemoryQuery, ResearchMemoryRecall, ResearchMemoryRecallItem,
  ResearchThesis, ResearchThesisVersion, ThesisContent, UpdateResearchThesis } from '@shared/research-memory.interface';
import { canonicalMemorySymbol, MEMORY_STALE_MS, normalizedTopic, rankMemoryRecall } from './research-memory.rules';
import { memoryIdSchema, memoryPreferencesSchema, memoryQuerySchema, memoryUpdateSchema,
  thesisCandidateSchema, thesisDeleteSchema, thesisUpdateSchema } from './research-memory.requests';

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
    const candidates = input.thesisCandidates ?? [{ claim: report.summary.slice(0, 1500),
      supportingEvidence: report.evidence.slice(0, 20).map(evidence => ({ evidenceId: evidence.id })),
      opposingEvidence: report.dissent.slice(0, 20).map(line => line.slice(0, 1500)).filter(Boolean),
      assumptions: [], indicators: report.nextReviewCondition ? [report.nextReviewCondition.slice(0, 1500)] : [],
      invalidationConditions: [] }];
    if (candidates.length > 5) throw new BadRequestException('MEMORY_TOO_MANY_CANDIDATES');
    const id = await this.db.transaction(async tx => {
      const [created] = await tx.insert(researchMemories).values({ owner, ...symbol, topic: normalizedTopic(input.topic),
        language: input.language, sessionId: source.session.id, reportId: report.id, reportVersion: report.version,
        reportRevision: report.revision, reportCreatedAt: report.createdAt, summary: report.summary.slice(0, 3000),
        decision: report.decision }).onConflictDoNothing().returning();
      if (!created) {
        const [existing] = await tx.select().from(researchMemories).where(and(eq(researchMemories.owner, owner),
          eq(researchMemories.reportId, report.id), eq(researchMemories.reportVersion, report.version)));
        return existing?.deletedAt ? null : existing?.id ?? null;
      }
      for (const inputCandidate of candidates) {
        const parsed = thesisCandidateSchema.safeParse(inputCandidate);
        if (!parsed.success) throw new BadRequestException('MEMORY_INVALID_THESIS');
        const { expiresAt, ...content } = parsed.data;
        this.validateEvidence(content, report);
        const [thesis] = await tx.insert(researchTheses).values({ owner, memoryId: created.id, content,
          expiresAt: expiresAt ? new Date(expiresAt) : null }).returning();
        await tx.insert(researchThesisVersions).values({ owner, thesisId: thesis.id, version: 1, content,
          status: 'candidate', action: 'candidate', excluded: false, expiresAt: thesis.expiresAt });
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
      eq(researchMemories.ticker, symbol.ticker), eq(researchMemories.market, symbol.market), isNull(researchMemories.deletedAt)))
      .orderBy(desc(researchMemories.reportCreatedAt)).limit(100);
    const memories = await Promise.all(rows.map(row => this.materializeMemory(owner, row)));
    const thesisRows = rows.length ? await this.db.select().from(researchTheses).where(and(eq(researchTheses.owner, owner),
      inArray(researchTheses.memoryId, rows.map(row => row.id)), isNull(researchTheses.deletedAt))).orderBy(desc(researchTheses.updatedAt)) : [];
    const theses = thesisRows.map(row => this.materializeThesis(row, memories.find(memory => memory.id === row.memoryId)!));
    return { memories, theses, preferences: await this.getPreferences(owner) };
  }

  async getMemory(owner: string, id: string): Promise<ResearchMemoryItem> {
    return this.materializeMemory(owner, await this.memoryRow(owner, id));
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
      await tx.update(researchMemories).set({ deletedAt: new Date(), excluded: true, summary: '' })
        .where(and(eq(researchMemories.owner, owner), eq(researchMemories.id, id)));
    });
    return { deleted: true };
  }

  async getThesis(owner: string, id: string): Promise<ResearchThesis> {
    const row = await this.thesisRow(owner, id);
    return this.materializeThesis(row, await this.getMemory(owner, row.memoryId));
  }
  async updateThesis(owner: string, id: string, input: UpdateResearchThesis): Promise<ResearchThesis> {
    const parsed = thesisUpdateSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException('MEMORY_INVALID_THESIS_UPDATE');
    const current = await this.thesisRow(owner, id);
    if (current.version !== input.expectedVersion) throw new ConflictException('MEMORY_VERSION_CONFLICT');
    const memory = await this.memoryRow(owner, current.memoryId);
    const source = await this.sourceReport(owner, memory);
    const content = parsed.data.content ?? current.content;
    if (source) this.validateEvidence(content, source);
    if (input.action === 'confirm' && (!source || !this.hasSources(content, source))) {
      throw new BadRequestException('MEMORY_SOURCE_REQUIRED');
    }
    const status = input.action === 'confirm' ? 'confirmed' : input.action === 'dismiss' ? 'dismissed'
      : input.action === 'expire' ? 'expired' : current.status;
    const expiresAt = input.expiresAt === undefined ? current.expiresAt : input.expiresAt ? new Date(input.expiresAt) : null;
    if (input.action === 'confirm' && expiresAt && expiresAt <= new Date()) throw new BadRequestException('MEMORY_THESIS_EXPIRED');
    await this.db.transaction(async tx => {
      const [updated] = await tx.update(researchTheses).set({ content, status, version: current.version + 1,
        excluded: input.excluded ?? current.excluded, expiresAt, updatedAt: new Date() })
        .where(and(eq(researchTheses.owner, owner), eq(researchTheses.id, id),
          eq(researchTheses.version, input.expectedVersion), isNull(researchTheses.deletedAt))).returning();
      if (!updated) throw new ConflictException('MEMORY_VERSION_CONFLICT');
      await tx.insert(researchThesisVersions).values({ owner, thesisId: id, version: updated.version,
        content: updated.content, status: updated.status, action: input.action, excluded: updated.excluded, expiresAt });
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
      content: thesis.sourceStatus === 'available' ? row.content : null, expiresAt: row.expiresAt?.toISOString() ?? null,
      excluded: row.excluded, sourceStatus: thesis.sourceStatus, createdAt: row.createdAt.toISOString() }));
  }

  async recall(owner: string, query: ResearchMemoryQuery & { enabled?: boolean }): Promise<ResearchMemoryRecall> {
    const { enabled, ...filters } = query;
    const preferences = await this.getPreferences(owner);
    if (enabled === false || !preferences.recallEnabled) return { items: [], context: '', preferences };
    const listing = await this.list(owner, filters);
    const items: ResearchMemoryRecallItem[] = [];
    for (const memory of listing.memories) {
      if (!memory.excluded && memory.source) items.push(this.historyRecallItem(memory));
    }
    for (const thesis of listing.theses) {
      if (this.recallableThesis(thesis) && !listing.memories.find(memory => memory.id === thesis.memoryId)?.excluded) {
        items.push(this.thesisRecallItem(thesis));
      }
    }
    return rankMemoryRecall(items, query.topic ?? '', preferences);
  }
  /** A checkpoint pins IDs/versions, never authority. Resolve owner and live source for every prompt. */
  async refreshRecall(owner: string, frozen: ResearchMemoryRecall): Promise<ResearchMemoryRecall> {
    const preferences = await this.getPreferences(owner);
    if (!preferences.recallEnabled) return { items: [], context: '', preferences };
    const items: ResearchMemoryRecallItem[] = [];
    for (const item of frozen.items.slice(0, 3)) {
      try {
        if (item.kind === 'history') {
          const memory = await this.getMemory(owner, item.id);
          if (memory.source && !memory.excluded && memory.source.reportVersion === item.version) items.push(this.historyRecallItem(memory));
        } else if (item.kind === 'thesis') {
          const thesis = await this.getThesis(owner, item.id);
          const memory = await this.getMemory(owner, thesis.memoryId);
          if (thesis.version === item.version && !memory.excluded && this.recallableThesis(thesis)) items.push(this.thesisRecallItem(thesis));
        }
      } catch (error) { if (!(error instanceof NotFoundException)) throw error; }
    }
    return rankMemoryRecall(items, '', preferences);
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
  private async materializeMemory(owner: string, row: MemoryRow): Promise<ResearchMemoryItem> {
    const report = await this.sourceReport(owner, row);
    const citations: MemoryCitation[] = report?.evidence.map(evidence => ({ evidenceId: evidence.id,
      title: evidence.title, sourceUrl: this.sourceUrl(evidence.sourceUrl), fetchedAt: evidence.fetchedAt })) ?? [];
    const flags: MemoryFlag[] = ['opinion'];
    if (report) {
      const [conflict] = await this.db.select({ id: researchMemories.id }).from(researchMemories)
        .innerJoin(councilReports, and(eq(councilReports.id, researchMemories.reportId),
          eq(councilReports.owner, owner), eq(councilReports.version, researchMemories.reportVersion),
          eq(councilReports.revision, researchMemories.reportRevision)))
        .innerJoin(councilSessions, and(eq(councilSessions.id, researchMemories.sessionId), eq(councilSessions.owner, owner)))
        .where(and(eq(researchMemories.owner, owner), eq(researchMemories.ticker, row.ticker),
          eq(researchMemories.market, row.market), eq(researchMemories.topic, row.topic),
          or(ne(researchMemories.decision, row.decision), report.researchStance
            ? ne(councilReports.researchStance, report.researchStance) : undefined),
          eq(researchMemories.excluded, false), isNull(researchMemories.deletedAt)))
        .limit(1);
      if (conflict) flags.push('contradictory');
    }
    if (Date.now() - row.reportCreatedAt.getTime() > MEMORY_STALE_MS
      || citations.some(citation => Date.now() - Date.parse(citation.fetchedAt) > MEMORY_STALE_MS)) flags.push('stale');
    if (!citations.length || citations.some(citation => /unverified|未(?:独立)?核验|未经核实/iu.test(citation.title)
      || !citation.sourceUrl || !Number.isFinite(Date.parse(citation.fetchedAt))
      || Date.parse(citation.fetchedAt) > Date.now() + 300_000)) flags.push('unverified');
    return { id: row.id, ticker: row.ticker, market: row.market, topic: row.topic, language: row.language,
      summary: report ? row.summary : '', decision: report ? row.decision : 'wait', excluded: row.excluded,
      sourceStatus: report ? 'available' : 'source-deleted', source: report ? { sessionId: row.sessionId,
        reportId: row.reportId, reportVersion: row.reportVersion, reportRevision: row.reportRevision,
        reportCreatedAt: row.reportCreatedAt.toISOString(),
        url: `/council?sessionId=${row.sessionId}&reportId=${row.reportId}#report-${row.reportId}-v${row.reportVersion}` } : null,
      citations, flags, createdAt: row.createdAt.toISOString() };
  }
  private materializeThesis(row: ThesisRow, memory: ResearchMemoryItem): ResearchThesis {
    const available = memory.sourceStatus === 'available';
    const citations = memory.citations.filter(citation => row.content.supportingEvidence.some(ref => ref.evidenceId === citation.evidenceId));
    const flags: MemoryFlag[] = memory.flags.filter(flag => flag !== 'stale' && flag !== 'unverified');
    if ((memory.source && Date.now() - Date.parse(memory.source.reportCreatedAt) > MEMORY_STALE_MS)
      || citations.some(citation => Date.now() - Date.parse(citation.fetchedAt) > MEMORY_STALE_MS)) flags.push('stale');
    if (!citations.length || citations.length !== row.content.supportingEvidence.length || citations.some(citation =>
      /unverified|未(?:独立)?核验|未经核实/iu.test(citation.title) || !citation.sourceUrl
      || !Number.isFinite(Date.parse(citation.fetchedAt)) || Date.parse(citation.fetchedAt) > Date.now() + 300_000)) flags.push('unverified');
    return { ...(available ? row.content : EMPTY_CONTENT), id: row.id, memoryId: row.memoryId, ticker: memory.ticker,
      market: memory.market, topic: memory.topic, status: row.expiresAt && row.expiresAt <= new Date() ? 'expired' : row.status,
      version: row.version, excluded: row.excluded, expiresAt: row.expiresAt?.toISOString() ?? null,
      sourceStatus: memory.sourceStatus, source: memory.source, citations, flags,
      createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
  }
  private sourceUrl(value: string | null): string | null {
    try { const url = new URL(value ?? ''); return ['https:', 'http:'].includes(url.protocol) ? url.toString() : null; } catch { return null; }
  }
  private validateEvidence(content: ThesisContent, report: ReportRow): void {
    const ids = content.supportingEvidence.map(ref => ref.evidenceId);
    if (new Set(ids).size !== ids.length || ids.some(id => !report.evidence.some(evidence => evidence.id === id))) {
      throw new BadRequestException('MEMORY_INVALID_EVIDENCE');
    }
  }
  private hasSources(content: ThesisContent, report: ReportRow): boolean {
    return content.supportingEvidence.length > 0 && content.supportingEvidence.every(ref => report.evidence.some(evidence =>
      evidence.id === ref.evidenceId && this.sourceUrl(evidence.sourceUrl) && Number.isFinite(Date.parse(evidence.fetchedAt))
      && Date.parse(evidence.fetchedAt) <= Date.now() + 300_000));
  }
  private recallableThesis(thesis: ResearchThesis): boolean {
    return thesis.status === 'confirmed' && !thesis.excluded && Boolean(thesis.source)
      && !thesis.flags.includes('unverified') && !thesis.flags.includes('stale');
  }
  private historyRecallItem(memory: ResearchMemoryItem): ResearchMemoryRecallItem {
    return { kind: 'history', id: memory.id, memoryId: memory.id, version: memory.source!.reportVersion, topic: memory.topic,
      summary: memory.summary, flags: memory.flags, source: memory.source!, citations: memory.citations };
  }
  private thesisRecallItem(thesis: ResearchThesis): ResearchMemoryRecallItem {
    return { kind: 'thesis', id: thesis.id, memoryId: thesis.memoryId, version: thesis.version, topic: thesis.topic,
      summary: [thesis.claim, ...thesis.opposingEvidence.map(line => `Opposing: ${line}`),
        ...thesis.assumptions.map(line => `Assumption: ${line}`), ...thesis.indicators.map(line => `Indicator: ${line}`),
        ...thesis.invalidationConditions.map(line => `Invalidation: ${line}`)].join('\n'),
      flags: thesis.flags, source: thesis.source!, citations: thesis.citations };
  }
}
