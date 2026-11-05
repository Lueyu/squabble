import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { and, desc, eq, inArray, isNull, lte, or } from 'drizzle-orm';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '../../common/platform';
import { QuoteService } from '../quote/quote.service';
import { councilReports, councilSessions } from '../../database/council.schema';
import { researchMemories, researchMemoryPreferences, researchTheses, researchThesisVersions, researchMemoryEvidence } from '../../database/research-memory.schema';
import type { ArchiveResearchReport, MemoryCitation, MemoryFlag, MemoryOmission, MemoryReference, ResearchMemoryItem, ResearchMemoryList,
  ResearchMemoryPreferences, ResearchMemoryQuery, ResearchMemoryRecall, ResearchMemoryRecallItem,
  ResearchThesis, ResearchThesisVersion, ThesisContent, UpdateResearchThesis, ResearchEvidenceGraph, ResearchEvidenceRecord } from '@shared/research-memory.interface';
import { canonicalMemorySymbol, normalizedTopic, rankMemoryRecall } from './research-memory.rules';
import { memoryIdSchema, memoryPreferencesSchema, memoryQuerySchema, memoryUpdateSchema,
  thesisCandidateSchema, thesisDeleteSchema, thesisUpdateSchema } from './research-memory.requests';
import { isUnverifiedCitation, normalizeThesisContent, thesisEvidenceIds, thesisFingerprint, validateThesisReferences } from './research-memory.theses';
import { acceptedWorkflowProvenance } from './research-memory.provenance';
import { loadMemorySources, type MemorySources } from './research-memory.loader';
import { archivalEligibility } from './research-memory.archive-authority';
import { lockMemoryOwner } from './research-memory.fence';
import { createThesisMonitors } from './research-memory.monitor.service';
import { recordReviewedReplacement } from './research-memory.dependencies';
import { researchMonitorEvents, researchMonitorRules, researchThesisReplacements } from '../../database/research-monitor.schema';
import { memoryReference } from './research-memory.context';
import { boundedMemoryPins, MEMORY_THESIS_WINDOW } from './research-memory.ranking';
import { compactEvidenceMetadata, evidenceVisibleAt, normalizeEvidenceMetadata, thesisFreshness } from './research-memory.temporal';
import { archiveEvidence, bindThesisEvidence, compareEvidenceRows, evidenceRelations, type EvidenceRow } from './research-memory.evidence';

export type MemoryDatabase = Pick<PostgresJsDatabase, 'select' | 'selectDistinctOn' | 'insert' | 'update' | 'delete' | 'transaction'>;
type MemoryRow = typeof researchMemories.$inferSelect;
type ThesisRow = typeof researchTheses.$inferSelect;
type ReportRow = typeof councilReports.$inferSelect;
const EMPTY_CONTENT: ThesisContent = { claim: '', supportingEvidence: [], opposingEvidence: [], assumptions: [], indicators: [], invalidationConditions: [] };
const DEFAULT_PREFERENCES: ResearchMemoryPreferences = { autoArchive: true, recallEnabled: true };

/** Bound retained candidates and each materialization batch, not the number of ineligible rows inspected. */
async function eligibleWindow<Row, Item>(limit: number, fetch: (offset: number) => Promise<Row[]>,
  materialize: (rows: Row[]) => Promise<Item[]>): Promise<Item[]> {
  const items: Item[] = [];
  for (let offset = 0; items.length < limit; offset += limit) {
    const rows = await fetch(offset);
    items.push(...await materialize(rows));
    if (rows.length < limit) break;
  }
  return items.slice(0, limit);
}

@Injectable()
export class ResearchMemoryService {
  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: MemoryDatabase, private readonly quotes: QuoteService) {}

  async getPreferences(owner: string): Promise<ResearchMemoryPreferences> {
    this.owner(owner);
    const [row] = await this.db.select().from(researchMemoryPreferences).where(eq(researchMemoryPreferences.owner, owner));
    return row ? { autoArchive: row.autoArchive, recallEnabled: row.recallEnabled } : { ...DEFAULT_PREFERENCES };
  }
  async updatePreferences(owner: string, input: ResearchMemoryPreferences): Promise<ResearchMemoryPreferences> {
    this.owner(owner);
    const parsed = memoryPreferencesSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException('MEMORY_INVALID_PREFERENCES');
    await this.db.transaction(async tx => {
      await lockMemoryOwner(tx, owner);
      await tx.update(researchMemoryPreferences).set(parsed.data).where(eq(researchMemoryPreferences.owner, owner));
    });
    return parsed.data;
  }

  async archiveReport(owner: string, input: ArchiveResearchReport): Promise<ResearchMemoryItem | null> {
    const id = await this.db.transaction(tx => this.archiveReportInTransaction(tx, owner, input));
    return id ? this.getMemory(owner, id) : null;
  }

  /** DB-only archival boundary. Callers must hold their job lease before entering. */
  async archiveReportInTransaction(tx: Pick<PostgresJsDatabase, 'select' | 'insert' | 'update'>, owner: string,
    input: ArchiveResearchReport, intent: 'automatic' | 'manual' = 'automatic'): Promise<string | null> {
    this.owner(owner);
    await lockMemoryOwner(tx, owner);
    const [preferences] = await tx.select().from(researchMemoryPreferences).where(eq(researchMemoryPreferences.owner, owner)).for('share');
    if (intent === 'automatic' && !preferences.autoArchive) return null;
    this.id(input.sessionId); this.id(input.report.id);
    const symbol = this.symbol(input);
    const [source] = await tx.select({ report: councilReports, session: councilSessions }).from(councilReports)
      .innerJoin(councilSessions, and(eq(councilReports.sessionId, councilSessions.id), eq(councilSessions.owner, owner)))
      .where(and(eq(councilReports.id, input.report.id), eq(councilReports.owner, owner),
        eq(councilReports.sessionId, input.sessionId), eq(councilReports.version, input.report.version))).limit(1).for('update');
    if (!source) throw new NotFoundException('MEMORY_SOURCE_NOT_FOUND');
    const eligible = await archivalEligibility(tx, owner, source.report, source.session);
    if (!eligible) throw new BadRequestException('MEMORY_SOURCE_NOT_COMPLETED');
    const sourceSymbol = this.symbol({ ticker: source.session.ticker });
    if (sourceSymbol.ticker !== symbol.ticker || sourceSymbol.market !== symbol.market
      || input.language !== source.session.language) throw new BadRequestException('MEMORY_SOURCE_MISMATCH');
    const report = source.report;
    const supplied = input.thesisCandidates !== undefined;
    const raw = supplied ? input.thesisCandidates! : report.thesisCandidates ?? [];
    if (!Array.isArray(raw) || raw.length > 5) throw new BadRequestException('MEMORY_TOO_MANY_CANDIDATES');
    const workflow = !supplied ? await acceptedWorkflowProvenance(tx, owner, source.session.id, report) : undefined;
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
    {
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
        await createThesisMonitors(tx, owner, thesis, created);
        if (status === 'accepted') await recordReviewedReplacement(tx, owner, thesis, created, report, workflow);
      }
      return created.id;
    }
  }

  async list(owner: string, input: ResearchMemoryQuery): Promise<ResearchMemoryList> {
    return this.listCandidates(owner, input);
  }
  private async listCandidates(owner: string, input: ResearchMemoryQuery, retrieval = false): Promise<ResearchMemoryList> {
    this.owner(owner);
    const parsed = memoryQuerySchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException('MEMORY_INVALID_QUERY');
    const symbol = this.symbol(parsed.data);
    const memoryQuery = this.db.select().from(researchMemories).where(and(eq(researchMemories.owner, owner),
      eq(researchMemories.ticker, symbol.ticker), eq(researchMemories.market, symbol.market), isNull(researchMemories.deletedAt),
      retrieval ? eq(researchMemories.excluded, false) : undefined,
      parsed.data.asOf ? lte(researchMemories.reportCreatedAt, new Date(parsed.data.asOf)) : undefined,
      parsed.data.asOf ? lte(researchMemories.createdAt, new Date(parsed.data.asOf)) : undefined))
      .orderBy(desc(researchMemories.reportCreatedAt), researchMemories.id).$dynamic();
    const rows = retrieval ? [] : await memoryQuery.limit(100);
    // Filter the latest version at the cutoff, not today's status or any older active version.
    const historical = parsed.data.asOf ? this.db.selectDistinctOn([researchThesisVersions.thesisId], {
      thesisId: researchThesisVersions.thesisId, status: researchThesisVersions.status, excluded: researchThesisVersions.excluded,
    }).from(researchThesisVersions).where(and(eq(researchThesisVersions.owner, owner),
      lte(researchThesisVersions.createdAt, new Date(parsed.data.asOf))))
      .orderBy(researchThesisVersions.thesisId, desc(researchThesisVersions.version)).as('historical_retrieval_status') : undefined;
    const thesisQuery = this.db.select({ thesis: researchTheses, memory: researchMemories }).from(researchTheses)
      .innerJoin(researchMemories, and(eq(researchMemories.id, researchTheses.memoryId), eq(researchMemories.owner, owner)))
      .where(and(eq(researchTheses.owner, owner), eq(researchMemories.ticker, symbol.ticker), eq(researchMemories.market, symbol.market),
        isNull(researchMemories.deletedAt), isNull(researchTheses.deletedAt),
        parsed.data.asOf ? lte(researchMemories.createdAt, new Date(parsed.data.asOf)) : undefined,
        parsed.data.asOf ? lte(researchMemories.reportCreatedAt, new Date(parsed.data.asOf)) : undefined,
        parsed.data.asOf ? lte(researchTheses.createdAt, new Date(parsed.data.asOf)) : undefined,
        retrieval ? eq(researchMemories.excluded, false) : undefined, retrieval ? eq(researchTheses.excluded, false) : undefined,
        retrieval ? historical ? inArray(researchTheses.id, this.db.select({ id: historical.thesisId }).from(historical)
          .where(and(inArray(historical.status, ['accepted', 'confirmed']), eq(historical.excluded, false))))
          : inArray(researchTheses.status, ['accepted', 'confirmed']) : undefined,
        retrieval || parsed.data.asOf ? undefined
          : or(inArray(researchTheses.memoryId, rows.map(row => row.id)), inArray(researchTheses.status, ['accepted', 'confirmed']))))
      .orderBy(desc(parsed.data.asOf ? researchTheses.createdAt : researchTheses.updatedAt), researchTheses.id).$dynamic();
    if (retrieval) {
      const memories = await eligibleWindow(100, offset => memoryQuery.limit(100).offset(offset), async batch =>
        (await this.materializeMemories(owner, batch, parsed.data.asOf)).filter(memory => !memory.excluded && Boolean(memory.source)));
      const theses = await eligibleWindow(MEMORY_THESIS_WINDOW, offset => thesisQuery.limit(MEMORY_THESIS_WINDOW).offset(offset), async batch => {
        const parents = [...new Map(batch.map(row => [row.memory.id, row.memory])).values()];
        const loaded = new Map((await this.materializeMemories(owner, parents, parsed.data.asOf)).map(memory => [memory.id, memory]));
        const versions = await this.thesesAt(owner, batch.map(row => row.thesis), parsed.data.asOf);
        return versions.map(row => this.materializeThesis(row, loaded.get(row.memoryId)!, parsed.data.asOf))
          .filter(thesis => this.recallableThesis(thesis));
      });
      return { memories, theses, preferences: await this.getPreferences(owner) };
    }
    const joined = await thesisQuery;
    const parents = [...new Map([...rows, ...joined.map(row => row.memory)].map(row => [row.id, row])).values()];
    const loaded = await this.materializeMemories(owner, parents, parsed.data.asOf);
    const byId = new Map(loaded.map(row => [row.id, row]));
    const memories = rows.map(row => byId.get(row.id)!).filter(memory => !parsed.data.asOf || !memory.excluded && memory.sourceStatus !== 'not-yet-known');
    const versions = await this.thesesAt(owner, joined.map(row => row.thesis), parsed.data.asOf);
    const theses = versions.flatMap(row => {
      const memory = byId.get(row.memoryId)!;
      if (parsed.data.asOf && (row.excluded || memory.excluded || memory.sourceStatus === 'not-yet-known')) return [];
      return [this.materializeThesis(row, memory, parsed.data.asOf)];
    });
    return { memories, theses, preferences: await this.getPreferences(owner) };
  }

  async getMemory(owner: string, id: string, asOf?: string): Promise<ResearchMemoryItem> {
    return this.materializeMemory(owner, await this.memoryRow(owner, id), asOf);
  }
  async updateMemory(owner: string, id: string, input: { excluded: boolean }): Promise<ResearchMemoryItem> {
    await this.memoryRow(owner, id);
    if (!memoryUpdateSchema.safeParse(input).success) throw new BadRequestException('MEMORY_INVALID_UPDATE');
    await this.db.transaction(async tx => {
      await lockMemoryOwner(tx, owner);
      await tx.update(researchMemories).set({ excluded: input.excluded })
        .where(and(eq(researchMemories.owner, owner), eq(researchMemories.id, id), isNull(researchMemories.deletedAt)));
    });
    return this.getMemory(owner, id);
  }
  async deleteMemory(owner: string, id: string): Promise<{ deleted: true }> {
    await this.memoryRow(owner, id);
    await this.db.transaction(async tx => {
      await lockMemoryOwner(tx, owner);
      // Lock/update children before deleting their versions: a concurrent editor cannot insert a new
      // version between the purge and tombstone. The source archive remains a non-resurrectable ID.
      const theses = await tx.update(researchTheses).set({ deletedAt: new Date(), excluded: true, content: EMPTY_CONTENT })
        .where(and(eq(researchTheses.owner, owner), eq(researchTheses.memoryId, id))).returning({ id: researchTheses.id });
      if (theses.length) await tx.delete(researchThesisVersions).where(and(eq(researchThesisVersions.owner, owner),
        inArray(researchThesisVersions.thesisId, theses.map(thesis => thesis.id))));
      if (theses.length) {
        await tx.delete(researchMonitorRules).where(and(eq(researchMonitorRules.owner, owner), inArray(researchMonitorRules.thesisId, theses.map(thesis => thesis.id))));
        await tx.delete(researchThesisReplacements).where(and(eq(researchThesisReplacements.owner, owner), inArray(researchThesisReplacements.thesisId, theses.map(thesis => thesis.id))));
      }
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
      await lockMemoryOwner(tx, owner);
      const [breach] = await tx.select({ id: researchMonitorEvents.id }).from(researchMonitorEvents).where(and(
        eq(researchMonitorEvents.owner, owner), eq(researchMonitorEvents.thesisId, id),
        eq(researchMonitorEvents.thesisVersion, current.version), eq(researchMonitorEvents.state, 'breached'))).limit(1);
      if (breach && (!['confirm', 'edit'].includes(input.action) || !parsed.data.changeReason)) {
        if (!['dismiss', 'expire', 'exclude'].includes(input.action)) throw new BadRequestException('MEMORY_BREACH_REVIEW_REASON_REQUIRED');
      }
      const [liveMemory] = await tx.select().from(researchMemories).where(and(eq(researchMemories.owner, owner), eq(researchMemories.id, memory.id))).for('share');
      const [liveSource] = await tx.select().from(councilReports).where(and(eq(councilReports.owner, owner), eq(councilReports.id, memory.reportId))).for('share');
      if (!liveMemory || liveMemory.deletedAt || !liveSource) throw new BadRequestException('MEMORY_SOURCE_REQUIRED');
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
      await createThesisMonitors(tx, owner, updated, memory);
      if (breach && !(parsed.data.changeReason && ['confirm', 'edit'].includes(input.action))) {
        const prior = await tx.select().from(researchMonitorEvents).where(and(eq(researchMonitorEvents.owner, owner),
          eq(researchMonitorEvents.thesisId, id), eq(researchMonitorEvents.thesisVersion, current.version), eq(researchMonitorEvents.state, 'breached')));
        for (const event of prior) await tx.insert(researchMonitorEvents).values({ owner, ruleId: event.ruleId, ruleVersion: event.ruleVersion,
          thesisId: id, thesisVersion: updated.version, state: 'breached', observation: event.observation,
          observationKey: `inherited:${event.id}` }).onConflictDoNothing();
      }
    });
    return this.getThesis(owner, id);
  }
  async deleteThesis(owner: string, id: string, expectedVersion: number): Promise<{ deleted: true }> {
    await this.thesisRow(owner, id);
    if (!thesisDeleteSchema.safeParse({ expectedVersion }).success) throw new BadRequestException('MEMORY_INVALID_VERSION');
    await this.db.transaction(async tx => {
      await lockMemoryOwner(tx, owner);
      const [removed] = await tx.update(researchTheses).set({ content: EMPTY_CONTENT, deletedAt: new Date(),
        excluded: true, version: expectedVersion + 1, updatedAt: new Date() }).where(and(eq(researchTheses.owner, owner),
        eq(researchTheses.id, id), eq(researchTheses.version, expectedVersion), isNull(researchTheses.deletedAt))).returning();
      if (!removed) throw new ConflictException('MEMORY_VERSION_CONFLICT');
      await tx.delete(researchThesisVersions).where(and(eq(researchThesisVersions.owner, owner), eq(researchThesisVersions.thesisId, id)));
      await tx.delete(researchMonitorRules).where(and(eq(researchMonitorRules.owner, owner), eq(researchMonitorRules.thesisId, id)));
      await tx.delete(researchThesisReplacements).where(and(eq(researchThesisReplacements.owner, owner), eq(researchThesisReplacements.thesisId, id)));
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

  /** Reuse the caller's connection when it already holds a session transaction. */
  async recallInTransaction(tx: MemoryDatabase, owner: string, query: ResearchMemoryQuery): Promise<ResearchMemoryRecall> {
    return new ResearchMemoryService(tx, this.quotes).recall(owner, query);
  }

  /** Serialize revocation with the last local handoff. The callback must not await remote work. */
  async withRecallHandoff(owner: string, frozen: ResearchMemoryRecall, query: ResearchMemoryQuery & { enabled?: boolean },
    prepared: MemoryReference[], handoff: () => Promise<void>, validate?: (tx: MemoryDatabase) => Promise<void>): Promise<void> {
    this.owner(owner);
    await this.db.transaction(async tx => {
      await lockMemoryOwner(tx, owner);
      await validate?.(tx);
      if (!prepared.length) return handoff();
      const pins = boundedMemoryPins(frozen.items).filter(item => prepared.some(ref =>
        ref.kind === item.kind && ref.id === item.id && ref.version === item.version));
      if (pins.length !== prepared.length) throw new Error('MEMORY_CONTEXT_CHANGED');
      const theses = await tx.select().from(researchTheses).where(and(eq(researchTheses.owner, owner),
        inArray(researchTheses.id, pins.filter(item => item.kind === 'thesis').map(item => item.id))));
      const parents = await tx.select().from(researchMemories).where(and(eq(researchMemories.owner, owner),
        inArray(researchMemories.id, [...pins.filter(item => item.kind === 'history').map(item => item.id), ...theses.map(item => item.memoryId)])));
      // Lock physical sources too: SQL deletion need not participate in the application owner fence.
      await tx.select({ id: councilSessions.id }).from(councilSessions).where(and(eq(councilSessions.owner, owner),
        inArray(councilSessions.id, parents.map(item => item.sessionId)))).orderBy(councilSessions.id).for('share');
      await tx.select({ id: councilReports.id }).from(councilReports).where(and(eq(councilReports.owner, owner),
        inArray(councilReports.id, parents.map(item => item.reportId)))).orderBy(councilReports.id).for('share');
      await tx.select({ id: researchMemories.id }).from(researchMemories).where(and(eq(researchMemories.owner, owner),
        inArray(researchMemories.id, parents.map(item => item.id)))).orderBy(researchMemories.id).for('share');
      await tx.select({ id: researchTheses.id }).from(researchTheses).where(and(eq(researchTheses.owner, owner),
        inArray(researchTheses.id, theses.map(item => item.id)))).orderBy(researchTheses.id).for('share');
      const current = await new ResearchMemoryService(tx, this.quotes).refreshRecall(owner, { ...frozen, items: pins }, query);
      if (prepared.some(ref => !current.items.some(item => item.kind === ref.kind && item.id === ref.id && item.version === ref.version))) {
        throw new Error('MEMORY_CONTEXT_CHANGED');
      }
      await handoff();
    });
  }

  async recall(owner: string, query: ResearchMemoryQuery & { enabled?: boolean }): Promise<ResearchMemoryRecall> {
    const { enabled, ...filters } = query;
    if (!memoryQuerySchema.safeParse(filters).success) throw new BadRequestException('MEMORY_INVALID_QUERY');
    const preferences = await this.getPreferences(owner);
    if (enabled === false || !preferences.recallEnabled) return { items: [], context: '', preferences, ...(query.asOf ? { asOf: query.asOf } : {}) };
    const listing = await this.listCandidates(owner, filters, true);
    const items: ResearchMemoryRecallItem[] = [];
    for (const memory of listing.memories) {
      if (!memory.excluded && memory.source) items.push(this.historyRecallItem(memory, query.asOf));
    }
    for (const thesis of listing.theses) {
      if (this.recallableThesis(thesis) && !listing.memories.find(memory => memory.id === thesis.memoryId)?.excluded) {
        items.push(this.thesisRecallItem(thesis, query.asOf));
      }
    }
    return { ...rankMemoryRecall(items, query.query ?? query.topic ?? '', preferences), ...(query.asOf ? { asOf: query.asOf } : {}) };
  }
  /** A checkpoint pins IDs/versions, never authority. Resolve owner and live source for every prompt. */
  async refreshRecall(owner: string, frozen: ResearchMemoryRecall, query?: ResearchMemoryQuery & { enabled?: boolean }): Promise<ResearchMemoryRecall> {
    const cutoff = query?.asOf ?? frozen.asOf;
    if (query && !memoryQuerySchema.safeParse((({ enabled: _enabled, ...filters }) => filters)({ ...query, asOf: cutoff })).success
      || cutoff && !memoryQuerySchema.shape.asOf.safeParse(cutoff).success) throw new BadRequestException('MEMORY_INVALID_QUERY');
    const preferences = await this.getPreferences(owner);
    const pins = boundedMemoryPins(frozen.items);
    const redundant = (frozen.omissions ?? []).filter(item => item.reason === 'redundant-history').slice(0, 200);
    const requested = [...new Map([...pins.map(memoryReference), ...redundant.map(memoryReference)]
      .map(ref => [`${ref.kind}:${ref.id}:${ref.version}`, ref])).values()].slice(0, 200);
    if (!preferences.recallEnabled || query?.enabled === false) return { items: [], context: '', preferences, requested,
      omissions: requested.map(item => ({ ...item, reason: 'disabled' })), ...(cutoff ? { asOf: cutoff } : {}) };
    const symbol = query ? this.symbol(query) : undefined;
    for (const pin of pins) this.id(pin.id);
    const thesisRows = await this.db.select().from(researchTheses).where(and(eq(researchTheses.owner, owner),
      inArray(researchTheses.id, pins.filter(item => item.kind === 'thesis').map(item => item.id)), isNull(researchTheses.deletedAt)));
    const parentIds = [...pins.filter(item => item.kind === 'history').map(item => item.id), ...thesisRows.map(row => row.memoryId)];
    const parentRows = await this.db.select().from(researchMemories).where(and(eq(researchMemories.owner, owner),
      inArray(researchMemories.id, parentIds), isNull(researchMemories.deletedAt)));
    const memories = new Map((await this.materializeMemories(owner, parentRows, cutoff)).map(row => [row.id, row]));
    const theses = new Map((await this.thesesAt(owner, thesisRows, cutoff)).flatMap(row => {
      const parent = memories.get(row.memoryId);
      return parent ? [[row.id, this.materializeThesis(row, parent, cutoff)] as const] : [];
    }));

    const items: ResearchMemoryRecallItem[] = [];
    const omissions: MemoryOmission[] = [];
    for (const item of pins) {
      let reason: MemoryOmission['reason'] = 'revoked', currentVersion: number | undefined;
      try {
        if (item.kind === 'history') {
          const memory = memories.get(item.id);
          if (!memory) throw new NotFoundException('MEMORY_NOT_FOUND');
          if (memory.source && !memory.excluded && (!symbol || memory.ticker === symbol.ticker && memory.market === symbol.market)) {
            if (memory.source.reportVersion === item.version) { items.push(this.historyRecallItem(memory, cutoff)); continue; }
            reason = 'version-changed'; currentVersion = memory.source.reportVersion;
          }
        } else if (item.kind === 'thesis') {
          const thesis = theses.get(item.id);
          if (!thesis) throw new NotFoundException('MEMORY_THESIS_NOT_FOUND');
          const memory = memories.get(thesis.memoryId)!;
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
    const ranked = rankMemoryRecall(items, query?.query ?? query?.topic ?? '', preferences);
    return { ...ranked, requested, omissions: [...omissions, ...redundant, ...(ranked.omissions ?? [])], ...(cutoff ? { asOf: cutoff } : {}) };
  }

  private owner(owner: string): void { if (!owner?.trim()) throw new UnauthorizedException('MEMORY_OWNER_REQUIRED'); }
  private id(id: string): void { if (!memoryIdSchema.safeParse(id).success) throw new BadRequestException('MEMORY_INVALID_ID'); }
  symbol(input: ResearchMemoryQuery) {
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
  private async materializeMemory(owner: string, row: MemoryRow, asOf = new Date().toISOString(), sources?: MemorySources): Promise<ResearchMemoryItem> {
    const loaded = sources ?? await this.loadSources(owner, [row]);
    const source = loaded.reports.get(row.id) ?? null;
    const records = loaded.evidence.get(row.id) ?? [];
    for (const record of records) record.metadata = normalizeEvidenceMetadata({
      ...source?.evidence.find(item => item.id === record.evidenceId), metadata: record.metadata });
    const known = row.createdAt.getTime() <= Date.parse(asOf) && row.reportCreatedAt.getTime() <= Date.parse(asOf)
      && source?.evidence.every(item => {
        const record = records.find(record => record.evidenceId === item.id);
        return evidenceVisibleAt(record?.metadata ?? normalizeEvidenceMetadata(item), (record?.ingestedAt ?? row.createdAt).toISOString(), asOf);
      });
    const report = known ? source : null;
    const comparisons = report && !row.excluded ? compareEvidenceRows(records, loaded.peers, asOf,
      ticker => { const symbol = this.symbol({ ticker }); return symbol.ticker === row.ticker && symbol.market === row.market; }) : [];
    const conflicts = new Set(comparisons.filter(item => item.kind === 'conflict').map(item => item.left));
    const citations: MemoryCitation[] = report?.evidence.map(evidence => {
      const record = records.find(record => record.evidenceId === evidence.id);
      return { evidenceId: evidence.id, title: evidence.title, sourceUrl: this.sourceUrl(evidence.sourceUrl),
        fetchedAt: evidence.fetchedAt, ...(record ? { recordId: record.id } : {}),
        metadata: compactEvidenceMetadata(record?.metadata ?? normalizeEvidenceMetadata(evidence)),
        ...(record && conflicts.has(record.id) ? { conflicting: true } : {}),
        ...(record ? { relatedEvidence: [...new Map(comparisons.filter(item => item.left === record.id
          && (item.kind === 'conflict' || item.kind === 'superseded')).map(item => [item.right, {
            recordId: item.right, kind: item.kind as 'conflict' | 'superseded' }])).values()].slice(0, 200) } : {}) };
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
      version: row.version, excluded: row.excluded || memory.excluded, expiresAt: row.expiresAt?.toISOString() ?? null,
      sourceStatus: memory.sourceStatus, source: memory.source, citations, flags,
      createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
  }
  private async thesisAt(owner: string, current: ThesisRow, asOf?: string): Promise<ThesisRow | null> {
    return (await this.thesesAt(owner, [current], asOf))[0] ?? null;
  }
  private async thesesAt(owner: string, current: ThesisRow[], asOf?: string): Promise<ThesisRow[]> {
    if (!asOf || !current.length) return current;
    const versions = await this.db.selectDistinctOn([researchThesisVersions.thesisId]).from(researchThesisVersions)
      .where(and(eq(researchThesisVersions.owner, owner), inArray(researchThesisVersions.thesisId, current.map(row => row.id)),
        lte(researchThesisVersions.createdAt, new Date(asOf))))
      .orderBy(researchThesisVersions.thesisId, desc(researchThesisVersions.version));
    const byId = new Map(versions.map(row => [row.thesisId, row]));
    return current.flatMap(row => {
      const version = byId.get(row.id);
      return version && row.createdAt.getTime() <= Date.parse(asOf) ? [{ ...row, version: version.version, content: version.content,
        status: version.status, excluded: row.excluded || version.excluded, expiresAt: version.expiresAt, updatedAt: version.createdAt }] : [];
    });
  }
  private loadSources(owner: string, rows: MemoryRow[]) {
    return loadMemorySources(this.db, owner, rows, (memory, ticker) => {
      const symbol = this.symbol({ ticker }); return symbol.ticker === memory.ticker && symbol.market === memory.market;
    });
  }
  private async materializeMemories(owner: string, rows: MemoryRow[], asOf?: string): Promise<ResearchMemoryItem[]> {
    const sources = await this.loadSources(owner, rows);
    return Promise.all(rows.map(row => this.materializeMemory(owner, row, asOf, sources)));
  }
  async evidenceGraph(owner: string, memoryId: string): Promise<ResearchEvidenceGraph> {
    const row = await this.memoryRow(owner, memoryId), asOf = new Date().toISOString();
    const loaded = await this.loadSources(owner, [row]);
    const memory = await this.materializeMemory(owner, row, asOf, loaded);
    if (!memory.source || memory.excluded) return { evidence: [], relations: [], comparisons: [] };
    const records = loaded.evidence.get(row.id) ?? [];
    const allComparisons = compareEvidenceRows(records, loaded.peers, asOf,
      ticker => { const symbol = this.symbol({ ticker }); return symbol.ticker === row.ticker && symbol.market === row.market; });
    // Keep the dossier response bounded without changing the complete comparison used by recall and execution gates.
    const comparisons = allComparisons.slice(0, 200);
    const referenced = new Set(comparisons.flatMap(comparison => [comparison.left, comparison.right]));
    const localIds = new Set(records.map(record => record.id));
    const project = (record: EvidenceRow, parent: MemoryRow, evidence: ReportRow['evidence']): ResearchEvidenceRecord => {
      const citation = evidence.find(item => item.id === record.evidenceId);
      const { owner: _owner, ingestedAt, ...stored } = record;
      return { ...stored, metadata: normalizeEvidenceMetadata({ ...citation, metadata: record.metadata }),
        ingestedAt: ingestedAt.toISOString(), title: citation?.title, source: {
          sessionId: parent.sessionId, reportId: record.reportId, reportVersion: record.reportVersion, reportRevision: record.reportRevision,
          reportCreatedAt: parent.reportCreatedAt.toISOString(),
          url: `/council?sessionId=${parent.sessionId}&reportId=${record.reportId}#report-${record.reportId}-v${record.reportVersion}` } };
    };
    const comparisonEvidence = loaded.peers.filter(peer => referenced.has(peer.evidence.id) && !localIds.has(peer.evidence.id))
      .map(peer => project(peer.evidence, peer.memory, peer.reportEvidence));
    return { evidence: records.map(record => project(record, row, loaded.reports.get(row.id)!.evidence)), comparisonEvidence,
      relations: await evidenceRelations(this.db, owner, records), comparisons, comparisonsTruncated: allComparisons.length > comparisons.length };
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
      horizon, boundaryOrigin, evidenceRelations, provenance, monitorConditions, supersedes } = thesis;
    const content: ThesisContent = { claim, supportingEvidence, opposingEvidence, assumptions, indicators, invalidationConditions,
      ...(horizon ? { horizon } : {}), boundaryOrigin, evidenceRelations, provenance,
      ...(monitorConditions ? { monitorConditions } : {}), ...(supersedes ? { supersedes } : {}) };
    return { kind: 'thesis', id: thesis.id, memoryId: thesis.memoryId, version: thesis.version, topic: thesis.topic,
      summary: [thesis.claim, ...thesis.opposingEvidence.map(line => `Opposing: ${line}`),
        ...thesis.assumptions.map(line => `Assumption: ${line}`), ...thesis.indicators.map(line => `Indicator: ${line}`),
        ...thesis.invalidationConditions.map(line => `Invalidation: ${line}`)].join('\n'),
      flags: thesis.flags, source: thesis.source!, citations: thesis.citations, provenance: thesis.provenance,
      content, status: thesis.status, expiresAt: thesis.expiresAt, freshness: thesis.freshness, ...(asOf ? { asOf } : {}),
      endorsement: thesis.status === 'confirmed' ? 'user' : 'agent' };
  }
}
