import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ConflictException, ForbiddenException, Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { asc, ne, sql } from 'drizzle-orm';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '../../common/platform';
import { users } from '../../database/schema';
import { researchArtifacts } from '../../database/research-artifacts.schema';
import { createUpdateBackup } from './backup';
import { parseLatestRelease } from './update-core';

type UpdatePhase = 'idle' | 'backingUp' | 'updating' | 'failed';

export interface WebUpdateStatus {
  enabled: boolean;
  currentVersion: string;
  available: { version: string; releaseUrl: string } | null;
  phase: UpdatePhase;
  error?: string;
}

const RELEASE_API = 'https://api.github.com/repos/Lueyu/squabble/releases/latest';
const APP_VERSION = (JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as { version: string }).version;

function dumpDatabase(destination: string, snapshot?: string): Promise<void> {
  const connection = process.env.DATABASE_URL;
  if (!connection) throw new Error('DATABASE_URL is required for the update backup');
  return new Promise((done, fail) => {
    const child = spawn('pg_dump', ['--format=custom', '--file', destination, '--dbname', connection, ...(snapshot ? ['--snapshot', snapshot] : [])], {
      stdio: 'ignore',
      env: { ...process.env, PGCONNECT_TIMEOUT: '10' },
    });
    const timeout = setTimeout(() => child.kill(), 120_000);
    child.once('error', (error) => { clearTimeout(timeout); fail(error); });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      if (code === 0) done();
      else fail(new Error(`pg_dump exited with code ${code}`));
    });
  });
}

@Injectable()
export class SystemUpdateService {
  private readonly logger = new Logger(SystemUpdateService.name);
  private phase: UpdatePhase = 'idle';
  private error: string | undefined;
  private releaseCache: { until: number; value: WebUpdateStatus['available'] } | null = null;

  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase) {}

  private get enabled(): boolean {
    // The legacy helper replaces one app image. A versioned tool bundle requires its full matched update procedure.
    return process.env.SQUABBLE_UPDATE_MODE === 'docker' && process.env.TOOL_CAPABILITIES_BUNDLE_ENABLED !== 'true';
  }

  private async requireOwner(userId: string): Promise<void> {
    const [owner] = await this.db.select({ id: users.id }).from(users)
      .orderBy(asc(users.createdAt), asc(users.id)).limit(1);
    if (!owner || owner.id !== userId) throw new ForbiddenException('Only the installation owner can update Squabble');
  }

  private async availableRelease(): Promise<WebUpdateStatus['available']> {
    if (this.releaseCache && Date.now() < this.releaseCache.until) return this.releaseCache.value;
    const response = await fetch(RELEASE_API, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': `Squabble/${APP_VERSION}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status}`);
    const value = parseLatestRelease(await response.json(), APP_VERSION);
    this.releaseCache = { until: Date.now() + 60_000, value };
    return value;
  }

  async status(userId: string): Promise<WebUpdateStatus> {
    if (!this.enabled) return { enabled: false, currentVersion: APP_VERSION, available: null, phase: 'idle' };
    await this.requireOwner(userId);
    try {
      return { enabled: true, currentVersion: APP_VERSION, available: await this.availableRelease(),
        phase: this.phase, ...(this.error ? { error: this.error } : {}) };
    } catch {
      return { enabled: true, currentVersion: APP_VERSION, available: null,
        phase: this.phase, error: this.error ?? 'Could not reach GitHub Releases' };
    }
  }

  async start(userId: string): Promise<{ started: true; backup: string }> {
    if (!this.enabled) throw new ForbiddenException('Web updates are unavailable in this deployment');
    await this.requireOwner(userId);
    if (this.phase === 'backingUp' || this.phase === 'updating') throw new ConflictException('An update is already running');
    const release = await this.availableRelease().catch(() => {
      throw new ServiceUnavailableException('Could not check GitHub Releases');
    });
    if (!release) throw new ConflictException('Squabble is already up to date');
    this.phase = 'backingUp';
    this.error = undefined;
    try {
      const backup = await this.db.transaction(async tx => {
        // The dump and file index share one PostgreSQL snapshot. Concurrent deletion may fail the copy,
        // which correctly prevents completion; it must never yield a backup with missing indexed files.
        await tx.execute(sql`set transaction isolation level repeatable read read only`);
        const exported = await tx.execute(sql`select pg_export_snapshot() as snapshot`);
        const snapshot = String(exported[0].snapshot);
        const artifacts = await tx.select({ storageRef: researchArtifacts.storageRef, sha256: researchArtifacts.sha256,
          sizeBytes: researchArtifacts.sizeBytes }).from(researchArtifacts).where(ne(researchArtifacts.status, 'deleted'));
        return createUpdateBackup(process.env.SQUABBLE_UPDATE_BACKUP_DIR ?? '/app/.backups', '/app/.secrets',
          destination => dumpDatabase(destination, snapshot),
          { artifactRoot: process.env.RESEARCH_ARTIFACT_ROOT ?? resolve('.data/research-artifacts'), artifacts,
            keys: { jwt: process.env.JWT_SECRET, settings: process.env.SETTINGS_ENCRYPTION_KEY } });
      });
      this.phase = 'updating';
      setTimeout(() => { void this.triggerHelper(); }, 500).unref();
      return { started: true, backup };
    } catch (error) {
      this.logger.error(`Update backup failed: ${error instanceof Error ? error.message : String(error)}`);
      this.phase = 'failed';
      this.error = 'Database backup failed; the update was not started';
      throw new ServiceUnavailableException(this.error);
    }
  }

  private async triggerHelper(): Promise<void> {
    try {
      const token = readFileSync('/app/.secrets/update-token', 'utf8').trim();
      const response = await fetch('http://updater:8080/v1/update', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10 * 60_000),
      });
      if (!response.ok) throw new Error(`Update helper returned HTTP ${response.status}`);
      // If this process survives the scan, no replacement happened.
      this.phase = 'failed';
      this.error = 'No new image was installed; see the updater container logs';
    } catch (error) {
      this.logger.error(`Update helper failed: ${error instanceof Error ? error.message : String(error)}`);
      this.phase = 'failed';
      this.error = 'Update failed; see the updater container logs';
    }
  }
}
