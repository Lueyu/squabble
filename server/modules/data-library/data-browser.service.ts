import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, Optional, type OnModuleDestroy } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '../../common/platform';
import { dataLibrarySources as sources, dataLibraryJobs as jobs } from '../../database/data-library.schema';
import type { DataBrowserStatus } from '../../../shared/data-library.interface';
import { sourceId } from './data-library.requests';
import { decodeDataSecret, encodeDataSecret } from './data-library.secrets';
import { BrowserSourceRuntime } from './browser/browser-source.runtime';
import { redactBrowserSessionValues } from './browser/browser-content';
import { BrowserSourceError, type BrowserSourceKey, type BrowserSourceReadResult, type BrowserSourceRuntimePort } from './browser/browser-source.types';

type SourceRow = typeof sources.$inferSelect;
interface BrowserCapture extends Omit<BrowserSourceReadResult, 'refreshedStorageState'> {
  /** Internal only. The library may commit this inside its successful capture transaction. */
  refreshedStateEnc?: string;
}
/** Owns encrypted browser sessions; raw state never crosses the runtime boundary. */
@Injectable()
export class DataBrowserService implements OnModuleDestroy {
  private readonly runtime: BrowserSourceRuntimePort;
  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    @Optional() @Inject('DATA_BROWSER_RUNTIME') runtime?: BrowserSourceRuntimePort) {
    this.runtime = runtime ?? new BrowserSourceRuntime();
  }
  onModuleDestroy() { return this.runtime.shutdown(); }
  private key(owner: string, id: string): BrowserSourceKey {
    if (!owner?.trim()) throw new BadRequestException('OWNER_REQUIRED');
    if (!sourceId.safeParse(id).success) throw new BadRequestException('INVALID_SOURCE_ID');
    return { ownerId: owner, sourceId: id };
  }
  private async row(owner: string, id: string): Promise<SourceRow> {
    this.key(owner, id);
    const [row] = await this.db.select().from(sources).where(and(eq(sources.owner, owner), eq(sources.id, id), isNull(sources.deletedAt)));
    if (!row) throw new NotFoundException('DATA_SOURCE_NOT_FOUND');
    return row;
  }
  private syncable(row: SourceRow) {
    if (row.kind !== 'website' || row.captureMode !== 'browser' || !row.enabled || !row.url) {
      throw new BadRequestException('BROWSER_SOURCE_REQUIRED');
    }
  }
  private interactiveLocalOnly() {
    const host = process.env.SERVER_HOST || process.env.HOST || '127.0.0.1';
    if (process.env.AUTH_MODE !== 'local' || !['127.0.0.1', '::1', 'localhost'].includes(host) || process.env.TRUST_PROXY === 'true') {
      throw new BadRequestException('BROWSER_LOGIN_LOCAL_ONLY');
    }
  }
  async status(owner: string, id: string): Promise<DataBrowserStatus> {
    const row = await this.row(owner, id), availability = await this.runtime.availability();
    const loginWindowOpen = this.runtime.loginWindowOpen(this.key(owner, id));
    const unavailable = !availability.available;
    const needsLogin = row.state === 'needs-auth' || Boolean(row.browserStateEnc && !decodeDataSecret(row.browserStateEnc));
    return { available: availability.available, canOpenInteractive: availability.canOpenInteractive,
      state: unavailable ? 'unavailable' : loginWindowOpen ? 'login-open'
        : needsLogin ? 'needs-login' : row.browserStateEnc ? 'connected' : 'not-connected',
      ...(availability.reason ? { reason: availability.reason } : {}), connectedAt: row.browserConnectedAt?.toISOString() ?? null, loginWindowOpen };
  }
  async open(owner: string, id: string): Promise<DataBrowserStatus> {
    const row = await this.row(owner, id); this.syncable(row);
    this.interactiveLocalOnly();
    const availability = await this.runtime.availability();
    if (!availability.available || !availability.canOpenInteractive) throw new BadRequestException(availability.reason ?? 'BROWSER_LOGIN_UNAVAILABLE');
    await this.runtime.open(this.key(owner, id), row.url!, decodeDataSecret(row.browserStateEnc) ?? undefined);
    const current = await this.row(owner, id).catch(() => null);
    if (!current || !current.enabled || current.captureMode !== 'browser' || current.revision !== row.revision) {
      await this.cancel(owner, id); throw new ConflictException('SOURCE_CHANGED');
    }
    return this.status(owner, id);
  }
  async confirm(owner: string, id: string): Promise<DataBrowserStatus> {
    const row = await this.row(owner, id); this.syncable(row);
    this.interactiveLocalOnly();
    const availability = await this.runtime.availability();
    if (!availability.canOpenInteractive) throw new BadRequestException('BROWSER_LOGIN_UNAVAILABLE');
    const captured = await this.runtime.confirm(this.key(owner, id));
    const encrypted = encodeDataSecret(captured.storageState);
    try {
      await this.db.transaction(async tx => {
        const [current] = await tx.select().from(sources).where(and(eq(sources.owner, owner), eq(sources.id, id), isNull(sources.deletedAt))).for('update');
        if (!current || current.revision !== row.revision || !current.enabled || current.captureMode !== 'browser') throw new ConflictException('SOURCE_CHANGED');
        await tx.update(sources).set({ browserStateEnc: encrypted, browserConnectedAt: new Date(), revision: current.revision + 1,
          leaseUntil: null, leaseToken: null, activeJobId: null, state: current.latestVersionId ? 'ready' : 'pending', lastErrorCode: null,
          nextSyncAt: current.syncIntervalMinutes ? new Date(Date.now() + current.syncIntervalMinutes * 60_000) : null, updatedAt: new Date() }).where(eq(sources.id, id));
        await tx.update(jobs).set({ state: 'cancelled', errorCode: 'BROWSER_SESSION_CHANGED', finishedAt: new Date() })
          .where(and(eq(jobs.owner, owner), eq(jobs.sourceId, id), eq(jobs.state, 'running')));
      });
    } finally { await this.cancel(owner, id); }
    return this.status(owner, id);
  }
  async clear(owner: string, id: string): Promise<DataBrowserStatus> {
    const row = await this.row(owner, id);
    if (row.kind !== 'website' || row.captureMode !== 'browser') throw new BadRequestException('BROWSER_SOURCE_REQUIRED');
    await this.db.transaction(async tx => {
      const [current] = await tx.select().from(sources).where(and(eq(sources.owner, owner), eq(sources.id, id), isNull(sources.deletedAt))).for('update');
      if (!current) throw new NotFoundException('DATA_SOURCE_NOT_FOUND');
      if (current.kind !== 'website' || current.captureMode !== 'browser') throw new BadRequestException('BROWSER_SOURCE_REQUIRED');
      await tx.update(sources).set({ browserStateEnc: null, browserConnectedAt: null, leaseUntil: null, leaseToken: null, activeJobId: null,
        revision: current.revision + 1, nextSyncAt: null, state: 'needs-auth', lastErrorCode: 'BROWSER_SESSION_DISCONNECTED', updatedAt: new Date() })
        .where(and(eq(sources.owner, owner), eq(sources.id, id), isNull(sources.deletedAt)));
      await tx.update(jobs).set({ state: 'cancelled', errorCode: 'BROWSER_SESSION_DISCONNECTED', finishedAt: new Date() })
        .where(and(eq(jobs.owner, owner), eq(jobs.sourceId, id), eq(jobs.state, 'running')));
    });
    await this.cancel(owner, id);
    return this.status(owner, id);
  }
  cancel(owner: string, id: string) { return this.runtime.close(this.key(owner, id)); }
  async read(owner: string, row: SourceRow, signal?: AbortSignal): Promise<BrowserCapture> {
    const storageState = decodeDataSecret(row.browserStateEnc);
    if (row.browserStateEnc && !storageState) throw new BrowserSourceError('NEEDS_AUTH');
    const { refreshedStorageState, ...result } = await this.runtime.read({
      key: this.key(owner, row.id), url: row.url!, storageState: storageState ?? undefined, signal,
    });
    // A provider can reflect session values in visible text. Strip those before archiving.
    const states: unknown[] = [];
    try {
      if (storageState) states.push(JSON.parse(storageState));
      if (refreshedStorageState) states.push(JSON.parse(refreshedStorageState));
    } catch { throw new BrowserSourceError('NEEDS_AUTH'); }
    const safe = (text: string) => states.reduce<string>((value, state) => redactBrowserSessionValues(value, state), text);
    return { ...result, text: safe(result.text), title: safe(result.title), url: safe(result.url), html: Buffer.alloc(0),
      // Anonymous reads never create a durable login. Manual confirmation owns connectedAt.
      ...(storageState && refreshedStorageState ? { refreshedStateEnc: encodeDataSecret(refreshedStorageState) } : {}),
    };
  }
}
