import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, Optional, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { and, count, desc, eq, getTableColumns, ilike, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '../../common/platform';
import { dataLibrarySources as sources, dataLibraryVersions as versions, dataLibraryJobs as jobs } from '../../database/data-library.schema';
import type { DataLibrarySource, DataLibraryVersion, DataLibraryVersionSummary, DataLibrarySyncJob,
  DataLibrarySourceCreate, DataLibrarySourceUpdate, DataLibraryFileUpload, DataLibraryFormat, DataLibrarySourceKind,
  DataLibraryReference, DataLibrarySearchResult, DataLibrarySourceDetail, DataLibraryList, DataLibrarySyncResult } from '../../../shared/data-library.interface';
import { sourceCreate, sourceUpdate, sourceId, sourceList, fileUpload, searchRequest } from './data-library.requests';
import { authHeaders, decodeDataSecret, encodeDataSecret } from './data-library.secrets';
import { DataLibraryError, fetchLibraryUrl, publicSourceUrl } from './data-library.fetch';
import { extractDocument, type ExtractedDocument, MAX_FILE_BYTES, textDocument } from './data-library.extract';
import { DataBrowserService } from './data-browser.service';
import { BrowserSourceError } from './browser/browser-source.types';
import { DocumentJobsService } from './document-jobs.service';
import { ResearchDerivedCleanupService } from '../research-artifacts/research-derived-cleanup.service';
import { validateDocumentUpload } from './documents/document-client.interface';
type SourceRow = typeof sources.$inferSelect;
type VersionRow = typeof versions.$inferSelect;
type JobRow = typeof jobs.$inferSelect;
const sourceMetadataColumns = { ...getTableColumns(sources), fileData: sql<string | null>`NULL` };
const iso = (value: Date | null) => value?.toISOString() ?? null;
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const escaped = (text: string) => text.replace(/[\\%_]/gu, '\\$&');
type Transaction = Parameters<Parameters<PostgresJsDatabase['transaction']>[0]>[0];
interface Acquisition { acquisition: DataLibraryVersionSummary['acquisition']; finalUrl?: string; pageTitle?: string; observedAt?: string }
@Injectable()
export class DataLibraryService implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private ticking = false;
  private activeSyncs = new Map<string, number>();
  private activeBrowserSyncs = 0;
  private readonly pendingSyncs = new Map<string, AbortController>();
  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    @Optional() @Inject('DATA_LIBRARY_FETCH') private readonly fetchSource?: typeof fetchLibraryUrl,
    @Optional() private readonly browser?: DataBrowserService,
    @Optional() private readonly documentJobs?: DocumentJobsService,
    @Optional() private readonly derivedCleanup?: ResearchDerivedCleanupService) {}
  onModuleInit() {
    if (process.env.DATA_LIBRARY_SYNC_DISABLED === 'true') return;
    this.timer = setInterval(() => { void this.runDue().catch(() => undefined); }, 60_000); this.timer.unref();
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); for (const controller of this.pendingSyncs.values()) controller.abort(); }
  private owner(owner: string) { if (!owner?.trim()) throw new BadRequestException('OWNER_REQUIRED'); }
  private id(id: string) { if (!sourceId.safeParse(id).success) throw new BadRequestException('INVALID_SOURCE_ID'); }
  private async row(owner: string, id: string, includeFile = false): Promise<SourceRow> {
    this.owner(owner); this.id(id);
    const [row] = await this.db.select(includeFile ? getTableColumns(sources) : sourceMetadataColumns).from(sources)
      .where(and(eq(sources.owner, owner), eq(sources.id, id), isNull(sources.deletedAt)));
    if (!row) throw new NotFoundException('DATA_SOURCE_NOT_FOUND'); return row;
  }
  private view(row: SourceRow): DataLibrarySource {
    return { id: row.id, kind: row.kind as DataLibrarySourceKind, title: row.title, description: row.description,
      format: row.format as DataLibraryFormat, url: row.url, fileName: row.fileName, mimeType: row.mimeType,
      enabled: row.enabled, authKind: row.authKind as DataLibrarySource['authKind'], hasCredential: Boolean(row.secretEnc),
      captureMode: row.captureMode as DataLibrarySource['captureMode'], hasBrowserSession: Boolean(row.browserStateEnc), browserConnectedAt: iso(row.browserConnectedAt),
      needsReentry: Boolean(row.secretEnc && !decodeDataSecret(row.secretEnc)), syncIntervalMinutes: row.syncIntervalMinutes,
      nextSyncAt: iso(row.nextSyncAt), latestVersionId: row.latestVersionId, versionCount: row.versionCount,
      state: (!row.enabled ? 'paused' : row.state) as DataLibrarySource['state'], lastSuccessAt: iso(row.lastSuccessAt),
      lastErrorCode: row.lastErrorCode, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
  }
  private versionView(row: VersionRow): DataLibraryVersionSummary {
    return { id: row.id, sourceId: row.sourceId, version: row.version, contentHash: row.contentHash, byteLength: row.byteLength,
      observedAt: row.observedAt.toISOString(), extractionState: row.extractionState as 'ready' | 'needs-text', sectionCount: row.sections.length,
      acquisition: row.acquisition as DataLibraryVersionSummary['acquisition'], finalUrl: row.finalUrl, pageTitle: row.pageTitle };
  }
  private jobView(row: JobRow): DataLibrarySyncJob {
    return { id: row.id, sourceId: row.sourceId, state: row.state as DataLibrarySyncJob['state'],
      outcome: row.outcome as DataLibrarySyncJob['outcome'], versionId: row.versionId, errorCode: row.errorCode,
      startedAt: row.startedAt.toISOString(), finishedAt: iso(row.finishedAt) };
  }
  async list(owner: string, input: unknown = {}): Promise<DataLibraryList> {
    this.owner(owner); const parsed = sourceList.safeParse(input);
    if (!parsed.success) throw new BadRequestException('INVALID_SOURCE_QUERY');
    const q = { ...parsed.data, query: parsed.data.query ?? parsed.data.q };
    const term = q.query ? `%${escaped(q.query)}%` : undefined;
    const where = and(eq(sources.owner, owner), isNull(sources.deletedAt), q.kind ? eq(sources.kind, q.kind) : undefined,
      q.format ? eq(sources.format, q.format) : undefined, term ? or(ilike(sources.title, term), ilike(sources.description, term),
        inArray(sources.latestVersionId, this.db.select({ id: versions.id }).from(versions)
          .where(and(eq(versions.owner, owner), ilike(versions.extractedText, term))))) : undefined);
    const [rows, totals] = await Promise.all([this.db.select(sourceMetadataColumns).from(sources).where(where).orderBy(desc(sources.updatedAt), sources.id).limit(q.limit).offset(q.offset),
      this.db.select({ total: count() }).from(sources).where(where)]);
    return { items: rows.map(r => this.view(r)), total: totals[0].total, offset: q.offset, limit: q.limit };
  }
  async detail(owner: string, id: string): Promise<DataLibrarySourceDetail> {
    const row = await this.row(owner, id);
    const rows = await this.db.select({ id: versions.id, sourceId: versions.sourceId, version: versions.version,
      contentHash: versions.contentHash, byteLength: versions.byteLength, observedAt: versions.observedAt,
      acquisition: versions.acquisition, finalUrl: versions.finalUrl, pageTitle: versions.pageTitle,
      extractionState: versions.extractionState, sectionCount: sql<number>`jsonb_array_length(${versions.sections})` })
      .from(versions).where(and(eq(versions.owner, owner), eq(versions.sourceId, id))).orderBy(desc(versions.version)).limit(100);
    return { source: this.view(row), versions: rows.map(v => ({ ...v, observedAt: v.observedAt.toISOString(),
      extractionState: v.extractionState as 'ready' | 'needs-text', acquisition: v.acquisition as DataLibraryVersionSummary['acquisition'] })) };
  }
  async version(owner: string, id: string, versionId: string): Promise<DataLibraryVersion> {
    await this.row(owner, id); this.id(versionId);
    const [row] = await this.db.select().from(versions).where(and(eq(versions.owner, owner), eq(versions.sourceId, id), eq(versions.id, versionId)));
    if (!row) throw new NotFoundException('DATA_VERSION_NOT_FOUND');
    return { ...this.versionView(row), rawContent: row.rawContent, extractedText: row.extractedText, sections: row.sections };
  }
  private credential(input: DataLibrarySourceCreate | DataLibrarySourceUpdate, current?: SourceRow) {
    const kind = input.authKind ?? current?.authKind ?? 'none';
    if (kind === 'none' || 'clearCredential' in input && input.clearCredential) return { authKind: kind, secretEnc: null };
    const value = kind === 'basic' && input.username !== undefined && input.password !== undefined
      ? `${input.username}:${input.password}` : input.credential;
    if (value) return { authKind: kind, secretEnc: encodeDataSecret(value) };
    if (current?.authKind === kind && current.secretEnc) return { authKind: kind, secretEnc: current.secretEnc };
    throw new BadRequestException('CREDENTIAL_REQUIRED');
  }
  async create(owner: string, input: DataLibrarySourceCreate): Promise<DataLibrarySource> {
    this.owner(owner); const parsed = sourceCreate.safeParse(input);
    if (!parsed.success) throw new BadRequestException('INVALID_SOURCE');
    const p = parsed.data, website = p.kind === 'website';
    if (website && !p.url || !website && (!p.text?.trim() || p.url || p.authKind && p.authKind !== 'none' || p.captureMode === 'browser')) throw new BadRequestException('INVALID_SOURCE');
    const url = website ? (await publicSourceUrl(p.url!)).url.toString() : null;
    const captureMode = website ? p.captureMode ?? 'http' : 'http';
    const auth = website && captureMode === 'http' ? this.credential(p) : { authKind: 'none', secretEnc: null };
    const format = website ? captureMode === 'browser' ? 'html' : p.format ?? 'html' : 'text';
    const doc = !website ? await extractDocument('text', Buffer.from(p.text!)) : undefined;
    return this.db.transaction(async tx => {
      const [row] = await tx.insert(sources).values({ owner, kind: p.kind, title: p.title, description: p.description ?? '', format, url,
        ...auth, captureMode, enabled: p.enabled ?? true, syncIntervalMinutes: website ? p.syncIntervalMinutes ?? null : null,
        nextSyncAt: website && p.syncIntervalMinutes ? new Date(Date.now() + p.syncIntervalMinutes * 60_000) : null }).returning();
      if (doc) return this.view(await this.persistVersion(tx, row, doc, Buffer.byteLength(p.text!)));
      return this.view(row);
    });
  }
  async update(owner: string, id: string, input: DataLibrarySourceUpdate): Promise<DataLibrarySource> {
    const parsed = sourceUpdate.safeParse(input); if (!parsed.success) throw new BadRequestException('INVALID_SOURCE');
    const p = parsed.data; await this.row(owner, id);
    const result = await this.db.transaction(async tx => {
      const [current] = await tx.select().from(sources).where(and(eq(sources.owner, owner), eq(sources.id, id), isNull(sources.deletedAt))).for('update');
      if (!current) throw new NotFoundException('DATA_SOURCE_NOT_FOUND');
      if (p.text !== undefined && current.kind !== 'page') throw new BadRequestException('TEXT_UPDATE_REQUIRES_PAGE');
      if (current.kind !== 'website' && (p.authKind || p.credential || p.username || p.password || p.syncIntervalMinutes || p.captureMode === 'browser')) throw new BadRequestException('AUTH_REQUIRES_WEBSITE');
      const interval = p.syncIntervalMinutes !== undefined ? p.syncIntervalMinutes : current.syncIntervalMinutes;
      const enabled = p.enabled ?? current.enabled;
      const captureMode = p.captureMode ?? current.captureMode;
      const changedMode = captureMode !== current.captureMode;
      const [updated] = await tx.update(sources).set({ title: p.title ?? current.title, description: p.description ?? current.description,
        ...this.credential(p, current), enabled, syncIntervalMinutes: interval, captureMode,
        ...(captureMode === 'browser' ? { format: 'html' } : {}),
        ...(changedMode ? { browserStateEnc: null, browserConnectedAt: null } : {}),
        nextSyncAt: enabled && interval ? new Date(Date.now() + interval * 60_000) : null,
        revision: current.revision + 1, state: current.kind === 'image' ? 'needs-text' : current.latestVersionId ? 'ready' : 'pending',
        leaseUntil: null, leaseToken: null, activeJobId: null, updatedAt: new Date(),
      }).where(eq(sources.id, id)).returning();
      await tx.update(jobs).set({ state: 'cancelled', errorCode: 'SOURCE_CHANGED', finishedAt: new Date() })
        .where(and(eq(jobs.owner, owner), eq(jobs.sourceId, id), eq(jobs.state, 'running')));
      if (p.text !== undefined) return this.view(await this.persistVersion(tx, updated, await extractDocument('text', Buffer.from(p.text)), Buffer.byteLength(p.text)));
      if (current.kind === 'image' && p.description !== undefined) {
        return this.view(await this.persistVersion(tx, updated, await extractDocument('image', Buffer.alloc(0), p.description),
          Buffer.byteLength(current.fileData ?? '', 'base64')));
      }
      return this.view(updated);
    });
    await this.cancelSync(owner, id);
    return result;
  }
  private async persistVersion(tx: Transaction, row: SourceRow, doc: ExtractedDocument, bytes: number,
    acquisition: Acquisition = { acquisition: 'document' }): Promise<SourceRow> {
    const digest = hash(JSON.stringify(acquisition.acquisition === 'browser-rendered'
      ? [doc.text, doc.sections, doc.state, acquisition.acquisition, acquisition.finalUrl ?? null, acquisition.pageTitle ?? null]
      : [doc.text, doc.sections, doc.state]));
    const [previous] = row.latestVersionId ? await tx.select().from(versions).where(and(eq(versions.owner, row.owner), eq(versions.id, row.latestVersionId))) : [];
    let versionId = row.latestVersionId, versionCount = row.versionCount;
    if (!previous || previous.contentHash !== digest) {
      const [version] = await tx.insert(versions).values({ owner: row.owner, sourceId: row.id, version: row.versionCount + 1,
        contentHash: digest, rawContent: doc.rawContent, extractedText: doc.text, sections: doc.sections,
        extractionState: doc.state, byteLength: bytes, acquisition: acquisition.acquisition, finalUrl: acquisition.finalUrl ?? null,
        pageTitle: acquisition.pageTitle ?? null, ...(acquisition.observedAt ? { observedAt: new Date(acquisition.observedAt) } : {}) }).returning();
      versionId = version.id; versionCount++;
    }
    const [updated] = await tx.update(sources).set({ latestVersionId: versionId, versionCount, state: doc.state,
      lastSuccessAt: new Date(), lastErrorCode: null, updatedAt: new Date() }).where(eq(sources.id, row.id)).returning();
    return updated;
  }
  async upload(owner: string, input: DataLibraryFileUpload): Promise<DataLibrarySource> {
    this.owner(owner); const parsed = fileUpload.safeParse(input); if (!parsed.success) throw new BadRequestException('INVALID_FILE');
    const p = parsed.data;
    if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(p.data) || p.data.length % 4) throw new BadRequestException('INVALID_FILE');
    const buffer = Buffer.from(p.data, 'base64');
    if (!buffer.length || buffer.length > MAX_FILE_BYTES || buffer.toString('base64') !== p.data) throw new BadRequestException('INVALID_FILE');
    const name = p.fileName.replace(/^.*[\\/]/u, '').replace(/[\u0000-\u001f]/gu, '');
    const ext = name.split('.').pop()?.toLowerCase();
    let format: DataLibraryFormat, kind: DataLibrarySourceKind, mime: string;
    if (ext === 'pptx') { format = 'pptx'; kind = 'slides'; mime = 'application/vnd.openxmlformats-officedocument.presentationml.presentation'; }
    else if (ext === 'pdf' || ext === 'docx') {
      format = ext; kind = 'file'; mime = ext === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
      validateDocumentUpload({ fileName: name, data: buffer, mime: ext === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
    } else if (['png', 'jpg', 'jpeg', 'webp'].includes(ext ?? '')) {
      format = 'image'; kind = 'image';
      const png = buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      const jpg = buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255;
      const webp = buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP';
      if (!png && !jpg && !webp) throw new BadRequestException('INVALID_IMAGE'); mime = png ? 'image/png' : jpg ? 'image/jpeg' : 'image/webp';
    } else if (['txt', 'md', 'html', 'htm', 'json', 'xml', 'rss'].includes(ext ?? '')) {
      format = ext === 'html' || ext === 'htm' ? 'html' : ext === 'json' ? 'json' : ext === 'rss' || ext === 'xml' ? 'rss' : 'text';
      kind = 'file'; mime = 'text/plain; charset=utf-8';
    } else throw new BadRequestException('UNSUPPORTED_FILE_TYPE');
    const doc = await extractDocument(format, buffer, p.description);
    const saved = await this.db.transaction(async tx => {
      const [row] = await tx.insert(sources).values({ owner, kind, format, title: p.title, description: p.description ?? '', fileName: name,
        mimeType: mime, fileData: p.data }).returning();
      return this.view(await this.persistVersion(tx, row, doc, buffer.length));
    });
    if (format === 'pdf' || format === 'docx') {
      const extractor = this.documentJobs?.available()[0];
      if (extractor) {
        try { await this.documentJobs!.start(owner, saved.id, extractor.id, 'document-default-v1'); }
        catch { await this.db.update(sources).set({ lastErrorCode: 'DOCUMENT_SUBMISSION_UNAVAILABLE' }).where(eq(sources.id, saved.id)); }
        return this.view(await this.row(owner, saved.id));
      }
      await this.db.update(sources).set({ lastErrorCode: 'DOCUMENT_EXTRACTOR_UNAVAILABLE' }).where(eq(sources.id, saved.id));
      return { ...saved, lastErrorCode: 'DOCUMENT_EXTRACTOR_UNAVAILABLE' };
    }
    return saved;
  }
  async file(owner: string, id: string) {
    const row = await this.row(owner, id, true); if (!row.fileData) throw new NotFoundException('DATA_FILE_NOT_FOUND');
    return { data: Buffer.from(row.fileData, 'base64'), mimeType: row.mimeType!, fileName: row.fileName!, image: row.kind === 'image' };
  }
  async remove(owner: string, id: string): Promise<{ deleted: true }> {
    await this.row(owner, id);
    await this.db.transaction(async tx => {
      await tx.update(sources).set({ deletedAt: new Date(), enabled: false, secretEnc: null, browserStateEnc: null, browserConnectedAt: null,
        fileData: null, latestVersionId: null, title: '', description: '', url: null, nextSyncAt: null, leaseUntil: null,
        leaseToken: null, activeJobId: null, revision: sql`${sources.revision} + 1` })
        .where(and(eq(sources.owner, owner), eq(sources.id, id)));
      await tx.delete(versions).where(and(eq(versions.owner, owner), eq(versions.sourceId, id)));
      await tx.update(jobs).set({ state: 'cancelled', errorCode: 'SOURCE_DELETED', finishedAt: new Date() })
        .where(and(eq(jobs.owner, owner), eq(jobs.sourceId, id), eq(jobs.state, 'running')));
    });
    await this.cancelSync(owner, id);
    await this.derivedCleanup?.purgeSource(owner, id);
    return { deleted: true };
  }
  private async cancelSync(owner: string, id: string) {
    for (const [key, controller] of this.pendingSyncs) if (key.startsWith(`${owner}:${id}:`)) controller.abort();
    await this.browser?.cancel(owner, id);
    await this.documentJobs?.cancelSource(owner, id);
  }
  async sync(owner: string, id: string, options: { signal?: AbortSignal } = {}): Promise<DataLibrarySyncResult> {
    this.owner(owner);
    const requested = await this.row(owner, id), browserMode = requested.captureMode === 'browser';
    const active = this.activeSyncs.get(owner) ?? 0;
    const total = [...this.activeSyncs.values()].reduce((sum, n) => sum + n, 0);
    if (active >= 2 || total >= 16 || browserMode && this.activeBrowserSyncs >= 2) throw new ConflictException('SYNC_CAPACITY_REACHED');
    this.activeSyncs.set(owner, active + 1);
    if (browserMode) this.activeBrowserSyncs++;
    try { return await this.syncOne(owner, id, options.signal, requested.captureMode); }
    finally { const remaining = (this.activeSyncs.get(owner) ?? 1) - 1;
      if (browserMode) this.activeBrowserSyncs--;
      if (remaining) this.activeSyncs.set(owner, remaining); else this.activeSyncs.delete(owner); }
  }
  private async syncOne(owner: string, id: string, signal?: AbortSignal, requestedMode?: string): Promise<DataLibrarySyncResult> {
    await this.row(owner, id);
    const { row, job } = await this.db.transaction(async tx => {
      const [current] = await tx.select().from(sources).where(and(eq(sources.owner, owner), eq(sources.id, id), isNull(sources.deletedAt))).for('update');
      if (!current) throw new NotFoundException('DATA_SOURCE_NOT_FOUND');
      if (current.kind !== 'website' || !current.enabled) throw new BadRequestException('SOURCE_NOT_SYNCABLE');
      if (requestedMode !== current.captureMode) throw new ConflictException('SOURCE_CHANGED');
      if (current.leaseUntil && current.leaseUntil > new Date()) throw new ConflictException('SYNC_ALREADY_RUNNING');
      await tx.update(jobs).set({ state: 'failed', errorCode: 'SYNC_INTERRUPTED', finishedAt: new Date() })
        .where(and(eq(jobs.owner, owner), eq(jobs.sourceId, id), eq(jobs.state, 'running')));
      const leaseToken = randomUUID();
      const [created] = await tx.insert(jobs).values({ owner, sourceId: id, state: 'running', leaseToken }).returning();
      await tx.update(sources).set({ state: 'syncing', leaseUntil: new Date(Date.now() + 90_000), leaseToken, activeJobId: created.id }).where(eq(sources.id, id));
      return { row: current, job: created };
    });
    const controller = new AbortController(), pendingKey = `${owner}:${id}:${job.id}`;
    const abort = () => controller.abort();
    if (signal?.aborted) controller.abort(); else signal?.addEventListener('abort', abort, { once: true });
    this.pendingSyncs.set(pendingKey, controller);
    let doc: ExtractedDocument | undefined, bytes = 0, errorCode: string | undefined;
    let refreshedBrowserStateEnc: string | undefined;
    let acquisition: Acquisition = { acquisition: 'http' };
    try {
      if (controller.signal.aborted) throw new DataLibraryError('CANCELLED');
      if (row.captureMode === 'browser') {
        if (!this.browser) throw new DataLibraryError('UNAVAILABLE');
        const snapshot = await this.browser.read(owner, row, controller.signal);
        doc = textDocument(snapshot.text); bytes = Buffer.byteLength(snapshot.text);
        acquisition = { acquisition: snapshot.provenance, finalUrl: snapshot.url, pageTitle: snapshot.title, observedAt: snapshot.observedAt };
        refreshedBrowserStateEnc = snapshot.refreshedStateEnc;
      } else {
        const credential = decodeDataSecret(row.secretEnc);
        if (row.authKind !== 'none' && !credential) throw new DataLibraryError('CREDENTIAL_UNREADABLE');
        const response = await (this.fetchSource ?? fetchLibraryUrl)(row.url!, authHeaders(row.authKind as DataLibrarySource['authKind'], credential));
        acquisition = { acquisition: 'http', finalUrl: response.url };
        if (/\/(?:login|signin|sign-in)(?:[/?]|$)/iu.test(new URL(response.url).pathname)) throw new DataLibraryError('NEEDS_AUTH');
        doc = await extractDocument(row.format as DataLibraryFormat, response.body); bytes = response.body.length;
        if (!doc.text.trim()) throw new DataLibraryError('NO_CONTENT');
        if (credential) {
          // Defensive removal if a provider reflects the exact credential in its visible response.
          const fragments = [credential, ...(row.authKind === 'cookie' ? credential.split(';').map(cookie => cookie.slice(cookie.indexOf('=') + 1).trim())
            : row.authKind === 'basic' ? [credential.slice(credential.indexOf(':') + 1), Buffer.from(credential).toString('base64')] : [])]
            .filter(value => value.length >= 4).sort((a, b) => b.length - a.length);
          const safe = (text: string) => fragments.reduce((value, secret) => value.split(secret).join('[redacted]'), text);
          doc = { ...doc, rawContent: safe(doc.rawContent), text: safe(doc.text), sections: doc.sections.map(s => ({ ...s, text: safe(s.text) })) };
        }
      }
      if (controller.signal.aborted) throw new DataLibraryError('CANCELLED');
      if (!doc.text.trim()) throw new DataLibraryError('NO_CONTENT');
    } catch (e) { errorCode = e instanceof DataLibraryError || e instanceof BrowserSourceError ? e.code : 'SYNC_FAILED'; }
    const cancelledDuringCommit = new BrowserSourceError('CANCELLED');
    const result = await this.db.transaction(async tx => {
      const [current] = await tx.select().from(sources).where(and(eq(sources.owner, owner), eq(sources.id, id))).for('update');
      if (!current || current.deletedAt || current.revision !== row.revision || !current.enabled
        || current.activeJobId !== job.id || current.leaseToken !== job.leaseToken || current.captureMode !== row.captureMode) {
        const [saved] = await tx.select().from(jobs).where(eq(jobs.id, job.id));
        if (saved.state !== 'running') return { row: current, job: saved };
        const [cancelled] = await tx.update(jobs).set({ state: 'cancelled', errorCode: 'SOURCE_CHANGED', finishedAt: new Date() })
          .where(eq(jobs.id, job.id)).returning();
        return { row: current, job: cancelled };
      }
      if (!current.leaseUntil || current.leaseUntil <= new Date()) errorCode = 'SYNC_LEASE_EXPIRED';
      if (controller.signal.aborted) errorCode = 'CANCELLED';
      let updated = current;
      if (doc && !errorCode) updated = await this.persistVersion(tx, current, doc, bytes, acquisition);
      const authFailed = errorCode === 'NEEDS_AUTH' || errorCode === 'CREDENTIAL_UNREADABLE';
      const [finishedSource] = await tx.update(sources).set({ leaseUntil: null, leaseToken: null, activeJobId: null,
        ...(doc && !errorCode && row.browserStateEnc && current.browserStateEnc && refreshedBrowserStateEnc
          ? { browserStateEnc: refreshedBrowserStateEnc } : {}),
        state: errorCode ? authFailed ? 'needs-auth' : 'failed' : updated.state,
        lastErrorCode: errorCode ?? null, updatedAt: new Date(), nextSyncAt: !authFailed && current.syncIntervalMinutes
          ? new Date(Date.now() + current.syncIntervalMinutes * 60_000) : null }).where(eq(sources.id, id)).returning();
      const [finished] = await tx.update(jobs).set({ state: errorCode === 'CANCELLED' ? 'cancelled' : errorCode ? 'failed' : 'succeeded',
        outcome: errorCode ? null : updated.versionCount > current.versionCount ? 'updated' : 'unchanged',
        versionId: errorCode ? null : updated.latestVersionId, errorCode: errorCode ?? null, finishedAt: new Date() }).where(eq(jobs.id, job.id)).returning();
      // Abort can arrive during any awaited database write. Roll back the whole capture before settling cancellation.
      if (!errorCode && controller.signal.aborted) throw cancelledDuringCommit;
      return { row: finishedSource, job: finished };
    }).catch(async error => {
      if (error !== cancelledDuringCommit) throw error;
      return this.db.transaction(async tx => {
        const [current] = await tx.select().from(sources).where(and(eq(sources.owner, owner), eq(sources.id, id))).for('update');
        let settledSource = current;
        if (current && !current.deletedAt && current.revision === row.revision && current.enabled
          && current.activeJobId === job.id && current.leaseToken === job.leaseToken && current.captureMode === row.captureMode) {
          [settledSource] = await tx.update(sources).set({ leaseUntil: null, leaseToken: null, activeJobId: null,
            state: 'failed', lastErrorCode: 'CANCELLED', updatedAt: new Date(),
            nextSyncAt: current.syncIntervalMinutes ? new Date(Date.now() + current.syncIntervalMinutes * 60_000) : null,
          }).where(eq(sources.id, id)).returning();
        }
        const [saved] = await tx.select().from(jobs).where(eq(jobs.id, job.id));
        let settledJob = saved;
        if (saved.state === 'running') {
          [settledJob] = await tx.update(jobs).set({ state: 'cancelled', errorCode: 'CANCELLED', finishedAt: new Date() })
            .where(eq(jobs.id, job.id)).returning();
        }
        return { row: settledSource, job: settledJob };
      });
    }).finally(() => { signal?.removeEventListener('abort', abort); this.pendingSyncs.delete(pendingKey); });
    if (!result.row || result.row.deletedAt) throw new NotFoundException('DATA_SOURCE_NOT_FOUND');
    return { source: this.view(result.row), job: this.jobView(result.job) };
  }
  async listJobs(owner: string, input: { sourceId?: string; offset?: number; limit?: number } = {}) {
    this.owner(owner); if (input.sourceId) await this.row(owner, input.sourceId);
    const offset = Math.max(0, Math.min(Number(input.offset) || 0, 100_000)), limit = Math.max(1, Math.min(Number(input.limit) || 50, 100));
    const where = and(eq(jobs.owner, owner), input.sourceId ? eq(jobs.sourceId, input.sourceId) : undefined,
      inArray(jobs.sourceId, this.db.select({ id: sources.id }).from(sources).where(and(eq(sources.owner, owner), isNull(sources.deletedAt)))));
    const [rows, totals] = await Promise.all([this.db.select().from(jobs).where(where).orderBy(desc(jobs.startedAt)).limit(limit).offset(offset),
      this.db.select({ total: count() }).from(jobs).where(where)]);
    return { items: rows.map(j => this.jobView(j)), total: totals[0].total };
  }
  async runDue(): Promise<void> {
    if (this.ticking) return; this.ticking = true;
    try {
      const due = await this.db.select({ id: sources.id, owner: sources.owner }).from(sources).where(and(isNull(sources.deletedAt),
        eq(sources.enabled, true), lte(sources.nextSyncAt, new Date()), or(isNull(sources.leaseUntil), lte(sources.leaseUntil, new Date())))).limit(5);
      for (const row of due) { try { await this.sync(row.owner, row.id); } catch { /* Another worker or an edit won the lease. */ } }
    } finally { this.ticking = false; }
  }
  async search(owner: string, input: { query: string; limit?: number; sourceIds?: string[] }): Promise<DataLibrarySearchResult> {
    this.owner(owner); const parsed = searchRequest.safeParse(input); if (!parsed.success) throw new BadRequestException('INVALID_LIBRARY_SEARCH');
    const q = parsed.data, term = `%${escaped(q.query)}%`;
    const match = or(sql`to_tsvector('simple', ${versions.extractedText}) @@ plainto_tsquery('simple', ${q.query})`,
      ilike(versions.extractedText, term), ilike(sources.title, term), ilike(sources.description, term));
    const rows = await this.db.select({ source: sourceMetadataColumns, version: versions }).from(sources).innerJoin(versions,
      and(eq(versions.id, sources.latestVersionId), eq(versions.owner, owner)))
      .where(and(eq(sources.owner, owner), isNull(sources.deletedAt), eq(sources.enabled, true), match,
        q.sourceIds ? inArray(sources.id, q.sourceIds) : undefined)).orderBy(desc(versions.observedAt), sources.id).limit(q.limit + 1);
    const items = rows.slice(0, q.limit).map(({ source, version }) => {
      const section = version.sections.find(s => s.text.toLocaleLowerCase().includes(q.query.toLocaleLowerCase())) ?? version.sections[0];
      return { sourceId: source.id, versionId: version.id, title: source.title, kind: source.kind as DataLibrarySourceKind,
        ...(source.url ? { sourceUrl: source.url } : {}), ...(source.fileName ? { fileName: source.fileName } : {}),
        locator: section?.locator ?? 'document', excerpt: (section?.text ?? version.extractedText).slice(0, 1200),
        observedAt: version.observedAt.toISOString(), validity: 'current' as const };
    });
    return { items, asOf: new Date().toISOString(), truncated: rows.length > q.limit };
  }
  async validateReferences(owner: string, refs: DataLibraryReference[]): Promise<boolean> {
    this.owner(owner); if (refs.length > 30 || refs.some(r => !sourceId.safeParse(r.sourceId).success || !sourceId.safeParse(r.versionId).success)) return false;
    if (!refs.length) return true;
    const rows = await this.db.select({ sourceId: sources.id, versionId: versions.id }).from(sources).innerJoin(versions,
      and(eq(versions.sourceId, sources.id), eq(versions.owner, owner)))
      .where(and(eq(sources.owner, owner), isNull(sources.deletedAt), eq(sources.enabled, true), inArray(versions.id, refs.map(r => r.versionId))));
    return refs.every(r => rows.some(row => row.sourceId === r.sourceId && row.versionId === r.versionId));
  }
}
